//! Background services for the relayer.
//! This module contains services that run alongside the HTTP server:
//! - `event_parser`: Parses MySo blockchain events into domain types
//! - `membership_sync`: Subscribes to MySo checkpoints and syncs membership cache
//! - `file_storage_sync`: Re-exports [`crate::archive::ArchiveSyncService`]

pub mod agent_group_detector;
pub mod attribution_verify;
pub mod block_check;
pub mod event_parser;
pub mod membership_sync;
pub mod message_gate;
pub mod messaging_config;
pub mod file_storage_sync;
pub mod presence_sync;
pub mod push;
pub mod realtime;
pub mod workflow_expiry;

pub use attribution_verify::AttributionVerifyService;
pub use block_check::BlockCheckService;
pub use membership_sync::MembershipSyncService;
pub use message_gate::MessageGateService;
pub use messaging_config::{
    bootstrap_messaging_config_cache, fallback_messaging_config_cache, MessagingConfigCache,
    MessagingConfigSnapshot,
};
pub use crate::archive::{ArchiveSyncService, FileStorageSyncService};
pub use presence_sync::PresenceRegistry;
pub use push::PushService;
pub use realtime::{PgListenerService, RealtimeHub};
