//! In-process realtime fan-out for WebSocket subscribers.

mod pg_listener;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::warn;
use uuid::Uuid;

use crate::handlers::messages::response::MessageResponse;
use crate::storage::{StorageAdapter, StorageResult};

pub use pg_listener::PgListenerService;

pub const MESSAGE_EVENTS_CHANNEL: &str = "message_events";

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

/// WebSocket wire frame (encrypted message payload — relayer never decrypts).
#[derive(Debug, Clone, Serialize)]
pub struct MessageWireEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub message: MessageResponse,
}

/// Per-group broadcast fan-out to local WebSocket connections.
#[derive(Clone, Default)]
pub struct RealtimeHub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<MessageWireEvent>>>>,
}

impl RealtimeHub {
    pub fn new() -> Self {
        Self::default()
    }

    fn sender_for_group(&self, group_id: &str) -> broadcast::Sender<MessageWireEvent> {
        let mut channels = self.channels.write().expect("realtime hub lock poisoned");
        channels
            .entry(group_id.to_string())
            .or_insert_with(|| broadcast::channel(256).0)
            .clone()
    }

    pub fn subscribe(&self, group_id: &str) -> broadcast::Receiver<MessageWireEvent> {
        self.sender_for_group(group_id).subscribe()
    }

    pub fn publish_wire(&self, group_id: &str, message: MessageResponse) {
        let tx = self.sender_for_group(group_id);
        if tx.receiver_count() == 0 {
            return;
        }
        let event = MessageWireEvent {
            event_type: "message.created",
            message,
        };
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
        assert_eq!(event.event_type, "message.created");
        assert_eq!(event.message.group_id, "group-1");
        assert_eq!(event.message.encrypted_text, "deadbeef");
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

        let wire = rx.recv().await.expect("wire");
        assert_eq!(wire.message.message_id, created.id);
        assert_eq!(wire.message.encrypted_text, "deadbeef");
    }
}
