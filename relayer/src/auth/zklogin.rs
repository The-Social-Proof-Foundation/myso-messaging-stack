//! zkLogin sender authentication for relayer requests.
//!
//! A zkLogin account has no key whose address is the account address, so clients send the full
//! serialized zkLogin signature (flag `0x05`) with `public_key` set to just `05`.
//!
//! Verification, in order:
//! 1. Parse the signature; it must be a zkLogin authenticator.
//! 2. The claimed `sender_address` must be an address the proof's public identifier derives.
//! 3. The ephemeral signature inside must verify over this exact message (local, every request).
//! 4. The proof itself (ephemeral key + max epoch bound to the address, current JWKs, epoch window)
//!    is checked by the chain's GraphQL `verifyZkLoginSignature`. A success is cached for 10 minutes
//!    per (address, proof inputs, max epoch, ephemeral key), so later requests only repeat 1-3.
//!
//! Anything that fails, including GraphQL being unreachable, is rejected (fail closed).

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine;
use blake2::{digest::consts::U32, Blake2b, Digest};
use myso_crypto::{MySoVerifier, UserSignatureVerifier};
use myso_sdk_types::{PersonalMessage, SimpleSignature, UserSignature, ZkLoginAuthenticator};

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

/// Remote proof check. GraphQL in production; a stub in tests.
#[async_trait]
pub trait ZkLoginProofCheck: Send + Sync {
    /// `Ok` only when the chain accepts `signature` over the personal message `message` for `author`.
    async fn verify(&self, message: &[u8], signature: &[u8], author: &str)
        -> Result<(), AuthError>;
}

/// `verifyZkLoginSignature` on the network's GraphQL service.
pub struct GraphQlZkLoginCheck {
    url: String,
    client: reqwest::Client,
}

impl GraphQlZkLoginCheck {
    pub fn new(url: impl Into<String>) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_default();
        Self {
            url: url.into(),
            client,
        }
    }
}

const VERIFY_QUERY: &str = "query VerifyZkLogin($bytes: Base64!, $signature: Base64!, $author: MySoAddress!) {
  verifyZkLoginSignature(bytes: $bytes, signature: $signature, intentScope: PERSONAL_MESSAGE, author: $author) {
    success
    error
  }
}";

#[async_trait]
impl ZkLoginProofCheck for GraphQlZkLoginCheck {
    async fn verify(
        &self,
        message: &[u8],
        signature: &[u8],
        author: &str,
    ) -> Result<(), AuthError> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let body = serde_json::json!({
            "query": VERIFY_QUERY,
            "variables": {
                "bytes": b64.encode(message),
                "signature": b64.encode(signature),
                "author": author,
            },
        });

        let response = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| unavailable(&e.to_string()))?;
        if !response.status().is_success() {
            return Err(unavailable(&format!("HTTP {}", response.status())));
        }
        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| unavailable(&e.to_string()))?;

        if let Some(errors) = json.get("errors").and_then(|e| e.as_array()) {
            if !errors.is_empty() {
                return Err(unavailable(
                    &serde_json::Value::Array(errors.clone()).to_string(),
                ));
            }
        }
        let result = &json["data"]["verifyZkLoginSignature"];
        if result["success"].as_bool() == Some(true) {
            return Ok(());
        }
        let reason = result["error"].as_str().unwrap_or("rejected by chain");
        Err(AuthError::SignatureVerificationFailed(format!(
            "zkLogin proof rejected: {reason}"
        )))
    }
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
    /// Enabled when `MYSO_GRAPHQL_URL` is set; otherwise every zkLogin request is rejected.
    pub fn from_env() -> Self {
        match std::env::var("MYSO_GRAPHQL_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            Some(url) => Self::with_check(Arc::new(GraphQlZkLoginCheck::new(url))),
            None => {
                tracing::info!("MYSO_GRAPHQL_URL not set: zkLogin request auth disabled");
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

/// Process-wide verifier, configured from `MYSO_GRAPHQL_URL` on first use.
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

    #[test]
    fn zklogin_flag_detection() {
        assert!(is_zklogin_public_key(&[0x05]));
        assert!(!is_zklogin_public_key(&[0x00, 1, 2]));
        assert!(!is_zklogin_public_key(&[]));
    }
}
