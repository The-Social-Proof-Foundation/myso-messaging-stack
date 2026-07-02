//! In-process realtime fan-out for WebSocket subscribers.

mod pg_listener;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

use crate::handlers::messages::response::MessageResponse;
use crate::models::ReactionEntry;
use crate::storage::{StorageAdapter, StorageResult};

pub use pg_listener::PgListenerService;

pub const MESSAGE_EVENTS_CHANNEL: &str = "message_events";

pub const MESSAGE_CREATED_EVENT_TYPE: &str = "message.created";
pub const REACTION_UPDATED_EVENT_TYPE: &str = "reaction.updated";

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

/// WebSocket wire frame (encrypted message payload — relayer never decrypts).
#[derive(Debug, Clone, Serialize)]
pub struct MessageWireEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub message: MessageResponse,
}

/// Events fanned out to local WebSocket connections. Each variant serializes
/// its own `type` discriminator (`message.created` / `reaction.updated`).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RealtimeEvent {
    MessageCreated(MessageWireEvent),
    ReactionUpdated(ReactionUpdatedEvent),
}

/// Per-group broadcast fan-out to local WebSocket connections.
#[derive(Clone, Default)]
pub struct RealtimeHub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<RealtimeEvent>>>>,
}

impl RealtimeHub {
    pub fn new() -> Self {
        Self::default()
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

    pub fn publish_wire(&self, group_id: &str, message: MessageResponse) {
        let event = RealtimeEvent::MessageCreated(MessageWireEvent {
            event_type: MESSAGE_CREATED_EVENT_TYPE,
            message,
        });
        self.publish_event(group_id, event);
    }

    pub fn publish_reaction(&self, group_id: &str, event: ReactionUpdatedEvent) {
        self.publish_event(group_id, RealtimeEvent::ReactionUpdated(event));
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
}
