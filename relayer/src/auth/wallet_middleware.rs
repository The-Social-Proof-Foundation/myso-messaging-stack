//! Wallet-scoped authentication (no group membership required).
//!
//! Bodyless signed message: `timestamp:sender_address`
//! Bodyless DELETE with path token: `timestamp:sender_address:token`
//! Body requests: entire JSON body is the signed message (must include sender_address, timestamp).

use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode},
    middleware::Next,
    response::Response,
};
use http_body_util::BodyExt;
use serde::Deserialize;

use super::{
    schemes::SignatureScheme,
    signature::{validate_timestamp, verify_address_matches_pubkey, verify_signature},
    types::{AuthContext, AuthError},
    AuthState,
};
use crate::auth::middleware::{error_response, auth_error_response, get_header};

#[derive(Debug, Deserialize)]
struct WalletBodyAuthFields {
    sender_address: String,
    timestamp: i64,
}

pub async fn wallet_auth_middleware(
    State(state): State<AuthState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let (parts, body) = request.into_parts();

    let signature_hex = match get_header(&parts.headers, "x-signature") {
        Some(v) => v,
        None => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "Missing X-Signature header",
                "MISSING_SIGNATURE",
            );
        }
    };

    let public_key_hex = match get_header(&parts.headers, "x-public-key") {
        Some(v) => v,
        None => {
            return error_response(
                StatusCode::UNAUTHORIZED,
                "Missing X-Public-Key header",
                "MISSING_PUBLIC_KEY",
            );
        }
    };

    let public_key_with_flag = match hex::decode(&public_key_hex) {
        Ok(bytes) if !bytes.is_empty() => bytes,
        Ok(_) => {
            return auth_error_response(
                StatusCode::UNAUTHORIZED,
                AuthError::InvalidPublicKeyFormat("Empty public key".to_string()),
            );
        }
        Err(e) => {
            return auth_error_response(
                StatusCode::UNAUTHORIZED,
                AuthError::InvalidPublicKeyFormat(e.to_string()),
            );
        }
    };

    let scheme_flag = public_key_with_flag[0];
    let scheme = match SignatureScheme::from_flag(scheme_flag) {
        Some(s) => s,
        None => {
            return auth_error_response(
                StatusCode::UNAUTHORIZED,
                AuthError::InvalidPublicKeyFormat(format!(
                    "Unknown signature scheme flag: 0x{:02x}",
                    scheme_flag
                )),
            );
        }
    };
    let public_key_bytes = &public_key_with_flag[1..];
    if public_key_bytes.len() != scheme.public_key_length() {
        return auth_error_response(
            StatusCode::UNAUTHORIZED,
            AuthError::InvalidPublicKeyFormat(format!(
                "Expected {} bytes for {}, got {}",
                scheme.public_key_length(),
                scheme,
                public_key_bytes.len()
            )),
        );
    }

    let signature_bytes = match hex::decode(&signature_hex) {
        Ok(bytes) => bytes,
        Err(e) => {
            return auth_error_response(
                StatusCode::UNAUTHORIZED,
                AuthError::InvalidSignatureFormat(e.to_string()),
            );
        }
    };

    let body_bytes = match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Failed to read request body",
                "BODY_READ_ERROR",
            );
        }
    };

    let (sender_address, timestamp, message_bytes) = if !body_bytes.is_empty() {
        let body_auth: WalletBodyAuthFields = match serde_json::from_slice(&body_bytes) {
            Ok(fields) => fields,
            Err(e) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("Invalid request body: {}", e),
                    "INVALID_BODY",
                );
            }
        };
        (
            body_auth.sender_address,
            body_auth.timestamp,
            body_bytes.to_vec(),
        )
    } else {
        let sender_address = match get_header(&parts.headers, "x-sender-address") {
            Some(v) => v,
            None => {
                return error_response(
                    StatusCode::UNAUTHORIZED,
                    "Missing X-Sender-Address header",
                    "MISSING_SENDER_ADDRESS",
                );
            }
        };
        let timestamp_str = match get_header(&parts.headers, "x-timestamp") {
            Some(v) => v,
            None => {
                return error_response(
                    StatusCode::UNAUTHORIZED,
                    "Missing X-Timestamp header",
                    "MISSING_TIMESTAMP",
                );
            }
        };
        let timestamp: i64 = match timestamp_str.parse() {
            Ok(t) => t,
            Err(_) => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "Invalid X-Timestamp header",
                    "INVALID_TIMESTAMP",
                );
            }
        };

        let canonical = if method == Method::DELETE {
            let token = parts
                .uri
                .path()
                .rsplit('/')
                .next()
                .unwrap_or("");
            format!("{}:{}:{}", timestamp, sender_address, token)
        } else {
            format!("{}:{}", timestamp, sender_address)
        };
        (sender_address, timestamp, canonical.into_bytes())
    };

    if let Err(e) = validate_timestamp(timestamp, state.config.request_ttl_seconds) {
        return auth_error_response(StatusCode::UNAUTHORIZED, e);
    }

    if let Err(e) = verify_signature(&message_bytes, &signature_bytes, public_key_bytes, scheme) {
        return auth_error_response(StatusCode::UNAUTHORIZED, e);
    }

    if let Err(e) = verify_address_matches_pubkey(&sender_address, public_key_bytes, scheme) {
        return auth_error_response(StatusCode::UNAUTHORIZED, e);
    }

    let auth_context = AuthContext {
        sender_address,
        public_key: public_key_bytes.to_vec(),
        scheme,
        authorized_group: None,
    };

    let mut request = Request::from_parts(parts, Body::from(body_bytes));
    request.extensions_mut().insert(auth_context);
    next.run(request).await
}
