//! In-process realtime fan-out for WebSocket subscribers.

mod pg_listener;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

use crate::auth::MembershipStore;
use crate::handlers::messages::response::MessageResponse;
use crate::models::ReactionEntry;
use crate::storage::{StorageAdapter, StorageResult};

pub use pg_listener::PgListenerService;

pub const MESSAGE_EVENTS_CHANNEL: &str = "message_events";

pub const MESSAGE_CREATED_EVENT_TYPE: &str = "message.created";
pub const REACTION_UPDATED_EVENT_TYPE: &str = "reaction.updated";
pub const GROUP_ACTIVITY_EVENT_TYPE: &str = "group.activity";
pub const READ_STATE_UPDATED_EVENT_TYPE: &str = "read_state.updated";
pub const GROUP_DISCOVERED_EVENT_TYPE: &str = "group.discovered";
pub const GROUP_HIDDEN_EVENT_TYPE: &str = "group.hidden";
pub const TYPING_START_EVENT_TYPE: &str = "typing.start";
pub const TYPING_STOP_EVENT_TYPE: &str = "typing.stop";
pub const PRESENCE_UPDATED_EVENT_TYPE: &str = "presence.updated";
/// Cross-instance NOTIFY signal for wallet presence transitions. Carries no
/// group — each instance fans out through its own membership store.
pub const PRESENCE_CHANGED_SIGNAL_TYPE: &str = "presence.changed";

/// Seconds a `typing.start` stays valid without a refresh. The explicit
/// `typing.stop` is the primary clear; this TTL is the recovery mechanism
/// when a stop is never received (crash, network drop).
pub const TYPING_TTL_SECONDS: i64 = 5;

/// Cross-instance signal (Postgres NOTIFY metadata).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageCreatedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub group_id: String,
    pub message_id: Uuid,
    pub order: i64,
    pub sender: String,
}

impl MessageCreatedEvent {
    pub fn new(group_id: String, message_id: Uuid, order: i64, sender: String) -> Self {
        Self {
            event_type: "message.created".to_string(),
            group_id,
            message_id,
            order,
            sender,
        }
    }
}

/// Cross-instance + WS payload for reaction changes. Carries absolute state
/// (count + full reactor list) so duplicate delivery is idempotent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReactionUpdatedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub group_id: String,
    pub chain_seq: i64,
    /// Canonical Unicode emoji string (NFC).
    pub emoji: String,
    pub count: i32,
    pub reactors: Vec<String>,
}

impl ReactionUpdatedEvent {
    pub fn new(group_id: String, entry: &ReactionEntry) -> Self {
        Self {
            event_type: REACTION_UPDATED_EVENT_TYPE.to_string(),
            group_id,
            chain_seq: entry.chain_seq,
            emoji: entry.emoji.clone(),
            count: entry.count,
            reactors: entry.reactors.clone(),
        }
    }
}

/// Cross-instance NOTIFY payload for read-state writes (metadata only — the
/// encrypted blob stays in storage; clients re-fetch it over REST).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReadStateUpdatedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub wallet: String,
    pub blob_version: u64,
}

impl ReadStateUpdatedEvent {
    pub fn new(wallet: String, blob_version: u64) -> Self {
        Self {
            event_type: READ_STATE_UPDATED_EVENT_TYPE.to_string(),
            wallet,
            blob_version,
        }
    }
}

/// Wallet-scoped user-feed events (`/v1/users/ws`).
///
/// The internal envelope carries routing data (the target wallet) used for
/// per-connection filtering; [`UserFeedEvent::wire_frame`] strips it from
/// wallet-targeted frames before they are sent. Payloads are metadata only —
/// never ciphertext, membership lists, or group contents. The WebSocket is a
/// notification mechanism; REST stays the canonical source of truth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserFeedEvent {
    /// A message was stored in `group_id` — delivered to every connected
    /// member of the group.
    GroupActivity { group_id: String, latest_order: i64 },
    /// The wallet's encrypted read-state blob changed (cross-device sync) —
    /// delivered only to connections of that wallet.
    ReadStateUpdated { wallet: String, blob_version: u64 },
    /// A conversation appeared for `wallet` (created/invited/joined) —
    /// delivered only to connections of that wallet.
    GroupDiscovered {
        wallet: String,
        group_id: String,
        reason: DiscoveryReason,
    },
    /// A conversation should leave `wallet`'s sidebar (membership removed
    /// today; archived/blocked/workflow hiding tomorrow).
    GroupHidden { wallet: String, group_id: String },
}

/// Best-effort provenance for `group.discovered`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscoveryReason {
    /// The wallet created the group in the same transaction.
    Created,
    /// The wallet was added by someone else.
    Invited,
    /// Reserved for future self-join flows.
    #[allow(dead_code)]
    Joined,
}

impl UserFeedEvent {
    /// Whether this event should be delivered to a connection authenticated
    /// as `wallet`. Activity events use a membership check; wallet-targeted
    /// events use an exact match.
    pub fn matches_wallet(&self, wallet: &str, membership: &dyn MembershipStore) -> bool {
        match self {
            UserFeedEvent::GroupActivity { group_id, .. } => membership.is_member(group_id, wallet),
            UserFeedEvent::ReadStateUpdated { wallet: target, .. } => target == wallet,
            UserFeedEvent::GroupDiscovered { wallet: target, .. } => target == wallet,
            UserFeedEvent::GroupHidden { wallet: target, .. } => target == wallet,
        }
    }

    /// JSON frame sent to clients. Discovery frames omit the target wallet —
    /// the event is already wallet-scoped and server-filtered.
    pub fn wire_frame(&self) -> serde_json::Value {
        match self {
            UserFeedEvent::GroupActivity {
                group_id,
                latest_order,
            } => serde_json::json!({
                "type": GROUP_ACTIVITY_EVENT_TYPE,
                "group_id": group_id,
                "latest_order": latest_order,
            }),
            UserFeedEvent::ReadStateUpdated {
                wallet,
                blob_version,
            } => serde_json::json!({
                "type": READ_STATE_UPDATED_EVENT_TYPE,
                "wallet": wallet,
                "blob_version": blob_version,
            }),
            UserFeedEvent::GroupDiscovered { group_id, reason, .. } => serde_json::json!({
                "type": GROUP_DISCOVERED_EVENT_TYPE,
                "group_id": group_id,
                "reason": reason,
            }),
            UserFeedEvent::GroupHidden { group_id, .. } => serde_json::json!({
                "type": GROUP_HIDDEN_EVENT_TYPE,
                "group_id": group_id,
            }),
        }
    }
}

/// Ephemeral typing indicator (`typing.start` / `typing.stop`). Never
/// persisted — WS/NOTIFY broadcast only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TypingEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub group_id: String,
    pub member: String,
    /// Unix seconds after which a `typing.start` should be discarded by
    /// clients if no `typing.stop` arrived. Absent on stop events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

impl TypingEvent {
    pub fn start(group_id: String, member: String) -> Self {
        Self {
            event_type: TYPING_START_EVENT_TYPE.to_string(),
            group_id,
            member,
            expires_at: Some(chrono::Utc::now().timestamp() + TYPING_TTL_SECONDS),
        }
    }

    pub fn stop(group_id: String, member: String) -> Self {
        Self {
            event_type: TYPING_STOP_EVENT_TYPE.to_string(),
            group_id,
            member,
            expires_at: None,
        }
    }
}

/// Group-channel presence frame. Wallet-scoped: one online state per wallet,
/// fanned out to every group the wallet belongs to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresenceUpdatedEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub group_id: String,
    pub member: String,
    pub online: bool,
}

impl PresenceUpdatedEvent {
    pub fn new(group_id: String, member: String, online: bool) -> Self {
        Self {
            event_type: PRESENCE_UPDATED_EVENT_TYPE.to_string(),
            group_id,
            member,
            online,
        }
    }
}

/// Cross-instance NOTIFY signal for a wallet presence transition (no group —
/// each instance fans out via `MembershipStore::groups_for_member`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresenceChangedSignal {
    #[serde(rename = "type")]
    pub event_type: String,
    pub member: String,
    pub online: bool,
}

impl PresenceChangedSignal {
    pub fn new(member: String, online: bool) -> Self {
        Self {
            event_type: PRESENCE_CHANGED_SIGNAL_TYPE.to_string(),
            member,
            online,
        }
    }
}

/// WebSocket wire frame (encrypted message payload — relayer never decrypts).
#[derive(Debug, Clone, Serialize)]
pub struct MessageWireEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub message: MessageResponse,
}

/// Events fanned out to local WebSocket connections. Each variant serializes
/// its own `type` discriminator (`message.created`, `reaction.updated`,
/// `typing.start`/`typing.stop`, `presence.updated`).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RealtimeEvent {
    MessageCreated(MessageWireEvent),
    ReactionUpdated(ReactionUpdatedEvent),
    Typing(TypingEvent),
    PresenceUpdated(PresenceUpdatedEvent),
}

/// Broadcast fan-out to local WebSocket connections: per-group channels for
/// conversation feeds plus one global channel for the wallet-scoped user feed
/// (filtered per connection in the user-feed handler).
#[derive(Clone)]
pub struct RealtimeHub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<RealtimeEvent>>>>,
    user_feed: broadcast::Sender<UserFeedEvent>,
}

impl Default for RealtimeHub {
    fn default() -> Self {
        Self::new()
    }
}

impl RealtimeHub {
    pub fn new() -> Self {
        Self {
            channels: Arc::new(RwLock::new(HashMap::new())),
            user_feed: broadcast::channel(512).0,
        }
    }

    fn sender_for_group(&self, group_id: &str) -> broadcast::Sender<RealtimeEvent> {
        let mut channels = self.channels.write().expect("realtime hub lock poisoned");
        channels
            .entry(group_id.to_string())
            .or_insert_with(|| broadcast::channel(256).0)
            .clone()
    }

    pub fn subscribe(&self, group_id: &str) -> broadcast::Receiver<RealtimeEvent> {
        self.sender_for_group(group_id).subscribe()
    }

    /// Subscribes to the global user feed. Connections filter events with
    /// [`UserFeedEvent::matches_wallet`].
    pub fn subscribe_user_feed(&self) -> broadcast::Receiver<UserFeedEvent> {
        self.user_feed.subscribe()
    }

    pub fn publish_wire(&self, group_id: &str, message: MessageResponse) {
        // Sidebar metadata for the user feed — covers both the inline publish
        // path and the Postgres LISTEN path (both flow through here).
        self.publish_user_event(UserFeedEvent::GroupActivity {
            group_id: group_id.to_string(),
            latest_order: message.order,
        });

        let event = RealtimeEvent::MessageCreated(MessageWireEvent {
            event_type: MESSAGE_CREATED_EVENT_TYPE,
            message,
        });
        self.publish_event(group_id, event);
    }

    pub fn publish_reaction(&self, group_id: &str, event: ReactionUpdatedEvent) {
        self.publish_event(group_id, RealtimeEvent::ReactionUpdated(event));
    }

    pub fn publish_typing(&self, group_id: &str, event: TypingEvent) {
        self.publish_event(group_id, RealtimeEvent::Typing(event));
    }

    pub fn publish_presence(&self, group_id: &str, event: PresenceUpdatedEvent) {
        self.publish_event(group_id, RealtimeEvent::PresenceUpdated(event));
    }

    pub fn publish_user_event(&self, event: UserFeedEvent) {
        if self.user_feed.receiver_count() == 0 {
            return;
        }
        if let Err(e) = self.user_feed.send(event) {
            warn!("user feed publish failed: {}", e);
        }
    }

    fn publish_event(&self, group_id: &str, event: RealtimeEvent) {
        let tx = self.sender_for_group(group_id);
        if tx.receiver_count() == 0 {
            return;
        }
        if let Err(e) = tx.send(event) {
            warn!("realtime publish failed for group {}: {}", group_id, e);
        }
    }

    pub async fn load_and_publish(
        hub: &RealtimeHub,
        storage: &Arc<dyn StorageAdapter>,
        event: MessageCreatedEvent,
    ) -> StorageResult<()> {
        let message = storage.get_message(event.message_id).await?;
        let wire: MessageResponse = message.into();
        hub.publish_wire(&event.group_id, wire);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Message;

    fn sample_message(group_id: &str, order: i64) -> Message {
        Message::new(
            group_id.to_string(),
            "0xsender".to_string(),
            vec![0xde, 0xad, 0xbe, 0xef],
            vec![0u8; 12],
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        )
    }

    #[tokio::test]
    async fn publish_wire_delivers_to_subscriber() {
        let hub = RealtimeHub::new();
        let mut rx = hub.subscribe("group-1");

        let msg = sample_message("group-1", 1);
        let wire: MessageResponse = msg.into();
        hub.publish_wire("group-1", wire);

        let event = rx.recv().await.expect("event");
        let RealtimeEvent::MessageCreated(wire) = event else {
            panic!("expected message.created event");
        };
        assert_eq!(wire.event_type, MESSAGE_CREATED_EVENT_TYPE);
        assert_eq!(wire.message.group_id, "group-1");
        assert_eq!(wire.message.encrypted_text, "deadbeef");
    }

    #[tokio::test]
    async fn load_and_publish_fetches_encrypted_row() {
        let storage: Arc<dyn StorageAdapter> = Arc::new(crate::storage::InMemoryStorage::new());
        let hub = RealtimeHub::new();
        let mut rx = hub.subscribe("group-1");

        let created = storage
            .create_message(sample_message("group-1", 0))
            .await
            .unwrap();

        let event = MessageCreatedEvent::new(
            "group-1".to_string(),
            created.id,
            created.order.unwrap_or(1),
            created.sender_wallet_addr.clone(),
        );

        RealtimeHub::load_and_publish(&hub, &storage, event)
            .await
            .expect("load");

        let event = rx.recv().await.expect("wire");
        let RealtimeEvent::MessageCreated(wire) = event else {
            panic!("expected message.created event");
        };
        assert_eq!(wire.message.message_id, created.id);
        assert_eq!(wire.message.encrypted_text, "deadbeef");
    }

    #[tokio::test]
    async fn publish_reaction_delivers_idempotent_payload() {
        let hub = RealtimeHub::new();
        let mut rx = hub.subscribe("group-1");

        let entry = ReactionEntry {
            chain_seq: 7,
            emoji: "👍".to_string(),
            count: 2,
            reactors: vec!["0xa".to_string(), "0xb".to_string()],
        };
        hub.publish_reaction("group-1", ReactionUpdatedEvent::new("group-1".to_string(), &entry));

        let event = rx.recv().await.expect("event");
        let RealtimeEvent::ReactionUpdated(reaction) = event else {
            panic!("expected reaction.updated event");
        };
        assert_eq!(reaction.event_type, REACTION_UPDATED_EVENT_TYPE);
        assert_eq!(reaction.chain_seq, 7);
        assert_eq!(reaction.emoji, "👍");
        assert_eq!(reaction.count, 2);
        assert_eq!(reaction.reactors, vec!["0xa", "0xb"]);

        let json = serde_json::to_string(&RealtimeEvent::ReactionUpdated(reaction)).unwrap();
        assert!(json.contains(r#""type":"reaction.updated""#));
    }

    #[tokio::test]
    async fn publish_wire_emits_group_activity_on_user_feed() {
        let hub = RealtimeHub::new();
        let mut feed_rx = hub.subscribe_user_feed();

        let msg = sample_message("group-1", 1);
        let mut wire: MessageResponse = msg.into();
        wire.order = 7;
        hub.publish_wire("group-1", wire);

        let event = feed_rx.recv().await.expect("user feed event");
        assert_eq!(
            event,
            UserFeedEvent::GroupActivity {
                group_id: "group-1".to_string(),
                latest_order: 7,
            }
        );
    }

    #[test]
    fn user_feed_event_wallet_filtering() {
        let store = crate::auth::InMemoryMembershipStore::new();
        store.add_member(
            "group-1",
            "0xalice",
            vec![crate::auth::MessagingPermission::MessagingReader],
        );

        let activity = UserFeedEvent::GroupActivity {
            group_id: "group-1".to_string(),
            latest_order: 3,
        };
        assert!(activity.matches_wallet("0xalice", &store));
        assert!(!activity.matches_wallet("0xbob", &store));

        // Wallet-targeted events use exact match — membership is irrelevant.
        let discovered = UserFeedEvent::GroupDiscovered {
            wallet: "0xbob".to_string(),
            group_id: "group-9".to_string(),
            reason: DiscoveryReason::Invited,
        };
        assert!(discovered.matches_wallet("0xbob", &store));
        assert!(!discovered.matches_wallet("0xalice", &store));

        let hidden = UserFeedEvent::GroupHidden {
            wallet: "0xbob".to_string(),
            group_id: "group-9".to_string(),
        };
        assert!(hidden.matches_wallet("0xbob", &store));
        assert!(!hidden.matches_wallet("0xalice", &store));

        let read_state = UserFeedEvent::ReadStateUpdated {
            wallet: "0xalice".to_string(),
            blob_version: 4,
        };
        assert!(read_state.matches_wallet("0xalice", &store));
        assert!(!read_state.matches_wallet("0xbob", &store));
    }

    #[test]
    fn discovery_wire_frames_strip_target_wallet() {
        let discovered = UserFeedEvent::GroupDiscovered {
            wallet: "0xbob".to_string(),
            group_id: "group-9".to_string(),
            reason: DiscoveryReason::Created,
        };
        let frame = discovered.wire_frame();
        assert_eq!(frame["type"], "group.discovered");
        assert_eq!(frame["group_id"], "group-9");
        assert_eq!(frame["reason"], "created");
        assert!(frame.get("wallet").is_none(), "wallet must be stripped");
        assert!(frame.get("member").is_none());

        let hidden = UserFeedEvent::GroupHidden {
            wallet: "0xbob".to_string(),
            group_id: "group-9".to_string(),
        };
        let frame = hidden.wire_frame();
        assert_eq!(frame["type"], "group.hidden");
        assert_eq!(frame["group_id"], "group-9");
        assert!(frame.get("wallet").is_none(), "wallet must be stripped");

        let activity = UserFeedEvent::GroupActivity {
            group_id: "group-1".to_string(),
            latest_order: 12,
        };
        let frame = activity.wire_frame();
        assert_eq!(frame["type"], "group.activity");
        assert_eq!(frame["latest_order"], 12);
    }

    #[tokio::test]
    async fn publish_typing_start_and_stop_deliver_on_group_channel() {
        let hub = RealtimeHub::new();
        let mut rx = hub.subscribe("group-1");

        hub.publish_typing(
            "group-1",
            TypingEvent::start("group-1".to_string(), "0xalice".to_string()),
        );
        hub.publish_typing(
            "group-1",
            TypingEvent::stop("group-1".to_string(), "0xalice".to_string()),
        );

        let RealtimeEvent::Typing(start) = rx.recv().await.expect("start") else {
            panic!("expected typing event");
        };
        assert_eq!(start.event_type, TYPING_START_EVENT_TYPE);
        assert!(start.expires_at.is_some(), "start carries a TTL");
        let json = serde_json::to_string(&RealtimeEvent::Typing(start)).unwrap();
        assert!(json.contains(r#""type":"typing.start""#));

        let RealtimeEvent::Typing(stop) = rx.recv().await.expect("stop") else {
            panic!("expected typing event");
        };
        assert_eq!(stop.event_type, TYPING_STOP_EVENT_TYPE);
        assert!(stop.expires_at.is_none(), "stop has no TTL");
        let json = serde_json::to_string(&RealtimeEvent::Typing(stop)).unwrap();
        assert!(json.contains(r#""type":"typing.stop""#));
        assert!(!json.contains("expires_at"));
    }

    #[tokio::test]
    async fn publish_presence_delivers_on_group_channel() {
        let hub = RealtimeHub::new();
        let mut rx = hub.subscribe("group-1");

        hub.publish_presence(
            "group-1",
            PresenceUpdatedEvent::new("group-1".to_string(), "0xalice".to_string(), true),
        );

        let RealtimeEvent::PresenceUpdated(event) = rx.recv().await.expect("presence") else {
            panic!("expected presence event");
        };
        assert_eq!(event.event_type, PRESENCE_UPDATED_EVENT_TYPE);
        assert_eq!(event.member, "0xalice");
        assert!(event.online);
        let json = serde_json::to_string(&RealtimeEvent::PresenceUpdated(event)).unwrap();
        assert!(json.contains(r#""type":"presence.updated""#));
    }
}
