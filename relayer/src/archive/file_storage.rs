//! File Storage (Walrus-style quilts) archive backend.

use std::sync::Arc;

use async_trait::async_trait;

use crate::file_storage::types::QuiltPatchMetadata;
use crate::file_storage::FileStorageClient;

use super::types::{ArchiveBackend, ArchiveError, ArchiveItem, ArchiveResult, ArchiveStoreResult};

/// Archives messages as File Storage quilt patches.
pub struct FileStorageArchiveBackend {
    client: Arc<FileStorageClient>,
    storage_epochs: u32,
}

impl FileStorageArchiveBackend {
    pub fn new(client: Arc<FileStorageClient>, storage_epochs: u32) -> Self {
        Self {
            client,
            storage_epochs,
        }
    }
}

#[async_trait]
impl ArchiveBackend for FileStorageArchiveBackend {
    fn name(&self) -> &'static str {
        "file_storage"
    }

    async fn store_batch(&self, items: Vec<ArchiveItem>) -> ArchiveResult<Vec<ArchiveStoreResult>> {
        if items.is_empty() {
            return Ok(vec![]);
        }

        let mut patches: Vec<(String, Vec<u8>)> = Vec::with_capacity(items.len());
        let mut metadata: Vec<QuiltPatchMetadata> = Vec::with_capacity(items.len());

        for item in &items {
            metadata.push(QuiltPatchMetadata {
                identifier: item.identifier.clone(),
                tags: item.tags.clone(),
            });
            patches.push((item.identifier.clone(), item.payload.clone()));
        }

        let response = self
            .client
            .store_quilt(patches, Some(metadata), self.storage_epochs)
            .await
            .map_err(|e| ArchiveError::RequestFailed(e.to_string()))?;

        let mut results = Vec::with_capacity(items.len());
        for item in &items {
            match response.get_patch_id(&item.identifier) {
                Some(patch_id) => results.push(ArchiveStoreResult {
                    message_id: item.message_id,
                    archive_ref: patch_id.to_string(),
                }),
                None => {
                    tracing::warn!(
                        "No patch ID in File Storage response for {}",
                        item.identifier
                    );
                }
            }
        }

        Ok(results)
    }
}
