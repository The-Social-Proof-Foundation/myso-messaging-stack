//! Wallet-scoped presence: connection registry + group fan-out.
//!
//! Presence is maintained once per connected wallet, not per socket: the
//! registry refcounts every WebSocket connection (group feeds and the user
//! feed alike) and only the 0->1 (online) and 1->0 (offline) transitions
//! broadcast `presence.updated` — a wallet with 15 sockets across 15 groups
//! is still one presence state.
//!
//! Offline is debounced (grace period) so refreshes/reconnects don't flap.
//! Fan-out targets every group the wallet belongs to via
//! `MembershipStore::groups_for_member`; cross-instance delivery uses a single
//! `presence.changed` NOTIFY that each instance expands through its own
//! membership store. Live online is ephemeral (in-memory registry). Storage
//! last-seen remains for “last online …” labels and push gating; explicit
//! logout clears it via `POST /devices/presence` with `active: false`.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;

use tracing::warn;

use super::realtime::{PresenceChangedSignal, PresenceUpdatedEvent};
use crate::state::AppState;

/// Grace period before an offline transition is broadcast. A reconnect within
/// this window suppresses the offline event entirely.
const OFFLINE_GRACE: Duration = Duration::from_secs(10);

fn wallet_key(wallet: &str) -> String {
    wallet.to_ascii_lowercase()
}

/// Refcount of live WebSocket connections per wallet.
#[derive(Default)]
pub struct PresenceRegistry {
    connections: RwLock<HashMap<String, usize>>,
}

impl PresenceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a connection. Returns `true` on the 0->1 (online) transition.
    pub fn connect(&self, wallet: &str) -> bool {
        let key = wallet_key(wallet);
        let mut connections = self.connections.write().expect("presence registry poisoned");
        let count = connections.entry(key).or_insert(0);
        *count += 1;
        *count == 1
    }

    /// Unregisters a connection. Returns `true` on the 1->0 (offline) transition.
    pub fn disconnect(&self, wallet: &str) -> bool {
        let key = wallet_key(wallet);
        let mut connections = self.connections.write().expect("presence registry poisoned");
        match connections.get_mut(&key) {
            Some(count) => {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    connections.remove(&key);
                    true
                } else {
                    false
                }
            }
            None => false,
        }
    }

    pub fn is_online(&self, wallet: &str) -> bool {
        let key = wallet_key(wallet);
        let connections = self.connections.read().expect("presence registry poisoned");
        connections.get(&key).copied().unwrap_or(0) > 0
    }
}

/// Called by WS handlers when a connection opens.
pub async fn note_connect(state: &AppState, wallet: &str) {
    if state.presence_registry.connect(wallet) {
        broadcast_presence(state, wallet, true).await;
    }
}

/// Called by WS handlers when a connection closes. Offline is debounced:
/// broadcast only if the wallet is still fully disconnected after the grace
/// period. (A reconnect inside the window re-broadcasts online, which is
/// idempotent for observers that never saw an offline.)
pub fn note_disconnect(state: AppState, wallet: String) {
    if state.presence_registry.disconnect(&wallet) {
        tokio::spawn(async move {
            tokio::time::sleep(OFFLINE_GRACE).await;
            if !state.presence_registry.is_online(&wallet) {
                broadcast_presence(&state, &wallet, false).await;
            }
        });
    }
}

async fn broadcast_presence(state: &AppState, wallet: &str, online: bool) {
    if !state.realtime_enabled {
        return;
    }

    if state.inline_realtime_publish {
        // Single-instance (in-memory) mode: fan out locally.
        for group_id in state.membership_store.groups_for_member(wallet) {
            state.realtime_hub.publish_presence(
                &group_id,
                PresenceUpdatedEvent::new(group_id.clone(), wallet.to_string(), online),
            );
        }
    } else {
        // Postgres mode: one NOTIFY; every instance (including this one)
        // fans out through its own membership store via the LISTEN worker.
        let signal = PresenceChangedSignal::new(wallet.to_string(), online);
        match serde_json::to_string(&signal) {
            Ok(payload) => {
                if let Err(err) = state.storage.notify_realtime_event(&payload).await {
                    warn!("presence notify failed for {}: {}", wallet, err);
                }
            }
            Err(err) => warn!("presence signal serialize failed: {}", err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_reports_transitions_only_on_first_and_last_connection() {
        let registry = PresenceRegistry::new();

        // 0 -> 1 is the online transition.
        assert!(registry.connect("0xalice"));
        assert!(registry.is_online("0xalice"));

        // Additional sockets (more groups, more tabs) are not transitions.
        assert!(!registry.connect("0xalice"));
        assert!(!registry.connect("0xalice"));

        // Dropping to a nonzero count is not a transition.
        assert!(!registry.disconnect("0xalice"));
        assert!(!registry.disconnect("0xalice"));
        assert!(registry.is_online("0xalice"));

        // 1 -> 0 is the offline transition.
        assert!(registry.disconnect("0xalice"));
        assert!(!registry.is_online("0xalice"));

        // Disconnecting an unknown wallet is a no-op.
        assert!(!registry.disconnect("0xalice"));
        assert!(!registry.disconnect("0xbob"));
    }

    #[test]
    fn registry_reconnect_within_grace_is_a_fresh_online_transition() {
        let registry = PresenceRegistry::new();

        assert!(registry.connect("0xalice"));
        assert!(registry.disconnect("0xalice"));
        // Reconnect after full disconnect: online transition fires again and
        // the pending offline debounce (checked via is_online) is suppressed.
        assert!(registry.connect("0xalice"));
        assert!(registry.is_online("0xalice"));
    }
}
