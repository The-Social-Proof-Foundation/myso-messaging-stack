//! Shared archive read service for recovery HTTP handlers.

use std::sync::Arc;

use serde_json::Value;

use super::index::{ArchiveIndex, ArchiveListParams};
use super::r2::ObjectStore;
use super::types::{ArchiveError, ArchiveResult};

pub struct ArchiveReadService {
    pub store: Arc<dyn ObjectStore>,
    pub index: Arc<dyn ArchiveIndex>,
    pub default_namespace: String,
}

impl ArchiveReadService {
    pub fn new(
        store: Arc<dyn ObjectStore>,
        index: Arc<dyn ArchiveIndex>,
        default_namespace: impl Into<String>,
    ) -> Self {
        Self {
            store,
            index,
            default_namespace: default_namespace.into(),
        }
    }

    pub async fn list_messages(
        &self,
        group_id: &str,
        namespace: Option<&str>,
        after_order: Option<i64>,
        before_order: Option<i64>,
        limit: usize,
    ) -> ArchiveResult<(Vec<Value>, bool)> {
        let ns = namespace
            .filter(|s| !s.is_empty())
            .unwrap_or(self.default_namespace.as_str());
        let fetch_limit = limit.saturating_add(1).max(1);
        let rows = self
            .index
            .list_for_group(
                ns,
                group_id,
                ArchiveListParams {
                    after_order,
                    before_order,
                    limit: fetch_limit,
                },
            )
            .await?;

        let has_next = rows.len() > limit;
        let page = if has_next { &rows[..limit] } else { &rows[..] };

        let mut messages = Vec::with_capacity(page.len());
        for row in page {
            match self.store.get_object(&row.r2_key).await {
                Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(v) => messages.push(v),
                    Err(e) => {
                        tracing::warn!("skip corrupt archive object {}: {e}", row.r2_key);
                    }
                },
                Err(e) => {
                    tracing::warn!("skip missing archive object {}: {e}", row.r2_key);
                }
            }
        }

        Ok((messages, has_next))
    }
}

impl From<ArchiveError> for (axum::http::StatusCode, String) {
    fn from(e: ArchiveError) -> Self {
        match e {
            ArchiveError::Config(m) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, m),
            ArchiveError::ApiError { status, message } if status == 404 => {
                (axum::http::StatusCode::NOT_FOUND, message)
            }
            other => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                other.to_string(),
            ),
        }
    }
}
