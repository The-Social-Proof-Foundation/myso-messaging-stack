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
    request_sender::{parse_request_key, verify_request_sender},
    signature::{strip_hex_prefix, validate_timestamp},
    types::{AuthContext, AuthError},
    AuthState,
};
use crate::auth::middleware::{auth_error_response, error_response, get_header};

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

    let public_key_with_flag = match hex::decode(strip_hex_prefix(&public_key_hex)) {
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

    // Scheme flag + key, or `05` for a zkLogin signature.
    let request_key = match parse_request_key(&public_key_with_flag) {
        Ok(key) => key,
        Err(e) => return auth_error_response(StatusCode::UNAUTHORIZED, e),
    };

    let signature_bytes = match hex::decode(strip_hex_prefix(&signature_hex)) {
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

    // Branch by HTTP method, not body emptiness.
    let use_body_auth = matches!(method, Method::POST | Method::PUT);
    let (sender_address, timestamp, message_bytes) = if use_body_auth {
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
            Some(v) => v.to_ascii_lowercase(),
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
            let token = parts.uri.path().rsplit('/').next().unwrap_or("");
            format!("{}:{}:{}", timestamp, sender_address, token)
        } else {
            format!("{}:{}", timestamp, sender_address)
        };
        (sender_address, timestamp, canonical.into_bytes())
    };

    if let Err(e) = validate_timestamp(timestamp, state.config.request_ttl_seconds) {
        tracing::warn!(
            "wallet auth rejected {} {}: timestamp ({e}) sender={sender_address}",
            method,
            parts.uri.path()
        );
        return auth_error_response(StatusCode::UNAUTHORIZED, e);
    }

    let verified =
        match verify_request_sender(&message_bytes, &signature_bytes, &request_key, &sender_address)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                // e.g. client signed with a zkLogin key but sent the plain wallet address.
                tracing::warn!(
                    "wallet auth rejected {} {}: {e} sender={sender_address}",
                    method,
                    parts.uri.path()
                );
                return auth_error_response(StatusCode::UNAUTHORIZED, e);
            }
        };

    let auth_context = AuthContext {
        sender_address: sender_address.to_ascii_lowercase(),
        public_key: verified.public_key,
        scheme: verified.scheme,
        authorized_group: None,
        zklogin: verified.zklogin,
    };

    let mut request = Request::from_parts(parts, Body::from(body_bytes));
    request.extensions_mut().insert(auth_context);
    next.run(request).await
}
