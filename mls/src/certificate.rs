//! Device certificates (MLS credential identity).
//!
//! Each device's MLS credential identity is a certificate, serialized as JSON, binding the device's
//! MLS signature key to the account that owns it.
//!
//! - **v1** (wallet-signed): the wallet signs (personal message)
//!   `myso-mls-device-v1:{wallet}:{device_id}:{mls_key_hex}:{issued_at_ms}`. Verified by the
//!   platform (ed25519 locally, zkLogin via a fullnode). A zkLogin v1 certificate can't be checked
//!   once its proof is past `max_epoch`, which is why v2 exists.
//! - **v2** (authority-signed, renewable): the device's long-lived *authority key* (ed25519),
//!   registered on-chain in `messaging::mls_device_registry` by the account, signs
//!   `myso-mls-device-v2:{wallet}:{device_id}:{mls_key_hex}:{issued_at_ms}:{authority_key_hex}`.
//!   The device renews it on its own (no account signature, no new zkLogin proof). Valid iff the
//!   signature verifies (this crate) and the registry says the authority key is current (or the
//!   previous one inside its rotation grace) and the device isn't revoked (platform, on-chain read).
//!
//! This crate checks structure, the v2 signature, and that the certificate names the leaf's key.

use openmls::prelude::{OpenMlsCrypto, OpenMlsProvider, SignatureScheme};
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde::{Deserialize, Serialize};

pub const CERTIFICATE_VERSION: u8 = 1;
pub const CERTIFICATE_VERSION_V2: u8 = 2;
/// `signer_key` of a v2 certificate (the signer is `authority_key`).
pub const AUTHORITY_SIGNER: &str = "authority";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceCertificate {
    pub v: u8,
    /// Lowercase 0x account address that owns the device (zkLogin: the zkLogin address).
    pub wallet: String,
    pub device_id: String,
    /// Hex of the device's MLS (Ed25519) signature public key.
    pub mls_key: String,
    pub issued_at_ms: i64,
    /// v1: wallet signature (request-auth hex). v2: hex ed25519 signature by `authority_key`.
    pub sig: String,
    /// v1: flagged hex (`00…` ed25519) or `05` (zkLogin). v2: [`AUTHORITY_SIGNER`].
    pub signer_key: String,
    /// v2 only: hex ed25519 authority public key (registered on-chain).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authority_key: Option<String>,
}

fn norm_hex(h: &str) -> String {
    h.trim().trim_start_matches("0x").to_ascii_lowercase()
}

impl DeviceCertificate {
    /// The bytes a v1 certificate's wallet signs. Must match TS / Swift / relayer byte-for-byte.
    pub fn canonical(wallet: &str, device_id: &str, mls_key_hex: &str, issued_at_ms: i64) -> String {
        format!(
            "myso-mls-device-v1:{}:{}:{}:{}",
            wallet.trim().to_ascii_lowercase(),
            device_id.trim(),
            norm_hex(mls_key_hex),
            issued_at_ms
        )
    }

    /// The bytes a v2 certificate's authority key signs.
    pub fn canonical_v2(
        wallet: &str,
        device_id: &str,
        mls_key_hex: &str,
        issued_at_ms: i64,
        authority_key_hex: &str,
    ) -> String {
        format!(
            "myso-mls-device-v2:{}:{}:{}:{}:{}",
            wallet.trim().to_ascii_lowercase(),
            device_id.trim(),
            norm_hex(mls_key_hex),
            issued_at_ms,
            norm_hex(authority_key_hex)
        )
    }

    pub fn signed_canonical(&self) -> String {
        match (self.v, &self.authority_key) {
            (CERTIFICATE_VERSION_V2, Some(a)) => {
                Self::canonical_v2(&self.wallet, &self.device_id, &self.mls_key, self.issued_at_ms, a)
            }
            _ => Self::canonical(&self.wallet, &self.device_id, &self.mls_key, self.issued_at_ms),
        }
    }

    /// Issue a v2 certificate: the device's authority key signs its MLS key.
    pub fn issue_v2(
        authority: &crate::DeviceKeys,
        wallet: &str,
        device_id: &str,
        mls_key_hex: &str,
        issued_at_ms: i64,
    ) -> crate::Result<Self> {
        let authority_key = hex::encode(authority.public_key());
        let canonical = Self::canonical_v2(wallet, device_id, mls_key_hex, issued_at_ms, &authority_key);
        Ok(Self {
            v: CERTIFICATE_VERSION_V2,
            wallet: wallet.trim().to_ascii_lowercase(),
            device_id: device_id.trim().to_string(),
            mls_key: norm_hex(mls_key_hex),
            issued_at_ms,
            sig: hex::encode(authority.sign(canonical.as_bytes())?),
            signer_key: AUTHORITY_SIGNER.into(),
            authority_key: Some(authority_key),
        })
    }

    /// v2: the authority signature verifies. (Whether the authority key is current / not revoked
    /// is an on-chain question the platform answers.) `false` for v1.
    pub fn verify_authority_signature(&self) -> bool {
        let (CERTIFICATE_VERSION_V2, Some(authority)) = (self.v, &self.authority_key) else {
            return false;
        };
        if self.signer_key != AUTHORITY_SIGNER {
            return false;
        }
        let (Ok(key), Ok(sig)) = (hex::decode(norm_hex(authority)), hex::decode(norm_hex(&self.sig))) else {
            return false;
        };
        if key.len() != 32 || sig.len() != 64 {
            return false;
        }
        OpenMlsRustCrypto::default()
            .crypto()
            .verify_signature(SignatureScheme::ED25519, self.signed_canonical().as_bytes(), &key, &sig)
            .is_ok()
    }

    pub fn to_identity(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("certificate serializes")
    }

    pub fn from_identity(identity: &[u8]) -> Option<Self> {
        let cert: Self = serde_json::from_slice(identity).ok()?;
        let shape_ok = match cert.v {
            CERTIFICATE_VERSION => cert.authority_key.is_none(),
            CERTIFICATE_VERSION_V2 => cert.authority_key.is_some(),
            _ => false,
        };
        (shape_ok && !cert.wallet.is_empty() && !cert.device_id.is_empty()).then_some(cert)
    }

    /// Structural check: the certificate names `signature_key` as its MLS key.
    pub fn names_key(&self, signature_key: &[u8]) -> bool {
        hex::decode(self.mls_key.trim_start_matches("0x")).ok().as_deref() == Some(signature_key)
    }
}
