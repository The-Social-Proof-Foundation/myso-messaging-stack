//! Types for pluggable archive backends.

use std::collections::HashMap;

use async_trait::async_trait;
use thiserror::Error;
use uuid::Uuid;

/// Which archive backend the relayer sync worker uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveBackendKind {
    /// Cloudflare R2 (S3 API) + Postgres/memory archive index.
    R2,
    FileStorage,
}

impl ArchiveBackendKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "r2" | "cloudflare" | "cf" => Some(Self::R2),
            "file_storage" | "filestorage" | "file-storage" => Some(Self::FileStorage),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::R2 => "r2",
            Self::FileStorage => "file_storage",
        }
    }
}

/// One message payload to archive (already serialized JSON + tags).
#[derive(Debug, Clone)]
pub struct ArchiveItem {
    pub message_id: Uuid,
    /// Patch / object identifier, e.g. `msg-{uuid}`.
    pub identifier: String,
    pub payload: Vec<u8>,
    pub tags: HashMap<String, String>,
}

/// Result for a single archived item.
///
/// `archive_ref` is stored in the DB `quilt_patch_id` column (opaque archive reference).
#[derive(Debug, Clone)]
pub struct ArchiveStoreResult {
    pub message_id: Uuid,
    pub archive_ref: String,
}

#[derive(Debug, Error)]
pub enum ArchiveError {
    #[error("archive request failed: {0}")]
    RequestFailed(String),
    #[error("archive API error {status}: {message}")]
    ApiError { status: u16, message: String },
    #[error("archive parse error: {0}")]
    ParseError(String),
    #[error("archive config error: {0}")]
    Config(String),
}

pub type ArchiveResult<T> = Result<T, ArchiveError>;

/// Pluggable durable archive for encrypted messages.
#[async_trait]
pub trait ArchiveBackend: Send + Sync {
    /// Store a batch of message payloads. Returns one result per successfully stored item.
    async fn store_batch(&self, items: Vec<ArchiveItem>) -> ArchiveResult<Vec<ArchiveStoreResult>>;

    /// Human-readable backend name for logs.
    fn name(&self) -> &'static str;
}
