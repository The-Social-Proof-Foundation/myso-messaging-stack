//! POST `/v1/users/unread-counts` — batch per-group activity for sidebar badges.
//!
//! One wallet-authenticated request replaces N per-group message pages: for
//! each `(group_id, after_order)` item the response carries the group's
//! highest assigned order and the exact count of non-deleted messages after
//! the watermark. Groups the wallet cannot read are silently omitted
//! (membership may lag the chain; clients treat missing entries as unknown).

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::{AuthContext, MessagingPermission};
use crate::handlers::messages::error::ApiError;
use crate::state::AppState;

/// Request cap — a sidebar refresh is one request, not a scraping vector.
const MAX_ITEMS: usize = 100;

#[derive(Debug, Deserialize)]
pub struct UnreadCountsBody {
    pub sender_address: String,
    #[serde(default)]
    pub items: Vec<UnreadCountsItem>,
}

#[derive(Debug, Deserialize)]
pub struct UnreadCountsItem {
    pub group_id: String,
    /// Client's read watermark (relayer `order`, exclusive). Defaults to 0
    /// (count everything).
    #[serde(default)]
    pub after_order: i64,
}

#[derive(Debug, Serialize)]
pub struct UnreadCountsResponse {
    pub items: Vec<GroupActivityWire>,
}

#[derive(Debug, Serialize)]
pub struct GroupActivityWire {
    pub group_id: String,
    pub latest_order: i64,
    pub unread_count: i64,
}

pub async fn post_unread_counts(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<UnreadCountsBody>,
) -> Result<Json<UnreadCountsResponse>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }
    if body.items.len() > MAX_ITEMS {
        return Err(ApiError::BadRequest(format!(
            "Too many items: {} (max {})",
            body.items.len(),
            MAX_ITEMS
        )));
    }

    let mut items = Vec::with_capacity(body.items.len());
    for item in &body.items {
        if !state.membership_store.has_permission(
            &item.group_id,
            &auth.sender_address,
            MessagingPermission::MessagingReader,
        ) {
            continue;
        }

        let activity = state
            .storage
            .get_group_activity(&item.group_id, item.after_order)
            .await
            .map_err(ApiError::from)?;

        items.push(GroupActivityWire {
            group_id: item.group_id.clone(),
            latest_order: activity.latest_order,
            unread_count: activity.unread_count,
        });
    }

    Ok(Json(UnreadCountsResponse { items }))
}
