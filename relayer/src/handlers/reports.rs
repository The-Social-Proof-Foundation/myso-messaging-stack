//! `POST /v1/reports` — metadata-only conversation report.
//!
//! The signed body may contain who, which chat, and a reason. The reporter
//! wallet is taken from the authenticated session. Message content is rejected.

use axum::extract::State;
use axum::Extension;
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::models::ConversationReport;
use crate::state::AppState;

const ALLOWED_FIELDS: &[&str] = &[
    "sender_address",
    "timestamp",
    "group_id",
    "reported_wallet",
    "reason",
    "note",
];

const CONTENT_FIELDS: &[&str] = &[
    "message",
    "messages",
    "text",
    "body",
    "ciphertext",
    "encrypted_text",
    "plaintext",
    "content",
];

const REASONS: &[&str] = &["spam", "harassment", "scam", "other"];

const NOTE_MAX_CHARS: usize = 200;

#[derive(Debug, Deserialize)]
struct CreateReportBody {
    sender_address: String,
    #[serde(default)]
    #[allow(dead_code)]
    timestamp: i64,
    group_id: String,
    #[serde(default)]
    reported_wallet: Option<String>,
    reason: String,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct CreateReportResponse {
    pub id: Uuid,
    pub created_at: String,
}

pub async fn post_report(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(raw): Json<Value>,
) -> Result<Json<CreateReportResponse>, ApiError> {
    let body = parse_report_body(&raw).map_err(ApiError::BadRequest)?;
    if body.sender_address.to_ascii_lowercase() != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }

    let group_id = normalize_object_id(&body.group_id).map_err(ApiError::BadRequest)?;
    if !state
        .membership_store
        .is_member(&group_id, &auth.sender_address)
    {
        return Err(ApiError::Forbidden(
            "You are not a member of this chat".to_string(),
        ));
    }

    let reported_wallet = match body.reported_wallet {
        Some(raw) => {
            let wallet = normalize_object_id(&raw).map_err(ApiError::BadRequest)?;
            if wallet == auth.sender_address {
                return Err(ApiError::BadRequest(
                    "reported_wallet must be the other person".to_string(),
                ));
            }
            if !state.membership_store.is_member(&group_id, &wallet) {
                return Err(ApiError::Forbidden(
                    "reported_wallet is not a member of this chat".to_string(),
                ));
            }
            Some(wallet)
        }
        None => None,
    };

    let reason = body.reason.trim().to_ascii_lowercase();
    if !REASONS.contains(&reason.as_str()) {
        return Err(ApiError::BadRequest(
            "reason must be spam, harassment, scam, or other".to_string(),
        ));
    }

    let note =
        normalize_note(reason.as_str(), body.note.as_deref()).map_err(ApiError::BadRequest)?;

    let report = ConversationReport {
        id: Uuid::new_v4(),
        reporter: auth.sender_address.clone(),
        group_id,
        reported_wallet,
        reason,
        note,
        created_at: Utc::now(),
    };
    let created_at = report.created_at.to_rfc3339();
    let id = report.id;
    state
        .storage
        .insert_conversation_report(report)
        .await
        .map_err(ApiError::from)?;

    Ok(Json(CreateReportResponse { id, created_at }))
}

fn parse_report_body(raw: &Value) -> Result<CreateReportBody, String> {
    let object = raw
        .as_object()
        .ok_or_else(|| "report body must be a JSON object".to_string())?;
    for key in object.keys() {
        if CONTENT_FIELDS.contains(&key.as_str()) {
            return Err("reports cannot include message content".to_string());
        }
        if !ALLOWED_FIELDS.contains(&key.as_str()) {
            return Err(format!("unknown field: {key}"));
        }
    }
    serde_json::from_value(raw.clone()).map_err(|err| format!("invalid report: {err}"))
}

fn normalize_note(reason: &str, note: Option<&str>) -> Result<Option<String>, String> {
    let trimmed = note.map(str::trim).filter(|value| !value.is_empty());
    match trimmed {
        Some(_) if reason != "other" => {
            Err("note is only allowed when reason is other".to_string())
        }
        Some(value) if value.chars().count() > NOTE_MAX_CHARS => {
            Err("note must be 200 characters or fewer".to_string())
        }
        Some(value) => Ok(Some(value.to_string())),
        None => Ok(None),
    }
}

fn normalize_object_id(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_ascii_lowercase();
    let hex = value
        .strip_prefix("0x")
        .ok_or_else(|| "address must start with 0x".to_string())?;
    if hex.is_empty() || hex.len() > 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid address".to_string());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({
            "sender_address": "0xabc",
            "timestamp": 1,
            "group_id": "0xgroup",
            "reason": "spam"
        })
    }

    #[test]
    fn accepts_metadata_only_report() {
        let mut body = base();
        body["reported_wallet"] = json!("0xpeer");
        let parsed = parse_report_body(&body).unwrap();
        assert_eq!(parsed.reason, "spam");
        assert_eq!(parsed.reported_wallet.as_deref(), Some("0xpeer"));
        assert!(parsed.note.is_none());
    }

    #[test]
    fn rejects_message_content_fields() {
        for key in ["message", "text", "body", "ciphertext", "content"] {
            let mut body = base();
            body[key] = json!("hello");
            let err = parse_report_body(&body).unwrap_err();
            assert_eq!(err, "reports cannot include message content");
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let mut body = base();
        body["extra"] = json!(1);
        let err = parse_report_body(&body).unwrap_err();
        assert!(err.contains("unknown field"));
    }

    #[test]
    fn note_only_for_other_and_capped() {
        assert!(normalize_note("spam", Some("nope")).is_err());
        assert_eq!(normalize_note("other", Some("  ")).unwrap(), None);
        let long = "a".repeat(201);
        assert!(normalize_note("other", Some(&long)).is_err());
        assert_eq!(
            normalize_note("other", Some("kept")).unwrap(),
            Some("kept".to_string())
        );
    }
}
