//! zkLogin sender authentication for relayer requests.
//!
//! A zkLogin account has no key whose address is the account address, so clients send the full
//! serialized zkLogin signature (flag `0x05`) with `public_key` set to just `05`.
//!
//! Verification, in order:
//! 1. Parse the signature; it must be a zkLogin authenticator.
//! 2. The claimed `sender_address` must be an address the proof's public identifier derives.
//! 3. The ephemeral signature inside must verify over this exact message (local, every request).
//! 4. The proof itself is verified in-process, as validators do: MySo's Groth16 key (exported from
//!    the MySo prover's zkey), the issuer's published JWK, and `max_epoch` within the current
//!    epoch window. A success is cached for 10 minutes per (address, proof inputs, max epoch,
//!    ephemeral key), so later requests only repeat 1-3.
//!
//! Anything that fails, including the JWKS or fullnode being unreachable, is rejected (fail closed).

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use blake2::{digest::consts::U32, Blake2b, Digest};
use myso_crypto::{MySoVerifier, UserSignatureVerifier};
use myso_crypto::zklogin::ZkloginVerifier;
use myso_sdk_types::{
    Jwk, JwkId, PersonalMessage, SimpleSignature, UserSignature, ZkLoginAuthenticator,
};

use super::schemes::SignatureScheme;
use super::types::AuthError;

/// `public_key` / scheme flag clients send for a zkLogin-signed request.
pub const ZKLOGIN_FLAG: u8 = 0x05;

/// How long a chain-verified proof authorizes its ephemeral key without asking again.
pub const AUTHORIZATION_TTL: Duration = Duration::from_secs(600);

/// Upper bound on cached authorizations; expired entries are dropped first.
const MAX_CACHED_AUTHORIZATIONS: usize = 10_000;

/// The ephemeral key a verified zkLogin request was signed with. The relayer checks per-message
/// signatures against it, exactly like a plain key sender's key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZkLoginSender {
    pub scheme: SignatureScheme,
    pub ephemeral_public_key: Vec<u8>,
}

/// The proof check: in production `LocalZkLoginCheck`, a stub in tests.
#[async_trait]
pub trait ZkLoginProofCheck: Send + Sync {
    /// `Ok` only when `signature` is a valid zkLogin signature over the personal message
    /// `message` for `author`, under the same rules validators apply.
    async fn verify(&self, message: &[u8], signature: &[u8], author: &str)
        -> Result<(), AuthError>;
}

/// OIDC providers whose keys the relayer accepts (the ones the MySo prover serves).
/// `(issuer, JWKS URL)`; each issuer also matches without its `https://` prefix.
const JWK_PROVIDERS: &[(&str, &str)] = &[
    (
        "https://accounts.google.com",
        "https://www.googleapis.com/oauth2/v3/certs",
    ),
    ("https://appleid.apple.com", "https://appleid.apple.com/auth/keys"),
];

/// A key id the cache doesn't know triggers at most one JWKS fetch per issuer this often.
const JWK_REFETCH_INTERVAL: Duration = Duration::from_secs(60);

/// Current epoch is re-read from the fullnode at most this often.
const EPOCH_TTL: Duration = Duration::from_secs(30);

/// Validators reject a proof whose `max_epoch` is more than this many epochs ahead
/// (protocol config `zklogin_max_epoch_upper_bound_delta`).
const MAX_EPOCH_UPPER_BOUND_DELTA: u64 = 30;

/// Where the current epoch comes from. The fullnode's gRPC in production.
#[async_trait]
pub trait EpochSource: Send + Sync {
    async fn current_epoch(&self) -> Result<u64, String>;
}

/// `LedgerService.GetServiceInfo` on the fullnode (`MYSO_RPC_URL`).
pub struct GrpcEpochSource {
    url: String,
}

impl GrpcEpochSource {
    pub fn new(url: impl Into<String>) -> Self {
        Self { url: url.into() }
    }
}

#[async_trait]
impl EpochSource for GrpcEpochSource {
    async fn current_epoch(&self) -> Result<u64, String> {
        use myso_rpc::proto::myso::rpc::v2::{
            ledger_service_client::LedgerServiceClient, GetServiceInfoRequest,
        };
        let mut client = LedgerServiceClient::connect(self.url.clone())
            .await
            .map_err(|e| e.to_string())?;
        let info = client
            .get_service_info(GetServiceInfoRequest::default())
            .await
            .map_err(|e| e.to_string())?
            .into_inner();
        info.epoch.ok_or_else(|| "service info has no epoch".to_string())
    }
}

/// Where an issuer's signing keys come from. The provider's JWKS endpoint in production.
#[async_trait]
pub trait JwkSource: Send + Sync {
    /// Every key the issuer currently publishes.
    async fn fetch(&self, iss: &str) -> Result<Vec<(String, Jwk)>, String>;
}

/// Fetches the allow-listed providers' published JWKS.
pub struct HttpJwkSource {
    client: reqwest::Client,
}

impl HttpJwkSource {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default();
        Self { client }
    }
}

impl Default for HttpJwkSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl JwkSource for HttpJwkSource {
    async fn fetch(&self, iss: &str) -> Result<Vec<(String, Jwk)>, String> {
        let url = provider_jwks_url(iss).ok_or_else(|| format!("unsupported issuer {iss}"))?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("JWKS HTTP {}", response.status()));
        }
        let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
        Ok(parse_jwks(&json))
    }
}

fn provider_jwks_url(iss: &str) -> Option<&'static str> {
    JWK_PROVIDERS.iter().find_map(|(issuer, url)| {
        let bare = issuer.trim_start_matches("https://");
        (iss == *issuer || iss == bare).then_some(*url)
    })
}

/// RSA keys from a JWKS document, as `(kid, key)`.
fn parse_jwks(json: &serde_json::Value) -> Vec<(String, Jwk)> {
    let Some(keys) = json.get("keys").and_then(|k| k.as_array()) else {
        return Vec::new();
    };
    keys.iter()
        .filter_map(|key| {
            let field = |name: &str| key.get(name).and_then(|v| v.as_str()).map(str::to_string);
            if field("kty")? != "RSA" {
                return None;
            }
            Some((
                field("kid")?,
                Jwk {
                    kty: "RSA".to_string(),
                    e: field("e")?,
                    n: field("n")?,
                    alg: field("alg").unwrap_or_else(|| "RS256".to_string()),
                },
            ))
        })
        .collect()
}

/// Verifies zkLogin proofs in-process with MySo's Groth16 key (the one validators and the MySo
/// prover use), the issuer's published JWKs, and the fullnode's current epoch. No remote verifier.
pub struct LocalZkLoginCheck {
    verifier: RwLock<ZkloginVerifier>,
    jwks: Arc<dyn JwkSource>,
    epochs: Arc<dyn EpochSource>,
    last_fetch: Mutex<HashMap<String, Instant>>,
    epoch: Mutex<Option<(u64, Instant)>>,
}

impl LocalZkLoginCheck {
    pub fn new(jwks: Arc<dyn JwkSource>, epochs: Arc<dyn EpochSource>) -> Self {
        Self {
            verifier: RwLock::new(ZkloginVerifier::new_myso()),
            jwks,
            epochs,
            last_fetch: Mutex::new(HashMap::new()),
            epoch: Mutex::new(None),
        }
    }

    async fn current_epoch(&self) -> Result<u64, AuthError> {
        if let Some((epoch, at)) = *self.epoch.lock().unwrap_or_else(|e| e.into_inner()) {
            if at.elapsed() < EPOCH_TTL {
                return Ok(epoch);
            }
        }
        let epoch = self
            .epochs
            .current_epoch()
            .await
            .map_err(|e| unavailable(&format!("current epoch: {e}")))?;
        *self.epoch.lock().unwrap_or_else(|e| e.into_inner()) = Some((epoch, Instant::now()));
        Ok(epoch)
    }

    fn has_jwk(&self, id: &JwkId) -> bool {
        self.verifier
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .jwks()
            .contains_key(id)
    }

    /// Loads `id`'s key if the cache lacks it, fetching its issuer at most once a minute.
    async fn ensure_jwk(&self, id: &JwkId) -> Result<(), AuthError> {
        if self.has_jwk(id) {
            return Ok(());
        }
        if provider_jwks_url(&id.iss).is_none() {
            return Err(AuthError::SignatureVerificationFailed(format!(
                "zkLogin issuer not supported: {}",
                id.iss
            )));
        }
        let may_fetch = {
            let mut last = self.last_fetch.lock().unwrap_or_else(|e| e.into_inner());
            let due = last
                .get(&id.iss)
                .is_none_or(|at| at.elapsed() >= JWK_REFETCH_INTERVAL);
            if due {
                last.insert(id.iss.clone(), Instant::now());
            }
            due
        };
        if may_fetch {
            let keys = self
                .jwks
                .fetch(&id.iss)
                .await
                .map_err(|e| unavailable(&format!("JWKS for {}: {e}", id.iss)))?;
            let mut verifier = self.verifier.write().unwrap_or_else(|e| e.into_inner());
            for (kid, jwk) in keys {
                verifier.jwks_mut().insert(
                    JwkId {
                        iss: id.iss.clone(),
                        kid,
                    },
                    jwk,
                );
            }
        }
        if self.has_jwk(id) {
            Ok(())
        } else {
            Err(AuthError::SignatureVerificationFailed(format!(
                "zkLogin key {} is not published by {}",
                id.kid, id.iss
            )))
        }
    }
}

#[async_trait]
impl ZkLoginProofCheck for LocalZkLoginCheck {
    async fn verify(
        &self,
        message: &[u8],
        signature: &[u8],
        _author: &str,
    ) -> Result<(), AuthError> {
        let parsed = UserSignature::from_bytes(signature).map_err(|e| {
            AuthError::InvalidSignatureFormat(format!("Failed to parse zkLogin signature: {e}"))
        })?;
        let UserSignature::ZkLogin(zklogin) = &parsed else {
            return Err(AuthError::InvalidSignatureFormat(
                "Expected a zkLogin signature".to_string(),
            ));
        };

        check_epoch_window(zklogin.max_epoch, self.current_epoch().await?)?;

        self.ensure_jwk(zklogin.inputs.jwk_id()).await?;

        let verifier = self.verifier.read().unwrap_or_else(|e| e.into_inner());
        verifier
            .verify_personal_message(&PersonalMessage(Cow::Borrowed(message)), &parsed)
            .map_err(|e| {
                AuthError::SignatureVerificationFailed(format!("zkLogin proof rejected: {e}"))
            })
    }
}

/// Validators' epoch rule: the proof is live through `max_epoch`, which may be at most
/// `MAX_EPOCH_UPPER_BOUND_DELTA` epochs ahead.
fn check_epoch_window(max_epoch: u64, current: u64) -> Result<(), AuthError> {
    if current > max_epoch {
        return Err(AuthError::SignatureVerificationFailed(format!(
            "zkLogin proof expired: max epoch {max_epoch} is before current epoch {current}"
        )));
    }
    if max_epoch - current > MAX_EPOCH_UPPER_BOUND_DELTA {
        return Err(AuthError::SignatureVerificationFailed(format!(
            "zkLogin max epoch {max_epoch} is too far past current epoch {current}"
        )));
    }
    Ok(())
}

fn unavailable(detail: &str) -> AuthError {
    tracing::warn!(detail, "zkLogin verification unavailable");
    AuthError::SignatureVerificationFailed("zkLogin verification unavailable".to_string())
}

/// Verifies zkLogin-signed requests and caches chain-verified proofs.
pub struct ZkLoginVerifier {
    check: Option<Arc<dyn ZkLoginProofCheck>>,
    authorized: Mutex<HashMap<[u8; 32], Instant>>,
    ttl: Duration,
}

impl ZkLoginVerifier {
    /// Enabled when `MYSO_RPC_URL` (the fullnode gRPC, for the current epoch) is set;
    /// otherwise every zkLogin request is rejected.
    pub fn from_env() -> Self {
        match std::env::var("MYSO_RPC_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            Some(url) => Self::with_check(Arc::new(LocalZkLoginCheck::new(
                Arc::new(HttpJwkSource::new()),
                Arc::new(GrpcEpochSource::new(url)),
            ))),
            None => {
                tracing::info!("MYSO_RPC_URL not set: zkLogin request auth disabled");
                Self::disabled()
            }
        }
    }

    pub fn disabled() -> Self {
        Self {
            check: None,
            authorized: Mutex::new(HashMap::new()),
            ttl: AUTHORIZATION_TTL,
        }
    }

    pub fn with_check(check: Arc<dyn ZkLoginProofCheck>) -> Self {
        Self::with_check_and_ttl(check, AUTHORIZATION_TTL)
    }

    pub fn with_check_and_ttl(check: Arc<dyn ZkLoginProofCheck>, ttl: Duration) -> Self {
        Self {
            check: Some(check),
            authorized: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    /// Authenticates `claimed_sender` for `message` signed by the serialized zkLogin `signature`.
    pub async fn verify(
        &self,
        message: &[u8],
        signature: &[u8],
        claimed_sender: &str,
    ) -> Result<ZkLoginSender, AuthError> {
        let check = self.check.as_ref().ok_or_else(|| {
            AuthError::SignatureVerificationFailed(
                "zkLogin request auth is not enabled".to_string(),
            )
        })?;

        let parsed = UserSignature::from_bytes(signature).map_err(|e| {
            AuthError::InvalidSignatureFormat(format!("Failed to parse zkLogin signature: {e}"))
        })?;
        let UserSignature::ZkLogin(zklogin) = &parsed else {
            return Err(AuthError::InvalidSignatureFormat(
                "Expected a zkLogin signature".to_string(),
            ));
        };

        let sender = claimed_sender.trim().to_ascii_lowercase();
        let derived: Vec<String> = zklogin
            .derive_address()
            .map(|address| address.to_string())
            .collect();
        if !derived
            .iter()
            .any(|address| address.eq_ignore_ascii_case(&sender))
        {
            return Err(AuthError::AddressMismatch {
                expected: derived.first().cloned().unwrap_or_default(),
                got: sender,
            });
        }

        // The ephemeral signature over this exact message, every request.
        let inner = UserSignature::Simple(zklogin.signature.clone());
        UserSignatureVerifier::default()
            .verify_personal_message(&PersonalMessage(Cow::Borrowed(message)), &inner)
            .map_err(|e| AuthError::SignatureVerificationFailed(e.to_string()))?;

        let ephemeral = ephemeral_key(&zklogin.signature)?;
        let key = authorization_key(&sender, zklogin, &ephemeral)?;
        if !self.is_authorized(&key) {
            check.verify(message, signature, &sender).await?;
            self.remember(key);
        }

        Ok(ephemeral)
    }

    fn is_authorized(&self, key: &[u8; 32]) -> bool {
        let map = self.authorized.lock().unwrap_or_else(|e| e.into_inner());
        map.get(key)
            .is_some_and(|expires| Instant::now() < *expires)
    }

    fn remember(&self, key: [u8; 32]) {
        let now = Instant::now();
        let mut map = self.authorized.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_CACHED_AUTHORIZATIONS {
            map.retain(|_, expires| now < *expires);
            if map.len() >= MAX_CACHED_AUTHORIZATIONS {
                map.clear();
            }
        }
        map.insert(key, now + self.ttl);
    }

    #[cfg(test)]
    fn cached_count(&self) -> usize {
        self.authorized.lock().unwrap().len()
    }
}

fn ephemeral_key(signature: &SimpleSignature) -> Result<ZkLoginSender, AuthError> {
    let (scheme, key) = match signature {
        SimpleSignature::Ed25519 { public_key, .. } => {
            (SignatureScheme::Ed25519, public_key.as_bytes().to_vec())
        }
        SimpleSignature::Secp256k1 { public_key, .. } => {
            (SignatureScheme::Secp256k1, public_key.as_bytes().to_vec())
        }
        SimpleSignature::Secp256r1 { public_key, .. } => {
            (SignatureScheme::Secp256r1, public_key.as_bytes().to_vec())
        }
        _ => {
            return Err(AuthError::InvalidSignatureFormat(
                "Unsupported zkLogin ephemeral key scheme".to_string(),
            ))
        }
    };
    Ok(ZkLoginSender {
        scheme,
        ephemeral_public_key: key,
    })
}

/// What the proof attests: address, proof inputs, max epoch and the ephemeral key it binds.
/// The per-request ephemeral signature is deliberately not part of it.
fn authorization_key(
    sender: &str,
    zklogin: &ZkLoginAuthenticator,
    ephemeral: &ZkLoginSender,
) -> Result<[u8; 32], AuthError> {
    let inputs = bcs::to_bytes(&zklogin.inputs).map_err(|e| {
        AuthError::InvalidSignatureFormat(format!("Failed to encode zkLogin inputs: {e}"))
    })?;
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(sender.as_bytes());
    hasher.update(zklogin.max_epoch.to_le_bytes());
    hasher.update([ephemeral.scheme.flag()]);
    hasher.update(&ephemeral.ephemeral_public_key);
    hasher.update(&inputs);
    Ok(hasher.finalize().into())
}

/// Process-wide verifier, configured from `MYSO_RPC_URL` on first use.
pub fn shared() -> &'static ZkLoginVerifier {
    static VERIFIER: std::sync::OnceLock<ZkLoginVerifier> = std::sync::OnceLock::new();
    VERIFIER.get_or_init(ZkLoginVerifier::from_env)
}

/// Whether a request's `public_key` field marks a zkLogin signature (`05`, flag only).
pub fn is_zklogin_public_key(public_key_with_flag: &[u8]) -> bool {
    public_key_with_flag.first() == Some(&ZKLOGIN_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Counts remote checks; succeeds unless told to fail.
    struct StubCheck {
        calls: AtomicUsize,
        accept: bool,
    }

    #[async_trait]
    impl ZkLoginProofCheck for StubCheck {
        async fn verify(&self, _m: &[u8], _s: &[u8], _a: &str) -> Result<(), AuthError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.accept {
                Ok(())
            } else {
                Err(AuthError::SignatureVerificationFailed(
                    "rejected".to_string(),
                ))
            }
        }
    }

    #[tokio::test]
    async fn disabled_verifier_rejects() {
        let verifier = ZkLoginVerifier::disabled();
        let err = verifier
            .verify(b"m", &[ZKLOGIN_FLAG], "0x1")
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::SignatureVerificationFailed(_)));
    }

    #[tokio::test]
    async fn non_zklogin_bytes_are_rejected_before_any_remote_call() {
        let stub = Arc::new(StubCheck {
            calls: AtomicUsize::new(0),
            accept: true,
        });
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        // A plain ed25519 serialized signature (flag 0x00) is not a zkLogin signature.
        let mut plain = vec![0x00];
        plain.extend_from_slice(&[7u8; 64]);
        plain.extend_from_slice(&[9u8; 32]);
        let err = verifier.verify(b"m", &plain, "0x1").await.unwrap_err();
        assert!(matches!(err, AuthError::InvalidSignatureFormat(_)));
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
        assert_eq!(verifier.cached_count(), 0);
    }

    #[tokio::test]
    async fn garbage_is_rejected() {
        let stub = Arc::new(StubCheck {
            calls: AtomicUsize::new(0),
            accept: true,
        });
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        let err = verifier
            .verify(b"m", &[ZKLOGIN_FLAG, 1, 2, 3], "0x1")
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::InvalidSignatureFormat(_)));
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn cache_entries_expire() {
        let stub = Arc::new(StubCheck {
            calls: AtomicUsize::new(0),
            accept: true,
        });
        let verifier = ZkLoginVerifier::with_check_and_ttl(stub, Duration::from_millis(0));
        let key = [1u8; 32];
        verifier.remember(key);
        assert!(!verifier.is_authorized(&key));

        let stub = Arc::new(StubCheck {
            calls: AtomicUsize::new(0),
            accept: true,
        });
        let verifier = ZkLoginVerifier::with_check(stub);
        verifier.remember(key);
        assert!(verifier.is_authorized(&key));
        assert!(!verifier.is_authorized(&[2u8; 32]));
    }

    /// Real serialized zkLogin signature (MySoKit test fixture, maxEpoch 174).
    const FIXTURE_B64: &str = "BQNNMTE3MDE4NjY4MTI3MDQ1MTcyMTM5MTQ2MTI3OTg2NzQ3NDg2NTc3NTU1NjY1ODY1OTc0MzQ4MTA5NDEyNDA0ODMzNDY3NjkzNjkyNjdNMTQxMjA0Mzg5OTgwNjM2OTIyOTczODYyNDk3NTQyMzA5NzI3MTUxNTM4NzY1Mzc1MzAxNjg4ODM5ODE1MTM1ODQ1ODYxNzIxOTU4NDEBMQMCTDE4Njc0NTQ1MDE2MDI1ODM4NDg4NTI3ODc3ODI3NjE5OTY1NjAxNzAxMTgyNDkyOTk1MDcwMTQ5OTkyMzA4ODY4NTI1NTY5OTgyNzNNMTQ0NjY0MTk2OTg2NzkxMTYzMTM0NzUyMTA2NTQ1NjI5NDkxMjgzNDk1OTcxMDE3NjkyNTY5NTkwMTAwMDMxODg4ODYwOTEwODAzMTACTTExMDcyOTU0NTYyOTI0NTg4NDk2MTQ4NjMyNDc0MDc4NDMyNDA2NjMzMjg4OTQ4MjU2NzE4ODA5NzE0ODYxOTg2MTE5MzAzNTI5NzYwTTE5NzkwNTE2MDEwNzg0OTM1MTAwMTUwNjE0OTg5MDk3OTA4MjMzODk5NzE4NjQ1NTM2MTMwNzI3NzczNzEzNDA3NjExMTYxMzY4MDQ2AgExATADTTEwNDIzMjg5MDUxODUzMDMzOTE1MzgwODEwNTE2MTMwMjA1NzQ3MTgyODY3NTk2NDU3MTM5OTk5MTc2NzE0NDc2NDE1MTQ4Mzc2MzUwTTIxNzg1NzE5Njk1ODQ4MDEzOTA4MDYxNDkyOTg5NzY1Nzc3Nzg4MTQyMjU1ODk3OTg2MzAwMjQxNTYxMjgwMTk2NzQ1MTc0OTM0NDU3ATExeUpwYzNNaU9pSm9kSFJ3Y3pvdkwyRmpZMjkxYm5SekxtZHZiMmRzWlM1amIyMGlMQwFmZXlKaGJHY2lPaUpTVXpJMU5pSXNJbXRwWkNJNkltSTVZV00yTURGa01UTXhabVEwWm1aa05UVTJabVl3TXpKaFlXSXhPRGc0T0RCalpHVXpZamtpTENKMGVYQWlPaUpLVjFRaWZRTTEzMzIyODk3OTMwMTYzMjE4NTMyMjY2NDMwNDA5NTEwMzk0MzE2OTg1Mjc0NzY5MTI1NjY3MjkwNjAwMzIxNTY0MjU5NDY2NTExNzExrgAAAAAAAABhAEp+O5GEAF/5tKNDdWBObNf/1uIrbOJmE+xpnlBD2Vikqhbd0zLrQ2NJyquYXp4KrvWUOl7Hso+OK0eiV97ffwucM8VdtG2hjf/RUGNO5JNUH+D/gHtE9sHe6ZEnxwZL7g==";

    fn fixture() -> ZkLoginAuthenticator {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(FIXTURE_B64)
            .unwrap();
        match UserSignature::from_bytes(&bytes).unwrap() {
            UserSignature::ZkLogin(z) => *z,
            _ => panic!("fixture is not zkLogin"),
        }
    }

    /// The fixture's proof with a fresh ephemeral ed25519 signature over `message`.
    fn resigned(message: &[u8], seed: u8) -> (Vec<u8>, String, Vec<u8>) {
        use myso_crypto::{ed25519::Ed25519PrivateKey, MySoSigner};
        let key = Ed25519PrivateKey::new([seed; 32]);
        let signed = key
            .sign_personal_message(&PersonalMessage(Cow::Borrowed(message)))
            .unwrap();
        let UserSignature::Simple(simple) = signed else {
            panic!("expected simple signature")
        };
        let public_key = match &simple {
            SimpleSignature::Ed25519 { public_key, .. } => public_key.as_bytes().to_vec(),
            _ => unreachable!(),
        };
        let mut zk = fixture();
        zk.signature = simple;
        let address = zk.derive_address().next().unwrap().to_string();
        (
            UserSignature::ZkLogin(Box::new(zk)).to_bytes(),
            address,
            public_key,
        )
    }

    fn accepting() -> Arc<StubCheck> {
        Arc::new(StubCheck {
            calls: AtomicUsize::new(0),
            accept: true,
        })
    }

    #[tokio::test]
    async fn valid_request_returns_ephemeral_key_and_caches_proof() {
        let stub = accepting();
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        let (sig, address, ephemeral) = resigned(b"1700000000:sender", 3);

        let sender = verifier
            .verify(b"1700000000:sender", &sig, &address)
            .await
            .unwrap();
        assert_eq!(sender.scheme, SignatureScheme::Ed25519);
        assert_eq!(sender.ephemeral_public_key, ephemeral);
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);

        // Same proof + ephemeral key, new message: only the local checks run.
        let (sig2, _, _) = resigned(b"1700000001:sender", 3);
        verifier
            .verify(b"1700000001:sender", &sig2, &address)
            .await
            .unwrap();
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_different_ephemeral_key_is_checked_again() {
        let stub = accepting();
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        let (sig, address, _) = resigned(b"m1", 3);
        verifier.verify(b"m1", &sig, &address).await.unwrap();
        let (sig2, _, _) = resigned(b"m2", 4);
        verifier.verify(b"m2", &sig2, &address).await.unwrap();
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn wrong_sender_is_rejected_locally() {
        let stub = accepting();
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        let (sig, _, _) = resigned(b"m", 3);
        let other = format!("0x{}", "ab".repeat(32));
        let err = verifier.verify(b"m", &sig, &other).await.unwrap_err();
        assert!(matches!(err, AuthError::AddressMismatch { .. }));
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn signature_over_another_message_is_rejected_even_when_cached() {
        let stub = accepting();
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        let (sig, address, _) = resigned(b"signed message", 3);
        verifier
            .verify(b"signed message", &sig, &address)
            .await
            .unwrap();
        // Replaying the signature for a different request fails the local check.
        let err = verifier
            .verify(b"another message", &sig, &address)
            .await
            .unwrap_err();
        assert!(matches!(err, AuthError::SignatureVerificationFailed(_)));
    }

    #[tokio::test]
    async fn chain_rejection_is_not_cached() {
        let stub = Arc::new(StubCheck {
            calls: AtomicUsize::new(0),
            accept: false,
        });
        let verifier = ZkLoginVerifier::with_check(stub.clone());
        let (sig, address, _) = resigned(b"m", 3);
        assert!(verifier.verify(b"m", &sig, &address).await.is_err());
        assert!(verifier.verify(b"m", &sig, &address).await.is_err());
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
        assert_eq!(verifier.cached_count(), 0);
    }

    #[tokio::test]
    async fn expired_authorization_asks_the_chain_again() {
        let stub = accepting();
        let verifier = ZkLoginVerifier::with_check_and_ttl(stub.clone(), Duration::from_millis(0));
        let (sig, address, _) = resigned(b"m", 3);
        verifier.verify(b"m", &sig, &address).await.unwrap();
        verifier.verify(b"m", &sig, &address).await.unwrap();
        assert_eq!(stub.calls.load(Ordering::SeqCst), 2);
    }

    // MARK: - Local proof check

    /// A request the deployed relayer rejected: zkLogin `0x6b27…` (Google), signed by iOS.
    const REAL_ADDRESS: &str =
        "0x6b27c51107b378c9a1c6f1b471e43407d3027e8485464b0f7e9be8d196cbd8e0";
    const REAL_SIGNATURE_HEX: &str = "05034d32303830353033363235363531323036333136353735323430353532363235343930373036333234393831303536333033313534333536323638393233333734333831323635303230333232334d3135313236343938323235363532303636333332333033383234383539333034343939383136363334353535373734333038373336333930383538353636333938363138303537353438303734013103024c353830323537363737323938393637393639343036303036333133373331333038333732353439313134333735333132303230343135383939393130393539323834383439383138343336364d3130373138393235373339393233393932333132363432333236343534343133353735313233353636393337363234353230373432303334373434313830373433303734303531323139373830024d31383933363831363230383236303639333939343832313037363935323132333431323836343030333235333033313036343031323439373632373830393133333237383338383533363132344d32303032373530373332353636303432383031393535363139383232363234353136303930363533363630383436323532393337363538303136323938363230363839333834363735373434380201310130034c353332323233373230393539323539303434303835323736363438343433383635363730393735303037323639393332343733353931333338373136383032313833393839313239393337394d3133373731303134323639383136383033323632383337323834343335393839333938383135323935363730353136373931323030343236383139313739303337333838353731323337393337013131794a7063334d694f694a6f64485277637a6f764c32466a59323931626e527a4c6d6476623264735a53356a623230694c43016665794a68624763694f694a53557a49314e694973496d74705a434936496a6b304d32457a5954566b4e3251354d546b324d6a56684e4455305a5451344f5749334e574d794f57466b595749314e32466a596d45694c434a30655841694f694a4b5631516966514d31323033353135353835393434303739383133383638303433343034313432323530303535303130373631323930323439303033333339363035313031323939323931333030323931343937381300000000000000610026cf5058cbeb1c2a43a8e816402f30513c1ee9c6f6de92f709585ff9404c852c8b06b47fdfb92d2eda5c4cf96a8dfa04e364dcadc3bacdb0a6528ffe50e3e20391de655797f267e1973e23fc2ddd3cae716db16a27265faea7bab384224772d3";
    const GOOGLE_KID: &str = "943a3a5d7d919625a454e489b75c29adab57acba";
    const GOOGLE_N: &str = "pIpnzA2ezyEERJSxiqpLBmMeIqATH-V6iuBtKIibXEyYovujrx8niqTeO6RIyXT6uDUUv0V2kJ8V_iWYFxzXY1BqK9IfcAmjg0XUDoyTVkoyLsF0gj299LH-zw5vCvy8jmamFIZKAbKcQ5hpHvSittM1vl-6vVL-i2GxyGbMA9aY6Hq15NylS1t7ELTYfQimlnvxcb7_DM0cuS5U1SfbCZMCpKhh0nrSlYds240oxpCJOV2rBahs_Ea5c7tezS1nwVC9W_E-bR9TF6BHkC_fv-E8DcWfkI_6geaJzBhINNxBfjx-w1-WUp2Jz3YYFWEfeQjxMqu-Fg6cGxwk7V16uQ";

    fn real_message() -> Vec<u8> {
        format!("1793688229:{REAL_ADDRESS}").into_bytes()
    }

    fn real_signature() -> (Vec<u8>, u64) {
        let bytes = hex::decode(REAL_SIGNATURE_HEX).unwrap();
        let UserSignature::ZkLogin(zk) = UserSignature::from_bytes(&bytes).unwrap() else {
            panic!("not zkLogin")
        };
        (bytes, zk.max_epoch)
    }

    struct FixedEpoch(u64);

    #[async_trait]
    impl EpochSource for FixedEpoch {
        async fn current_epoch(&self) -> Result<u64, String> {
            Ok(self.0)
        }
    }

    struct StubJwks {
        keys: Vec<(String, Jwk)>,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl JwkSource for StubJwks {
        async fn fetch(&self, _iss: &str) -> Result<Vec<(String, Jwk)>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.keys.clone())
        }
    }

    fn google_jwks() -> Arc<StubJwks> {
        Arc::new(StubJwks {
            keys: vec![(
                GOOGLE_KID.to_string(),
                Jwk {
                    kty: "RSA".into(),
                    e: "AQAB".into(),
                    n: GOOGLE_N.into(),
                    alg: "RS256".into(),
                },
            )],
            calls: AtomicUsize::new(0),
        })
    }

    #[tokio::test]
    async fn real_myso_proof_verifies_locally() {
        let (sig, max_epoch) = real_signature();
        let jwks = google_jwks();
        let check = LocalZkLoginCheck::new(jwks.clone(), Arc::new(FixedEpoch(max_epoch)));
        check.verify(&real_message(), &sig, REAL_ADDRESS).await.unwrap();
        // The key is cached; a second request doesn't refetch.
        check.verify(&real_message(), &sig, REAL_ADDRESS).await.unwrap();
        assert_eq!(jwks.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn real_request_passes_the_full_verifier() {
        let (sig, max_epoch) = real_signature();
        let check = LocalZkLoginCheck::new(google_jwks(), Arc::new(FixedEpoch(max_epoch)));
        let verifier = ZkLoginVerifier::with_check(Arc::new(check));
        let sender = verifier.verify(&real_message(), &sig, REAL_ADDRESS).await.unwrap();
        assert_eq!(sender.scheme, SignatureScheme::Ed25519);
    }

    #[tokio::test]
    async fn tampered_message_is_rejected() {
        let (sig, max_epoch) = real_signature();
        let check = LocalZkLoginCheck::new(google_jwks(), Arc::new(FixedEpoch(max_epoch)));
        let err = check.verify(b"1793688230:other", &sig, REAL_ADDRESS).await.unwrap_err();
        assert!(matches!(err, AuthError::SignatureVerificationFailed(_)));
    }

    #[tokio::test]
    async fn expired_proof_is_rejected() {
        let (sig, max_epoch) = real_signature();
        let check = LocalZkLoginCheck::new(google_jwks(), Arc::new(FixedEpoch(max_epoch + 1)));
        let err = check.verify(&real_message(), &sig, REAL_ADDRESS).await.unwrap_err();
        assert!(format!("{err:?}").contains("expired"));
    }

    #[test]
    fn epoch_window_matches_validators() {
        assert!(check_epoch_window(10, 10).is_ok());
        assert!(check_epoch_window(10 + MAX_EPOCH_UPPER_BOUND_DELTA, 10).is_ok());
        assert!(check_epoch_window(11 + MAX_EPOCH_UPPER_BOUND_DELTA, 10).is_err());
        assert!(check_epoch_window(9, 10).is_err());
    }

    #[tokio::test]
    async fn unpublished_key_is_rejected_and_refetch_is_rate_limited() {
        let (sig, max_epoch) = real_signature();
        let jwks = Arc::new(StubJwks {
            keys: vec![],
            calls: AtomicUsize::new(0),
        });
        let check = LocalZkLoginCheck::new(jwks.clone(), Arc::new(FixedEpoch(max_epoch)));
        assert!(check.verify(&real_message(), &sig, REAL_ADDRESS).await.is_err());
        assert!(check.verify(&real_message(), &sig, REAL_ADDRESS).await.is_err());
        assert_eq!(jwks.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn only_allow_listed_issuers_have_jwks() {
        assert!(provider_jwks_url("https://accounts.google.com").is_some());
        assert!(provider_jwks_url("accounts.google.com").is_some());
        assert!(provider_jwks_url("https://appleid.apple.com").is_some());
        assert!(provider_jwks_url("https://evil.example").is_none());
    }

    #[test]
    fn jwks_parsing_keeps_rsa_keys() {
        let json = serde_json::json!({"keys": [
            {"kid": "a", "kty": "RSA", "e": "AQAB", "n": "xyz", "alg": "RS256"},
            {"kid": "b", "kty": "EC", "crv": "P-256"},
        ]});
        let keys = parse_jwks(&json);
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].0, "a");
    }

    #[test]
    fn zklogin_flag_detection() {
        assert!(is_zklogin_public_key(&[0x05]));
        assert!(!is_zklogin_public_key(&[0x00, 1, 2]));
        assert!(!is_zklogin_public_key(&[]));
    }
}

