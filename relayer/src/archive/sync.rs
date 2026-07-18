//! Background sync worker that uploads pending messages to the configured archive backend.
//!
//! Handles three sync workflows:
//! - SyncPending → Synced for new messages
//! - UpdatePending → Updated for edited messages
//! - DeletePending → Deleted for tombstones
//!
//! Sync is triggered by either a fixed interval or a message-count threshold.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tracing::{debug, error, info, warn};

use crate::config::Config;
use crate::file_storage::FileStorageClient;
use crate::models::SyncStatus;
use crate::storage::StorageAdapter;

use super::file_storage::FileStorageArchiveBackend;
use super::index::create_archive_index;
use super::r2::{R2ArchiveBackend, R2ObjectStore};
use super::read::ArchiveReadService;
use super::types::{ArchiveBackend, ArchiveBackendKind, ArchiveError, ArchiveItem};

/// Prefix for message patch identifiers. Must match file-storage-discovery-indexer.
pub const MSG_PREFIX: &str = "msg-";

/// Source tag value identifying messaging-relayer patches.
pub const SOURCE_TAG: &str = "myso-messaging-relayer";

/// Built archive write backend + optional recovery read service.
pub struct ArchiveStack {
    pub backend: Arc<dyn ArchiveBackend>,
    pub read: Option<Arc<ArchiveReadService>>,
}

/// Build the configured archive backend (+ recovery reader for R2).
pub async fn create_archive_stack(config: &Config) -> Result<ArchiveStack, ArchiveError> {
    match config.archive_backend {
        ArchiveBackendKind::FileStorage => {
            let client = Arc::new(FileStorageClient::new(
                &config.file_storage_publisher_url,
                &config.file_storage_aggregator_url,
            ));
            Ok(ArchiveStack {
                backend: Arc::new(FileStorageArchiveBackend::new(
                    client,
                    config.file_storage_storage_epochs,
                )),
                read: None,
            })
        }
        ArchiveBackendKind::R2 => {
            let namespace = config.archive_namespace.as_ref().ok_or_else(|| {
                ArchiveError::Config(
                    "ARCHIVE_NAMESPACE is required when ARCHIVE_BACKEND=r2".into(),
                )
            })?;
            let bucket = config.r2_bucket.as_ref().ok_or_else(|| {
                ArchiveError::Config("R2_BUCKET is required when ARCHIVE_BACKEND=r2".into())
            })?;
            let endpoint = config.r2_endpoint.as_ref().ok_or_else(|| {
                ArchiveError::Config("R2_ENDPOINT is required when ARCHIVE_BACKEND=r2".into())
            })?;
            let access_key = config.r2_access_key_id.as_ref().ok_or_else(|| {
                ArchiveError::Config(
                    "R2_ACCESS_KEY_ID is required when ARCHIVE_BACKEND=r2".into(),
                )
            })?;
            let secret = config.r2_secret_access_key.as_ref().ok_or_else(|| {
                ArchiveError::Config(
                    "R2_SECRET_ACCESS_KEY is required when ARCHIVE_BACKEND=r2".into(),
                )
            })?;

            let database_url = std::env::var("DATABASE_URL").ok();
            let index = create_archive_index(database_url.as_deref()).await?;
            let store: Arc<dyn super::r2::ObjectStore> = Arc::new(R2ObjectStore::from_config(
                endpoint,
                bucket,
                access_key,
                secret,
                &config.r2_region,
            )?);

            let backend = Arc::new(R2ArchiveBackend::new(
                store.clone(),
                index.clone(),
                namespace.clone(),
            ));
            let read = Arc::new(ArchiveReadService::new(
                store,
                index,
                namespace.clone(),
            ));

            Ok(ArchiveStack {
                backend,
                read: Some(read),
            })
        }
    }
}

/// Build write backend only (tests / File Storage).
pub async fn create_archive_backend(config: &Config) -> Result<Arc<dyn ArchiveBackend>, ArchiveError> {
    Ok(create_archive_stack(config).await?.backend)
}

/// Background service that syncs pending messages to the active archive backend.
pub struct ArchiveSyncService {
    storage: Arc<dyn StorageAdapter>,
    backend: Arc<dyn ArchiveBackend>,
    namespace: Option<String>,
    sync_interval_secs: u64,
    batch_size: usize,
    sync_rx: mpsc::UnboundedReceiver<()>,
    message_threshold: usize,
}

impl ArchiveSyncService {
    pub fn new(
        config: &Config,
        storage: Arc<dyn StorageAdapter>,
        backend: Arc<dyn ArchiveBackend>,
        sync_rx: mpsc::UnboundedReceiver<()>,
    ) -> Self {
        let batch_cap = match config.archive_backend {
            ArchiveBackendKind::FileStorage => 666,
            ArchiveBackendKind::R2 => 1000,
        };
        Self {
            storage,
            backend,
            namespace: config.archive_namespace.clone(),
            sync_interval_secs: config.file_storage_sync_interval_secs,
            batch_size: config.file_storage_sync_batch_size.min(batch_cap),
            sync_rx,
            message_threshold: config.file_storage_sync_message_threshold,
        }
    }

    pub async fn from_config(
        config: &Config,
        storage: Arc<dyn StorageAdapter>,
        sync_rx: mpsc::UnboundedReceiver<()>,
    ) -> Result<(Self, Option<Arc<ArchiveReadService>>), ArchiveError> {
        let stack = create_archive_stack(config).await?;
        Ok((
            Self::new(config, storage, stack.backend, sync_rx),
            stack.read,
        ))
    }

    /// Runs the sync worker forever.
    pub async fn run(&mut self) {
        info!(
            "Starting ArchiveSyncService backend={} (interval={}s, batch_size={}, message_threshold={}, namespace={:?})",
            self.backend.name(),
            self.sync_interval_secs,
            self.batch_size,
            self.message_threshold,
            self.namespace
        );

        let mut ticker = interval(Duration::from_secs(self.sync_interval_secs));
        let mut message_count: usize = 0;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    debug!(
                        "Archive sync triggered by timer (message_count was {})",
                        message_count
                    );
                }
                result = self.sync_rx.recv() => {
                    match result {
                        Some(()) => {
                            message_count += 1;
                            if self.message_threshold == 0 || message_count < self.message_threshold {
                                continue;
                            }
                            debug!(
                                "Archive sync triggered by message threshold ({}/{})",
                                message_count, self.message_threshold
                            );
                        }
                        None => {
                            warn!("Sync notification channel closed, stopping ArchiveSyncService");
                            return;
                        }
                    }
                }
            }

            if let Err(e) = self.sync_pending_messages().await {
                error!("Archive sync cycle failed (SyncPending): {}", e);
            }
            if let Err(e) = self.sync_updated_messages().await {
                error!("Archive sync cycle failed (UpdatePending): {}", e);
            }
            if let Err(e) = self.sync_deleted_messages().await {
                error!("Archive sync cycle failed (DeletePending): {}", e);
            }

            message_count = 0;
            ticker.reset();
        }
    }

    pub async fn sync_pending_messages(
        &self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.sync_messages(SyncStatus::SyncPending, SyncStatus::Synced, "pending")
            .await
    }

    pub async fn sync_updated_messages(
        &self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.sync_messages(SyncStatus::UpdatePending, SyncStatus::Updated, "updated")
            .await
    }

    pub async fn sync_deleted_messages(
        &self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.sync_messages(SyncStatus::DeletePending, SyncStatus::Deleted, "deleted")
            .await
    }

    async fn sync_messages(
        &self,
        from_status: SyncStatus,
        to_status: SyncStatus,
        label: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let messages = self
            .storage
            .get_messages_by_sync_status(from_status, self.batch_size)
            .await?;

        if messages.is_empty() {
            debug!("No {} messages to sync", label);
            return Ok(());
        }

        info!(
            "Syncing {} {} messages to archive backend={}",
            messages.len(),
            label,
            self.backend.name()
        );

        let mut items: Vec<ArchiveItem> = Vec::new();

        for msg in &messages {
            let identifier = format!("{}{}", MSG_PREFIX, msg.id);
            let mut msg_for_archive = msg.clone();
            msg_for_archive.sync_status = to_status;

            match serde_json::to_vec(&msg_for_archive) {
                Ok(data) => {
                    let mut tags = HashMap::new();
                    tags.insert("source".into(), SOURCE_TAG.into());
                    tags.insert("group_id".into(), msg.group_id.clone());
                    tags.insert("sender".into(), msg.sender_wallet_addr.clone());
                    tags.insert("sync_status".into(), to_status.to_string());
                    tags.insert(
                        "order".into(),
                        msg.order.map(|o| o.to_string()).unwrap_or_default(),
                    );
                    if let Some(ns) = &self.namespace {
                        tags.insert("namespace".into(), ns.clone());
                    }

                    items.push(ArchiveItem {
                        message_id: msg.id,
                        identifier,
                        payload: data,
                        tags,
                    });
                }
                Err(e) => {
                    warn!("Failed to serialize {} message {}: {}", label, msg.id, e);
                }
            }
        }

        if items.is_empty() {
            debug!("No patches to upload after serialization");
            return Ok(());
        }

        let results = self.backend.store_batch(items).await?;

        info!(
            "Archive store completed ({}). backend={}, stored={}",
            label,
            self.backend.name(),
            results.len()
        );

        for result in results {
            if let Err(e) = self
                .storage
                .update_sync_status(result.message_id, to_status, Some(result.archive_ref))
                .await
            {
                warn!(
                    "Failed to update sync status for {} message {}: {}",
                    label, result.message_id, e
                );
            }
        }

        info!("Archive {} sync cycle completed successfully", label);
        Ok(())
    }
}

/// Backward-compatible alias used by older tests/docs.
pub type FileStorageSyncService = ArchiveSyncService;
