//! Postgres LISTEN worker — receives metadata NOTIFY and publishes full wire payloads.

use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::PgListener;
use tracing::{info, warn};

use super::{
    MessageCreatedEvent, ReactionUpdatedEvent, RealtimeHub, MESSAGE_CREATED_EVENT_TYPE,
    MESSAGE_EVENTS_CHANNEL, REACTION_UPDATED_EVENT_TYPE,
};
use crate::storage::StorageAdapter;

pub struct PgListenerService {
    database_url: String,
    storage: Arc<dyn StorageAdapter>,
    hub: Arc<RealtimeHub>,
}

impl PgListenerService {
    pub fn new(
        database_url: String,
        storage: Arc<dyn StorageAdapter>,
        hub: Arc<RealtimeHub>,
    ) -> Self {
        Self {
            database_url,
            storage,
            hub,
        }
    }

    pub async fn run(&self) {
        loop {
            match self.listen_loop().await {
                Ok(()) => warn!("postgres listener loop exited unexpectedly"),
                Err(err) => warn!("postgres listener error: {err}"),
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    async fn listen_loop(&self) -> Result<(), String> {
        let mut listener = PgListener::connect(&self.database_url)
            .await
            .map_err(|e| e.to_string())?;
        listener
            .listen(MESSAGE_EVENTS_CHANNEL)
            .await
            .map_err(|e| e.to_string())?;

        info!("listening on postgres channel '{MESSAGE_EVENTS_CHANNEL}'");

        loop {
            let notification = listener.recv().await.map_err(|e| e.to_string())?;
            let payload = notification.payload();
            let event_type = serde_json::from_str::<serde_json::Value>(payload)
                .ok()
                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string));

            match event_type.as_deref() {
                Some(MESSAGE_CREATED_EVENT_TYPE) => {
                    let event: MessageCreatedEvent = match serde_json::from_str(payload) {
                        Ok(event) => event,
                        Err(err) => {
                            warn!("invalid NOTIFY payload on {MESSAGE_EVENTS_CHANNEL}: {err}");
                            continue;
                        }
                    };
                    if let Err(err) =
                        RealtimeHub::load_and_publish(&self.hub, &self.storage, event).await
                    {
                        warn!("failed to load message for realtime fan-out: {err}");
                    }
                }
                Some(REACTION_UPDATED_EVENT_TYPE) => {
                    // Self-contained payload — publish directly, no storage reload.
                    let event: ReactionUpdatedEvent = match serde_json::from_str(payload) {
                        Ok(event) => event,
                        Err(err) => {
                            warn!("invalid NOTIFY payload on {MESSAGE_EVENTS_CHANNEL}: {err}");
                            continue;
                        }
                    };
                    self.hub.publish_reaction(&event.group_id.clone(), event);
                }
                other => {
                    warn!(
                        "unknown NOTIFY event type {:?} on {MESSAGE_EVENTS_CHANNEL}",
                        other
                    );
                }
            }
        }
    }
}
