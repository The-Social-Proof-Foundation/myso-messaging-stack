//! Postgres LISTEN worker — receives metadata NOTIFY and publishes full wire payloads.

use std::sync::Arc;
use std::time::Duration;

use sqlx::postgres::PgListener;
use tracing::{info, warn};

use super::{
    MessageCreatedEvent, PresenceChangedSignal, PresenceUpdatedEvent, ReactionUpdatedEvent,
    ReadStateUpdatedEvent, RealtimeHub, TypingEvent, UserFeedEvent, MESSAGE_CREATED_EVENT_TYPE,
    MESSAGE_EVENTS_CHANNEL, PRESENCE_CHANGED_SIGNAL_TYPE, READ_STATE_UPDATED_EVENT_TYPE,
    REACTION_UPDATED_EVENT_TYPE, TYPING_START_EVENT_TYPE, TYPING_STOP_EVENT_TYPE,
};
use crate::auth::MembershipStore;
use crate::storage::StorageAdapter;

pub struct PgListenerService {
    database_url: String,
    storage: Arc<dyn StorageAdapter>,
    hub: Arc<RealtimeHub>,
    /// Presence fan-out: each instance expands wallet-level `presence.changed`
    /// signals to group channels through its own membership store.
    membership_store: Arc<dyn MembershipStore>,
}

impl PgListenerService {
    pub fn new(
        database_url: String,
        storage: Arc<dyn StorageAdapter>,
        hub: Arc<RealtimeHub>,
        membership_store: Arc<dyn MembershipStore>,
    ) -> Self {
        Self {
            database_url,
            storage,
            hub,
            membership_store,
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
                Some(READ_STATE_UPDATED_EVENT_TYPE) => {
                    // Metadata only — the blob itself is re-fetched over REST.
                    let event: ReadStateUpdatedEvent = match serde_json::from_str(payload) {
                        Ok(event) => event,
                        Err(err) => {
                            warn!("invalid NOTIFY payload on {MESSAGE_EVENTS_CHANNEL}: {err}");
                            continue;
                        }
                    };
                    self.hub.publish_user_event(UserFeedEvent::ReadStateUpdated {
                        wallet: event.wallet,
                        blob_version: event.blob_version,
                    });
                }
                Some(TYPING_START_EVENT_TYPE) | Some(TYPING_STOP_EVENT_TYPE) => {
                    // Ephemeral — publish directly to the group channel.
                    let event: TypingEvent = match serde_json::from_str(payload) {
                        Ok(event) => event,
                        Err(err) => {
                            warn!("invalid NOTIFY payload on {MESSAGE_EVENTS_CHANNEL}: {err}");
                            continue;
                        }
                    };
                    self.hub.publish_typing(&event.group_id.clone(), event);
                }
                Some(PRESENCE_CHANGED_SIGNAL_TYPE) => {
                    // Wallet-level signal — fan out to the wallet's groups
                    // through this instance's membership store.
                    let signal: PresenceChangedSignal = match serde_json::from_str(payload) {
                        Ok(signal) => signal,
                        Err(err) => {
                            warn!("invalid NOTIFY payload on {MESSAGE_EVENTS_CHANNEL}: {err}");
                            continue;
                        }
                    };
                    for group_id in self.membership_store.groups_for_member(&signal.member) {
                        self.hub.publish_presence(
                            &group_id,
                            PresenceUpdatedEvent::new(
                                group_id.clone(),
                                signal.member.clone(),
                                signal.online,
                            ),
                        );
                    }
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
