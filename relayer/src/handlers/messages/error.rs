//! API error types and HTTP response mapping.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use tracing::error;

use crate::storage::StorageError;

/// API error type that maps to HTTP responses.
#[derive(Debug)]
#[allow(dead_code)]
pub enum ApiError {
    /// Resource not found (404)
    NotFound(String),
    /// Bad request - invalid parameters (400)
    BadRequest(String),
    /// Conflict - duplicate resource (409)
    Conflict(String),
    /// Internal server error (500)
    Internal(String),
    /// Unauthorized - invalid or missing authentication (401)
    Unauthorized(String),
    /// Forbidden - authenticated but not authorized (403)
    Forbidden(String),
    /// DM blocked by social graph (403, code BLOCKED)
    Blocked,
    /// Paid-DM gate: recipient requires on-chain escrow before a first message
    /// from a non-follower (402, code PAYMENT_REQUIRED)
    PaymentRequired {
        min_cost: Option<u64>,
        recipient: String,
    },
}
/// Error response body
#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    /// Minimum escrow (MYSO base units) for PAYMENT_REQUIRED, as a string.
    #[serde(skip_serializing_if = "Option::is_none")]
    min_cost: Option<String>,
    /// Recipient wallet for PAYMENT_REQUIRED.
    #[serde(skip_serializing_if = "Option::is_none")]
    recipient: Option<String>,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message, code, min_cost, recipient) = match self {
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg, None, None, None),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg, None, None, None),
            ApiError::Conflict(msg) => (StatusCode::CONFLICT, msg, None, None, None),
            ApiError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg, None, None, None),
            ApiError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg, None, None, None),
            ApiError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg, None, None, None),
            ApiError::Blocked => (
                StatusCode::FORBIDDEN,
                "Messaging blocked between these users".to_string(),
                Some("BLOCKED".to_string()),
                None,
                None,
            ),
            ApiError::PaymentRequired {
                min_cost,
                recipient,
            } => (
                StatusCode::PAYMENT_REQUIRED,
                "Recipient requires payment before receiving a first message".to_string(),
                Some("PAYMENT_REQUIRED".to_string()),
                min_cost.map(|c| c.to_string()),
                Some(recipient),
            ),
        };

        let body = Json(ErrorResponse {
            error: message,
            code,
            min_cost,
            recipient,
        });
        (status, body).into_response()
    }
}

impl From<StorageError> for ApiError {
    fn from(err: StorageError) -> Self {
        match err {
            StorageError::NotFound(id) => ApiError::NotFound(format!("Message not found: {}", id)),
            StorageError::GroupNotFound(id) => {
                ApiError::NotFound(format!("Group not found: {}", id))
            }
            StorageError::DuplicateId(id) => {
                ApiError::Conflict(format!("Duplicate message ID: {}", id))
            }
            StorageError::DuplicateNonce => ApiError::Conflict(
                "Duplicate nonce: a message with this nonce already exists".to_string(),
            ),
            StorageError::OperationFailed(msg) => {
                error!("Storage operation failed: {}", msg);
                ApiError::Internal(msg)
            }
        }
    }
}
