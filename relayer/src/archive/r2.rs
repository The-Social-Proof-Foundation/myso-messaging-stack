//! In-process Cloudflare R2 archive backend (S3-compatible API).

use std::sync::Arc;

use async_trait::async_trait;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{BehaviorVersion, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use chrono::Utc;
use serde_json::Value;

use super::index::{ArchiveIndex, ArchiveIndexRow};
use super::types::{ArchiveBackend, ArchiveError, ArchiveItem, ArchiveResult, ArchiveStoreResult};

/// Object store abstraction (R2 via S3 API).
#[async_trait]
pub trait ObjectStore: Send + Sync {
    async fn put_object(&self, key: &str, body: Vec<u8>) -> ArchiveResult<()>;
    async fn get_object(&self, key: &str) -> ArchiveResult<Vec<u8>>;
}

pub struct R2ObjectStore {
    client: S3Client,
    bucket: String,
}

impl R2ObjectStore {
    pub fn from_config(
        endpoint: &str,
        bucket: &str,
        access_key_id: &str,
        secret_access_key: &str,
        region: &str,
    ) -> ArchiveResult<Self> {
        let creds = Credentials::new(
            access_key_id,
            secret_access_key,
            None,
            None,
            "r2-static",
        );
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(creds)
            .endpoint_url(endpoint)
            .region(Region::new(region.to_string()))
            .force_path_style(true)
            .build();
        Ok(Self {
            client: S3Client::from_conf(conf),
            bucket: bucket.to_string(),
        })
    }
}

#[async_trait]
impl ObjectStore for R2ObjectStore {
    async fn put_object(&self, key: &str, body: Vec<u8>) -> ArchiveResult<()> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(body))
            .content_type("application/json")
            .send()
            .await
            .map_err(|e| ArchiveError::RequestFailed(format!("R2 put: {e}")))?;
        Ok(())
    }

    async fn get_object(&self, key: &str) -> ArchiveResult<Vec<u8>> {
        let out = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| ArchiveError::RequestFailed(format!("R2 get: {e}")))?;
        let bytes = out
            .body
            .collect()
            .await
            .map_err(|e| ArchiveError::RequestFailed(format!("R2 body: {e}")))?
            .into_bytes()
            .to_vec();
        Ok(bytes)
    }
}

/// In-memory object store for unit tests.
pub struct MemoryObjectStore {
    objects: tokio::sync::RwLock<std::collections::HashMap<String, Vec<u8>>>,
}

impl MemoryObjectStore {
    pub fn new() -> Self {
        Self {
            objects: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }
}

impl Default for MemoryObjectStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ObjectStore for MemoryObjectStore {
    async fn put_object(&self, key: &str, body: Vec<u8>) -> ArchiveResult<()> {
        self.objects.write().await.insert(key.to_string(), body);
        Ok(())
    }

    async fn get_object(&self, key: &str) -> ArchiveResult<Vec<u8>> {
        self.objects
            .read()
            .await
            .get(key)
            .cloned()
            .ok_or_else(|| ArchiveError::ApiError {
                status: 404,
                message: format!("missing object {key}"),
            })
    }
}

pub fn r2_object_key(namespace: &str, group_id: &str, message_id: &uuid::Uuid) -> String {
    format!("{namespace}/groups/{group_id}/msg-{message_id}.json")
}

/// Archives messages to R2 and indexes them for recovery.
pub struct R2ArchiveBackend {
    store: Arc<dyn ObjectStore>,
    index: Arc<dyn ArchiveIndex>,
    namespace: String,
}

impl R2ArchiveBackend {
    pub fn new(
        store: Arc<dyn ObjectStore>,
        index: Arc<dyn ArchiveIndex>,
        namespace: impl Into<String>,
    ) -> Self {
        Self {
            store,
            index,
            namespace: namespace.into(),
        }
    }
}

#[async_trait]
impl ArchiveBackend for R2ArchiveBackend {
    fn name(&self) -> &'static str {
        "r2"
    }

    async fn store_batch(&self, items: Vec<ArchiveItem>) -> ArchiveResult<Vec<ArchiveStoreResult>> {
        if items.is_empty() {
            return Ok(vec![]);
        }

        let mut results = Vec::with_capacity(items.len());
        for item in items {
            let group_id = item
                .tags
                .get("group_id")
                .cloned()
                .or_else(|| extract_group_id_from_payload(&item.payload))
                .ok_or_else(|| {
                    ArchiveError::ParseError(format!(
                        "missing group_id for message {}",
                        item.message_id
                    ))
                })?;

            let sync_status = item
                .tags
                .get("sync_status")
                .cloned()
                .unwrap_or_else(|| "SYNCED".into());
            let msg_order = item
                .tags
                .get("order")
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| extract_order_from_payload(&item.payload));

            let key = r2_object_key(&self.namespace, &group_id, &item.message_id);

            // Stamp archive_ref onto the wire JSON when possible.
            let body = stamp_quilt_patch_id(&item.payload, &key);

            self.store.put_object(&key, body).await?;

            self.index
                .upsert(ArchiveIndexRow {
                    namespace: self.namespace.clone(),
                    group_id,
                    message_id: item.message_id,
                    msg_order,
                    sync_status,
                    r2_key: key.clone(),
                    updated_at: Utc::now(),
                })
                .await?;

            results.push(ArchiveStoreResult {
                message_id: item.message_id,
                archive_ref: key,
            });
        }

        Ok(results)
    }
}

fn extract_group_id_from_payload(payload: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    v.get("group_id")?.as_str().map(|s| s.to_string())
}

fn extract_order_from_payload(payload: &[u8]) -> Option<i64> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    v.get("order")?.as_i64()
}

fn stamp_quilt_patch_id(payload: &[u8], archive_ref: &str) -> Vec<u8> {
    match serde_json::from_slice::<Value>(payload) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "quilt_patch_id".into(),
                    Value::String(archive_ref.to_string()),
                );
            }
            serde_json::to_vec(&v).unwrap_or_else(|_| payload.to_vec())
        }
        Err(_) => payload.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::index::InMemoryArchiveIndex;
    use std::collections::HashMap;
    use uuid::Uuid;

    #[tokio::test]
    async fn store_batch_writes_object_and_index() {
        let store = Arc::new(MemoryObjectStore::new());
        let index = Arc::new(InMemoryArchiveIndex::new());
        let backend = R2ArchiveBackend::new(store.clone(), index.clone(), "mysocial");
        let id = Uuid::new_v4();
        let mut tags = HashMap::new();
        tags.insert("group_id".into(), "0xg".into());
        tags.insert("sync_status".into(), "SYNCED".into());
        tags.insert("order".into(), "3".into());

        let results = backend
            .store_batch(vec![ArchiveItem {
                message_id: id,
                identifier: format!("msg-{id}"),
                payload: br#"{"id":"x","group_id":"0xg","order":3}"#.to_vec(),
                tags,
            }])
            .await
            .unwrap();

        assert_eq!(results.len(), 1);
        let key = &results[0].archive_ref;
        assert!(key.starts_with("mysocial/groups/0xg/"));
        let body = store.get_object(key).await.unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["quilt_patch_id"], key.as_str());
    }
}
