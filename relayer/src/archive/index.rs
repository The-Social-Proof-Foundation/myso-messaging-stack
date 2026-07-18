//! Archive message index (Postgres or in-memory). Bodies live in R2.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::types::{ArchiveError, ArchiveResult};

#[derive(Debug, Clone)]
pub struct ArchiveIndexRow {
    pub namespace: String,
    pub group_id: String,
    pub message_id: Uuid,
    pub msg_order: Option<i64>,
    pub sync_status: String,
    pub r2_key: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default)]
pub struct ArchiveListParams {
    pub after_order: Option<i64>,
    pub before_order: Option<i64>,
    pub limit: usize,
}

#[async_trait]
pub trait ArchiveIndex: Send + Sync {
    async fn upsert(&self, row: ArchiveIndexRow) -> ArchiveResult<()>;
    async fn list_for_group(
        &self,
        namespace: &str,
        group_id: &str,
        params: ArchiveListParams,
    ) -> ArchiveResult<Vec<ArchiveIndexRow>>;
}

/// In-memory index for tests / `STORAGE_TYPE=memory` with `ARCHIVE_BACKEND=r2`.
pub struct InMemoryArchiveIndex {
    rows: RwLock<HashMap<(String, String, Uuid), ArchiveIndexRow>>,
}

impl InMemoryArchiveIndex {
    pub fn new() -> Self {
        Self {
            rows: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryArchiveIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ArchiveIndex for InMemoryArchiveIndex {
    async fn upsert(&self, row: ArchiveIndexRow) -> ArchiveResult<()> {
        let mut map = self
            .rows
            .write()
            .map_err(|e| ArchiveError::RequestFailed(format!("index lock: {e}")))?;
        map.insert(
            (row.namespace.clone(), row.group_id.clone(), row.message_id),
            row,
        );
        Ok(())
    }

    async fn list_for_group(
        &self,
        namespace: &str,
        group_id: &str,
        params: ArchiveListParams,
    ) -> ArchiveResult<Vec<ArchiveIndexRow>> {
        let map = self
            .rows
            .read()
            .map_err(|e| ArchiveError::RequestFailed(format!("index lock: {e}")))?;
        let mut rows: Vec<_> = map
            .values()
            .filter(|r| r.namespace == namespace && r.group_id == group_id)
            .filter(|r| r.sync_status != "DELETED" && r.sync_status != "DELETE_PENDING")
            .cloned()
            .collect();
        rows.sort_by_key(|r| r.msg_order.unwrap_or(0));
        if let Some(after) = params.after_order {
            rows.retain(|r| r.msg_order.unwrap_or(0) > after);
        }
        if let Some(before) = params.before_order {
            rows.retain(|r| r.msg_order.unwrap_or(0) < before);
        }
        let limit = params.limit.max(1);
        rows.truncate(limit);
        Ok(rows)
    }
}

pub struct PostgresArchiveIndex {
    pool: PgPool,
}

impl PostgresArchiveIndex {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn connect(database_url: &str) -> ArchiveResult<Self> {
        let pool = PgPool::connect(database_url)
            .await
            .map_err(|e| ArchiveError::Config(format!("archive index DB connect: {e}")))?;
        Ok(Self::new(pool))
    }
}

#[async_trait]
impl ArchiveIndex for PostgresArchiveIndex {
    async fn upsert(&self, row: ArchiveIndexRow) -> ArchiveResult<()> {
        sqlx::query(
            r#"
            INSERT INTO archive_messages
                (namespace, group_id, message_id, msg_order, sync_status, r2_key, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (namespace, group_id, message_id) DO UPDATE SET
                msg_order = EXCLUDED.msg_order,
                sync_status = EXCLUDED.sync_status,
                r2_key = EXCLUDED.r2_key,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(&row.namespace)
        .bind(&row.group_id)
        .bind(row.message_id)
        .bind(row.msg_order)
        .bind(&row.sync_status)
        .bind(&row.r2_key)
        .bind(row.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| ArchiveError::RequestFailed(format!("archive upsert: {e}")))?;
        Ok(())
    }

    async fn list_for_group(
        &self,
        namespace: &str,
        group_id: &str,
        params: ArchiveListParams,
    ) -> ArchiveResult<Vec<ArchiveIndexRow>> {
        let limit = params.limit.max(1) as i64;
        let rows = sqlx::query_as::<_, ArchiveIndexRowDb>(
            r#"
            SELECT namespace, group_id, message_id, msg_order, sync_status, r2_key, updated_at
            FROM archive_messages
            WHERE namespace = $1 AND group_id = $2
              AND sync_status NOT IN ('DELETED', 'DELETE_PENDING')
              AND ($3::BIGINT IS NULL OR msg_order > $3)
              AND ($4::BIGINT IS NULL OR msg_order < $4)
            ORDER BY msg_order ASC NULLS LAST
            LIMIT $5
            "#,
        )
        .bind(namespace)
        .bind(group_id)
        .bind(params.after_order)
        .bind(params.before_order)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ArchiveError::RequestFailed(format!("archive list: {e}")))?;

        Ok(rows.into_iter().map(Into::into).collect())
    }
}

#[derive(sqlx::FromRow)]
struct ArchiveIndexRowDb {
    namespace: String,
    group_id: String,
    message_id: Uuid,
    msg_order: Option<i64>,
    sync_status: String,
    r2_key: String,
    updated_at: DateTime<Utc>,
}

impl From<ArchiveIndexRowDb> for ArchiveIndexRow {
    fn from(r: ArchiveIndexRowDb) -> Self {
        Self {
            namespace: r.namespace,
            group_id: r.group_id,
            message_id: r.message_id,
            msg_order: r.msg_order,
            sync_status: r.sync_status,
            r2_key: r.r2_key,
            updated_at: r.updated_at,
        }
    }
}

/// Build archive index: Postgres when DATABASE_URL is set, else in-memory.
pub async fn create_archive_index(database_url: Option<&str>) -> ArchiveResult<Arc<dyn ArchiveIndex>> {
    match database_url {
        Some(url) if !url.is_empty() => {
            let idx = PostgresArchiveIndex::connect(url).await?;
            Ok(Arc::new(idx))
        }
        _ => Ok(Arc::new(InMemoryArchiveIndex::new())),
    }
}
