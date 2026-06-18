//! WebSocket upgrade authentication (GET-style wallet signature).

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;

use super::middleware::get_header;
use super::permissions::MessagingPermission;
use super::schemes::SignatureScheme;
use super::signature::{validate_timestamp, verify_address_matches_pubkey, verify_signature};
use super::types::{AuthContext, AuthError};
use super::MembershipStore;

#[derive(Serialize)]
struct WsAuthErrorResponse {
    error: String,
    code: String,
}

/// Authenticate a WebSocket upgrade using headers or query parameters.
pub fn authenticate_ws_upgrade(
    headers: &HeaderMap,
    query: &WsAuthQuery,
    membership_store: &dyn MembershipStore,
    request_ttl_seconds: i64,
) -> Result<AuthContext, Response> {
    let group_id = query
        .group_id
        .clone()
        .or_else(|| get_header(headers, "x-group-id"))
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing group_id", "MISSING_GROUP_ID"))?;

    let sender_address = query
        .sender_address
        .clone()
        .or_else(|| get_header(headers, "x-sender-address"))
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Missing sender_address",
                "MISSING_SENDER_ADDRESS",
            )
        })?;

    let timestamp = query.timestamp.or_else(|| {
        get_header(headers, "x-timestamp").and_then(|v| v.parse().ok())
    }).ok_or_else(|| {
        error_response(
            StatusCode::UNAUTHORIZED,
            "Missing timestamp",
            "MISSING_TIMESTAMP",
        )
    })?;

    let signature_hex = query
        .signature
        .clone()
        .or_else(|| get_header(headers, "x-signature"))
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Missing signature",
                "MISSING_SIGNATURE",
            )
        })?;

    let public_key_hex = query
        .public_key
        .clone()
        .or_else(|| get_header(headers, "x-public-key"))
        .ok_or_else(|| {
            error_response(
                StatusCode::UNAUTHORIZED,
                "Missing public_key",
                "MISSING_PUBLIC_KEY",
            )
        })?;

    if let Err(err) = validate_timestamp(timestamp, request_ttl_seconds) {
        return Err(auth_error_response(StatusCode::UNAUTHORIZED, err));
    }

    let public_key_with_flag = hex::decode(&public_key_hex).map_err(|e| {
        auth_error_response(
            StatusCode::UNAUTHORIZED,
            AuthError::InvalidPublicKeyFormat(e.to_string()),
        )
    })?;

    if public_key_with_flag.is_empty() {
        return Err(auth_error_response(
            StatusCode::UNAUTHORIZED,
            AuthError::InvalidPublicKeyFormat("Empty public key".to_string()),
        ));
    }

    let scheme_flag = public_key_with_flag[0];
    let scheme = SignatureScheme::from_flag(scheme_flag).ok_or_else(|| {
        auth_error_response(
            StatusCode::UNAUTHORIZED,
            AuthError::InvalidPublicKeyFormat(format!(
                "Unknown signature scheme flag: 0x{scheme_flag:02x}"
            )),
        )
    })?;

    let public_key_bytes = &public_key_with_flag[1..];
    if public_key_bytes.len() != scheme.public_key_length() {
        return Err(auth_error_response(
            StatusCode::UNAUTHORIZED,
            AuthError::InvalidPublicKeyFormat(format!(
                "Expected {} bytes for {}, got {}",
                scheme.public_key_length(),
                scheme,
                public_key_bytes.len()
            )),
        ));
    }

    let signature_bytes = hex::decode(&signature_hex).map_err(|e| {
        auth_error_response(
            StatusCode::UNAUTHORIZED,
            AuthError::InvalidSignatureFormat(e.to_string()),
        )
    })?;

    let canonical = format!("{timestamp}:{sender_address}:{group_id}");
    verify_signature(
        canonical.as_bytes(),
        &signature_bytes,
        public_key_bytes,
        scheme,
    )
    .map_err(|err| auth_error_response(StatusCode::UNAUTHORIZED, err))?;

    verify_address_matches_pubkey(&sender_address, public_key_bytes, scheme)
        .map_err(|err| auth_error_response(StatusCode::UNAUTHORIZED, err))?;

    if !membership_store.has_permission(
        &group_id,
        &sender_address,
        MessagingPermission::MessagingReader,
    ) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Insufficient permissions",
            "FORBIDDEN",
        ));
    }

    Ok(AuthContext {
        sender_address,
        authorized_group: Some(group_id),
        scheme,
        public_key: public_key_bytes.to_vec(),
    })
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct WsAuthQuery {
    pub group_id: Option<String>,
    pub sender_address: Option<String>,
    pub timestamp: Option<i64>,
    pub signature: Option<String>,
    pub public_key: Option<String>,
    pub after_order: Option<i64>,
}

fn error_response(status: StatusCode, message: &str, code: &str) -> Response {
    (
        status,
        axum::Json(WsAuthErrorResponse {
            error: message.to_string(),
            code: code.to_string(),
        }),
    )
        .into_response()
}

fn auth_error_response(status: StatusCode, err: AuthError) -> Response {
    let code = match &err {
        AuthError::InvalidSignatureFormat(_) => "INVALID_SIGNATURE",
        AuthError::InvalidPublicKeyFormat(_) => "INVALID_PUBLIC_KEY",
        AuthError::SignatureVerificationFailed(_) => "SIGNATURE_VERIFICATION_FAILED",
        AuthError::AddressMismatch { .. } => "ADDRESS_MISMATCH",
        AuthError::RequestExpired { .. } | AuthError::InvalidTimestamp(_) => "INVALID_TIMESTAMP",
        AuthError::NotGroupMember { .. } => "FORBIDDEN",
        AuthError::MissingSignature
        | AuthError::MissingPublicKey
        | AuthError::MissingTimestamp => "MISSING_AUTH",
    };
    error_response(status, &err.to_string(), code)
}
