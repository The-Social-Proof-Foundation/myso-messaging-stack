//! Background services for the relayer.
//! This module contains services that run alongside the HTTP server:
//! - `event_parser`: Parses MySo blockchain events into domain types
//! - `membership_sync`: Subscribes to MySo checkpoints and syncs membership cache
//! - `file_storage_sync`: Periodically uploads pending messages to File Storage storage

pub mod event_parser;
pub mod membership_sync;
pub mod file_storage_sync;

pub use membership_sync::MembershipSyncService;
pub use file_storage_sync::FileStorageSyncService;
