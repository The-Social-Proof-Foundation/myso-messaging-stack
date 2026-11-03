//! Shared "who signed this request" step for REST and WebSocket auth.
//!
//! Plain keys (ed25519 / secp256k1 / secp256r1) keep their exact existing checks: the signature
//! must verify and the key must derive `sender_address`. A `public_key` of just `05` marks a
//! zkLogin request, verified by [`super::zklogin`].

use super::schemes::SignatureScheme;
use super::signature::{verify_address_matches_pubkey, verify_signature};
use super::types::AuthError;
use super::zklogin::{self, ZKLOGIN_FLAG};

/// The decoded `public_key` request field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestKey {
    /// Flagged public key whose address must equal the sender.
    Key {
        scheme: SignatureScheme,
        public_key: Vec<u8>,
    },
    /// `05`: the signature field carries a full serialized zkLogin signature.
    ZkLogin,
}

/// A request sender whose signature checked out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSender {
    /// Key per-message signatures are checked against (zkLogin: the proof's ephemeral key).
    pub scheme: SignatureScheme,
    pub public_key: Vec<u8>,
    pub zklogin: bool,
}

/// Parses the flagged `public_key` bytes. Errors match the previous inline checks.
pub fn parse_request_key(public_key_with_flag: &[u8]) -> Result<RequestKey, AuthError> {
    let Some(&flag) = public_key_with_flag.first() else {
        return Err(AuthError::InvalidPublicKeyFormat(
            "Empty public key".to_string(),
        ));
    };
    if flag == ZKLOGIN_FLAG {
        if public_key_with_flag.len() != 1 {
            return Err(AuthError::InvalidPublicKeyFormat(
                "zkLogin public_key must be the flag byte 05 only".to_string(),
            ));
        }
        return Ok(RequestKey::ZkLogin);
    }
    let scheme = SignatureScheme::from_flag(flag).ok_or_else(|| {
        AuthError::InvalidPublicKeyFormat(format!("Unknown signature scheme flag: 0x{flag:02x}"))
    })?;
    let public_key = &public_key_with_flag[1..];
    if public_key.len() != scheme.public_key_length() {
        return Err(AuthError::InvalidPublicKeyFormat(format!(
            "Expected {} bytes for {}, got {}",
            scheme.public_key_length(),
            scheme,
            public_key.len()
        )));
    }
    Ok(RequestKey::Key {
        scheme,
        public_key: public_key.to_vec(),
    })
}

/// Verifies `signature` over `message` for `sender_address`.
pub async fn verify_request_sender(
    message: &[u8],
    signature: &[u8],
    key: &RequestKey,
    sender_address: &str,
) -> Result<VerifiedSender, AuthError> {
    match key {
        RequestKey::Key { scheme, public_key } => {
            verify_signature(message, signature, public_key, *scheme)?;
            verify_address_matches_pubkey(sender_address, public_key, *scheme)?;
            Ok(VerifiedSender {
                scheme: *scheme,
                public_key: public_key.clone(),
                zklogin: false,
            })
        }
        RequestKey::ZkLogin => {
            let sender = zklogin::shared()
                .verify(message, signature, sender_address)
                .await?;
            Ok(VerifiedSender {
                scheme: sender.scheme,
                public_key: sender.ephemeral_public_key,
                zklogin: true,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_keys_like_before() {
        let mut ed = vec![0x00];
        ed.extend_from_slice(&[1u8; 32]);
        assert_eq!(
            parse_request_key(&ed).unwrap(),
            RequestKey::Key {
                scheme: SignatureScheme::Ed25519,
                public_key: vec![1u8; 32]
            }
        );
        assert!(matches!(
            parse_request_key(&[0x00, 1, 2]),
            Err(AuthError::InvalidPublicKeyFormat(_))
        ));
        assert!(matches!(
            parse_request_key(&[0x09]),
            Err(AuthError::InvalidPublicKeyFormat(_))
        ));
        assert!(matches!(
            parse_request_key(&[]),
            Err(AuthError::InvalidPublicKeyFormat(_))
        ));
    }

    #[test]
    fn zklogin_marker_is_flag_only() {
        assert_eq!(parse_request_key(&[0x05]).unwrap(), RequestKey::ZkLogin);
        assert!(matches!(
            parse_request_key(&[0x05, 1]),
            Err(AuthError::InvalidPublicKeyFormat(_))
        ));
    }
}
