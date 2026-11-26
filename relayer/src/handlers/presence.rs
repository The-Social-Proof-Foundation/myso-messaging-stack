//! Client presence heartbeat for push gating, plus the online-peers snapshot.
//! `timestamp` is validated by wallet auth middleware, not this handler DTO.

use std::collections::HashSet;

use axum::extract::State;
use axum::Extension;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::AuthContext;
use crate::handlers::messages::error::ApiError;
use crate::services::presence_sync;
use crate::state::AppState;

/// One online co-member in one shared group (`GET /v1/users/presence`).
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct OnlinePeerEntry {
    pub group_id: String,
    pub member: String,
}

/// Every co-member currently online across the caller's groups, honoring each member's
/// per-group `hide_online_presence`. Pairs with `presence.updated` on `/v1/users/ws`:
/// clients load this snapshot on (re)connect, then apply live frames.
pub async fn get_user_presence(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Vec<OnlinePeerEntry>>, ApiError> {
    let caller = auth.sender_address.to_ascii_lowercase();
    let mut entries = Vec::new();
    let mut seen_groups = HashSet::new();
    for group_id in state.membership_store.groups_for_member(&auth.sender_address) {
        if !seen_groups.insert(group_id.to_ascii_lowercase()) {
            continue;
        }
        for member in state.membership_store.list_member_addresses(&group_id) {
            if member.to_ascii_lowercase() == caller
                || !state.presence_registry.is_online(&member)
            {
                continue;
            }
            if presence_sync::effective_online_in_group(&state, &group_id, &member, true).await {
                entries.push(OnlinePeerEntry {
                    group_id: group_id.clone(),
                    member,
                });
            }
        }
    }
    Ok(Json(entries))
}

#[derive(Debug, Deserialize)]
pub struct PostPresenceBody {
    pub sender_address: String,
    #[serde(default = "default_active")]
    pub active: bool,
}

fn default_active() -> bool {
    true
}

pub async fn post_presence(
    State(state): State<AppState>,
    Extension(auth): Extension<AuthContext>,
    Json(body): Json<PostPresenceBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if body.sender_address != auth.sender_address {
        return Err(ApiError::Forbidden(
            "sender_address does not match authenticated wallet".to_string(),
        ));
    }

    if body.active {
        state
            .storage
            .update_presence(&auth.sender_address)
            .await
            .map_err(ApiError::from)?;
    } else {
        // Explicit logout / teardown — drop sticky last_seen so GET snapshots
        // and push gating do not treat the wallet as recently active.
        state
            .storage
            .clear_presence(&auth.sender_address)
            .await
            .map_err(ApiError::from)?;
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::auth::{InMemoryMembershipStore, MembershipStore, MessagingPermission};
    use crate::config::Config;
    use crate::models::ConversationPreferencesPatch;
    use crate::services::block_check::BlockCheckService;
    use crate::services::push::PushService;
    use crate::storage::{create_storage, StorageType};

    fn auth(wallet: &str) -> AuthContext {
        AuthContext {
            sender_address: wallet.to_string(),
            public_key: vec![],
            scheme: crate::auth::schemes::SignatureScheme::Ed25519,
            authorized_group: None,
            zklogin: false,
        }
    }

    #[tokio::test]
    async fn snapshot_lists_online_co_members_and_honors_hidden_presence() {
        let config = Config::default();
        let membership: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
        for (group, wallet) in [
            ("dm-bob", "0xme"),
            ("dm-bob", "0xbob"),
            ("dm-carol", "0xme"),
            ("dm-carol", "0xcarol"),
            ("dm-dave", "0xme"),
            ("dm-dave", "0xdave"),
            ("other", "0xbob"),
            ("other", "0xerin"),
        ] {
            membership.add_member(group, wallet, vec![MessagingPermission::MessagingReader]);
        }
        let (sync_tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let state = AppState::new_for_tests(
            create_storage(StorageType::InMemory),
            sync_tx,
            membership,
            BlockCheckService::from_config(&config),
            PushService::from_config(&config),
        );
        for wallet in ["0xme", "0xbob", "0xcarol", "0xerin"] {
            state.presence_registry.connect(wallet);
        }
        state
            .storage
            .upsert_conversation_preferences(
                "dm-carol",
                "0xcarol",
                ConversationPreferencesPatch {
                    notification_mode: None,
                    receipt_mode: None,
                    hide_online_presence: Some(true),
                },
            )
            .await
            .unwrap();

        let Json(entries) = get_user_presence(State(state), Extension(auth("0xme")))
            .await
            .unwrap();

        // Bob is online; Carol hid presence; Dave is offline; Erin shares no group; self omitted.
        assert_eq!(
            entries,
            vec![OnlinePeerEntry {
                group_id: "dm-bob".to_string(),
                member: "0xbob".to_string(),
            }]
        );
    }
}
