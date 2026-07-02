//! Workflow inbox persistence (parallel to AgentGroupStore).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::MembershipStoreType;
use crate::models::workflow_item::{WorkflowItem, WorkflowItemIngest, WorkflowTransitionPatch, STATUS_OPEN};
use crate::services::realtime::{
    notify_workflow_item_event, WorkflowItemUpdatedEvent, WorkflowItemWireEvent,
    WORKFLOW_ITEM_CREATED_EVENT_TYPE, WORKFLOW_ITEM_UPDATED_EVENT_TYPE,
};

use super::adapter::{StorageError, StorageResult};

#[async_trait]
pub trait WorkflowStore: Send + Sync {
    async fn upsert_ingest(&self, ingest: &WorkflowItemIngest) -> StorageResult<WorkflowItem>;

    async fn list_for_recipient(
        &self,
        recipient: &str,
        status: Option<&str>,
        item_type: Option<&str>,
        cursor: Option<Uuid>,
        limit: i64,
    ) -> StorageResult<Vec<WorkflowItem>>;

    async fn get_by_id(&self, id: Uuid, recipient: &str) -> StorageResult<Option<WorkflowItem>>;

    async fn transition_status(
        &self,
        id: Uuid,
        recipient: &str,
        new_status: &str,
        actioned_by: Option<&str>,
    ) -> StorageResult<Option<WorkflowItem>>;

    async fn open_count(&self, recipient: &str) -> StorageResult<i64>;

    async fn transition_by_idempotency(
        &self,
        idempotency_key: &str,
        new_status: &str,
        actioned_by: Option<&str>,
        patch: WorkflowTransitionPatch,
    ) -> StorageResult<Option<WorkflowItem>>;
}

fn merge_json_payload(
    existing: &mut serde_json::Value,
    patch: &serde_json::Value,
) {
    if !existing.is_object() {
        *existing = serde_json::json!({});
    }
    if let (Some(obj), Some(patch_obj)) = (existing.as_object_mut(), patch.as_object()) {
        for (key, value) in patch_obj {
            obj.insert(key.clone(), value.clone());
        }
    }
}

pub struct NoOpWorkflowStore;

#[async_trait]
impl WorkflowStore for NoOpWorkflowStore {
    async fn upsert_ingest(&self, _ingest: &WorkflowItemIngest) -> StorageResult<WorkflowItem> {
        Err(StorageError::OperationFailed(
            "workflow store disabled (WORKFLOW_ENABLED=false)".into(),
        ))
    }

    async fn list_for_recipient(
        &self,
        _recipient: &str,
        _status: Option<&str>,
        _item_type: Option<&str>,
        _cursor: Option<Uuid>,
        _limit: i64,
    ) -> StorageResult<Vec<WorkflowItem>> {
        Ok(vec![])
    }

    async fn get_by_id(
        &self,
        _id: Uuid,
        _recipient: &str,
    ) -> StorageResult<Option<WorkflowItem>> {
        Ok(None)
    }

    async fn transition_status(
        &self,
        _id: Uuid,
        _recipient: &str,
        _new_status: &str,
        _actioned_by: Option<&str>,
    ) -> StorageResult<Option<WorkflowItem>> {
        Ok(None)
    }

    async fn open_count(&self, _recipient: &str) -> StorageResult<i64> {
        Ok(0)
    }

    async fn transition_by_idempotency(
        &self,
        _idempotency_key: &str,
        _new_status: &str,
        _actioned_by: Option<&str>,
        _patch: WorkflowTransitionPatch,
    ) -> StorageResult<Option<WorkflowItem>> {
        Ok(None)
    }
}

pub struct InMemoryWorkflowStore {
    items: RwLock<HashMap<Uuid, WorkflowItem>>,
    by_key: RwLock<HashMap<String, Uuid>>,
}

impl InMemoryWorkflowStore {
    pub fn new() -> Self {
        Self {
            items: RwLock::new(HashMap::new()),
            by_key: RwLock::new(HashMap::new()),
        }
    }

    fn row_from_ingest(ingest: &WorkflowItemIngest) -> WorkflowItem {
        let now = Utc::now();
        WorkflowItem {
            id: Uuid::new_v4(),
            idempotency_key: ingest.idempotency_key.clone(),
            recipient_address: ingest.recipient_address.clone(),
            item_type: ingest.item_type.clone(),
            status: STATUS_OPEN.to_string(),
            title: ingest.title.clone(),
            body: ingest.body.clone(),
            payload: ingest.payload.clone(),
            organization_id: ingest.organization_id.clone(),
            account_id: ingest.account_id.clone(),
            source_service: ingest.source_service.clone(),
            action_deadline_ms: ingest.action_deadline_ms,
            conversation_ref: ingest.conversation_ref.clone(),
            created_at: now,
            updated_at: now,
            actioned_by: None,
            actioned_at: None,
        }
    }
}

impl Default for InMemoryWorkflowStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WorkflowStore for InMemoryWorkflowStore {
    async fn upsert_ingest(&self, ingest: &WorkflowItemIngest) -> StorageResult<WorkflowItem> {
        let mut by_key = self.by_key.write().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?;
        if let Some(existing_id) = by_key.get(&ingest.idempotency_key) {
            let mut items = self.items.write().map_err(|e| {
                StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
            })?;
            if let Some(row) = items.get_mut(existing_id) {
                row.title = ingest.title.clone();
                row.body = ingest.body.clone();
                row.payload = ingest.payload.clone();
                row.action_deadline_ms = ingest.action_deadline_ms;
                row.updated_at = Utc::now();
                return Ok(row.clone());
            }
        }
        let row = Self::row_from_ingest(ingest);
        by_key.insert(row.idempotency_key.clone(), row.id);
        self.items.write().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?.insert(row.id, row.clone());
        Ok(row)
    }

    async fn list_for_recipient(
        &self,
        recipient: &str,
        status: Option<&str>,
        item_type: Option<&str>,
        cursor: Option<Uuid>,
        limit: i64,
    ) -> StorageResult<Vec<WorkflowItem>> {
        let items = self.items.read().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?;
        let mut rows: Vec<_> = items
            .values()
            .filter(|r| r.recipient_address == recipient)
            .filter(|r| status.is_none_or(|s| r.status == s))
            .filter(|r| item_type.is_none_or(|t| r.item_type == t))
            .filter(|r| cursor.is_none_or(|c| r.id < c))
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn get_by_id(&self, id: Uuid, recipient: &str) -> StorageResult<Option<WorkflowItem>> {
        let items = self.items.read().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?;
        Ok(items
            .get(&id)
            .filter(|r| r.recipient_address == recipient)
            .cloned())
    }

    async fn transition_status(
        &self,
        id: Uuid,
        recipient: &str,
        new_status: &str,
        actioned_by: Option<&str>,
    ) -> StorageResult<Option<WorkflowItem>> {
        let mut items = self.items.write().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?;
        let Some(row) = items.get_mut(&id) else {
            return Ok(None);
        };
        if row.recipient_address != recipient {
            return Ok(None);
        }
        row.status = new_status.to_string();
        row.updated_at = Utc::now();
        row.actioned_by = actioned_by.map(str::to_string);
        row.actioned_at = Some(Utc::now());
        Ok(Some(row.clone()))
    }

    async fn open_count(&self, recipient: &str) -> StorageResult<i64> {
        let items = self.items.read().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?;
        Ok(items
            .values()
            .filter(|r| r.recipient_address == recipient && r.status == STATUS_OPEN)
            .count() as i64)
    }

    async fn transition_by_idempotency(
        &self,
        idempotency_key: &str,
        new_status: &str,
        actioned_by: Option<&str>,
        patch: WorkflowTransitionPatch,
    ) -> StorageResult<Option<WorkflowItem>> {
        let id = {
            let by_key = self.by_key.read().map_err(|e| {
                StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
            })?;
            by_key.get(idempotency_key).copied()
        };
        let Some(id) = id else {
            return Ok(None);
        };
        let mut items = self.items.write().map_err(|e| {
            StorageError::OperationFailed(format!("workflow store lock poisoned: {e}"))
        })?;
        let Some(row) = items.get_mut(&id) else {
            return Ok(None);
        };
        if row.status != STATUS_OPEN {
            return Ok(None);
        }
        row.status = new_status.to_string();
        row.updated_at = Utc::now();
        row.actioned_by = actioned_by.map(str::to_string);
        row.actioned_at = Some(Utc::now());
        if let Some(org_id) = patch.organization_id {
            if row.organization_id.is_none() {
                row.organization_id = Some(org_id);
            }
        }
        if let Some(payload_patch) = patch.payload_patch {
            merge_json_payload(&mut row.payload, &payload_patch);
        }
        Ok(Some(row.clone()))
    }
}

pub struct PostgresWorkflowStore {
    pool: PgPool,
}

impl PostgresWorkflowStore {
    pub async fn connect(database_url: &str) -> Result<Arc<Self>, String> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .map_err(|e| e.to_string())?;
        crate::storage::migrations::run_migrations(&pool)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Self { pool }))
    }

    async fn notify_created(&self, item: &WorkflowItem) -> StorageResult<()> {
        notify_workflow_item_event(
            &self.pool,
            WorkflowItemWireEvent {
                event_type: WORKFLOW_ITEM_CREATED_EVENT_TYPE.to_string(),
                wallet: item.recipient_address.clone(),
                item_id: item.id,
                item_type: item.item_type.clone(),
                status: item.status.clone(),
            },
        )
        .await
        .map_err(|e| StorageError::OperationFailed(e))
    }

    async fn notify_updated(&self, item: &WorkflowItem) -> StorageResult<()> {
        notify_workflow_item_event(
            &self.pool,
            WorkflowItemUpdatedEvent {
                event_type: WORKFLOW_ITEM_UPDATED_EVENT_TYPE.to_string(),
                wallet: item.recipient_address.clone(),
                item_id: item.id,
                item_type: item.item_type.clone(),
                status: item.status.clone(),
            },
        )
        .await
        .map_err(|e| StorageError::OperationFailed(e))
    }
}

#[derive(sqlx::FromRow)]
struct WorkflowItemRow {
    id: Uuid,
    idempotency_key: String,
    recipient_address: String,
    item_type: String,
    status: String,
    title: String,
    body: Option<String>,
    payload: serde_json::Value,
    organization_id: Option<String>,
    account_id: Option<String>,
    source_service: String,
    action_deadline_ms: Option<i64>,
    conversation_ref: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    actioned_by: Option<String>,
    actioned_at: Option<DateTime<Utc>>,
}

impl From<WorkflowItemRow> for WorkflowItem {
    fn from(row: WorkflowItemRow) -> Self {
        WorkflowItem {
            id: row.id,
            idempotency_key: row.idempotency_key,
            recipient_address: row.recipient_address,
            item_type: row.item_type,
            status: row.status,
            title: row.title,
            body: row.body,
            payload: row.payload,
            organization_id: row.organization_id,
            account_id: row.account_id,
            source_service: row.source_service,
            action_deadline_ms: row.action_deadline_ms,
            conversation_ref: row.conversation_ref,
            created_at: row.created_at,
            updated_at: row.updated_at,
            actioned_by: row.actioned_by,
            actioned_at: row.actioned_at,
        }
    }
}

#[async_trait]
impl WorkflowStore for PostgresWorkflowStore {
    async fn upsert_ingest(&self, ingest: &WorkflowItemIngest) -> StorageResult<WorkflowItem> {
        let row: WorkflowItemRow = sqlx::query_as(
            r#"INSERT INTO workflow_items (
                idempotency_key, recipient_address, item_type, status, title, body, payload,
                organization_id, account_id, source_service, action_deadline_ms, conversation_ref
            ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (idempotency_key) DO UPDATE SET
                title = EXCLUDED.title,
                body = EXCLUDED.body,
                payload = EXCLUDED.payload,
                action_deadline_ms = EXCLUDED.action_deadline_ms,
                updated_at = NOW()
            RETURNING id, idempotency_key, recipient_address, item_type, status, title, body,
                      payload, organization_id, account_id, source_service, action_deadline_ms,
                      conversation_ref, created_at, updated_at, actioned_by, actioned_at"#,
        )
        .bind(&ingest.idempotency_key)
        .bind(&ingest.recipient_address)
        .bind(&ingest.item_type)
        .bind(&ingest.title)
        .bind(&ingest.body)
        .bind(&ingest.payload)
        .bind(&ingest.organization_id)
        .bind(&ingest.account_id)
        .bind(&ingest.source_service)
        .bind(ingest.action_deadline_ms)
        .bind(&ingest.conversation_ref)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        let item: WorkflowItem = row.into();
        self.notify_created(&item).await?;
        Ok(item)
    }

    async fn list_for_recipient(
        &self,
        recipient: &str,
        status: Option<&str>,
        item_type: Option<&str>,
        cursor: Option<Uuid>,
        limit: i64,
    ) -> StorageResult<Vec<WorkflowItem>> {
        let rows: Vec<WorkflowItemRow> = sqlx::query_as(
            r#"SELECT id, idempotency_key, recipient_address, item_type, status, title, body,
                      payload, organization_id, account_id, source_service, action_deadline_ms,
                      conversation_ref, created_at, updated_at, actioned_by, actioned_at
               FROM workflow_items
               WHERE recipient_address = $1
                 AND ($2::text IS NULL OR status = $2)
                 AND ($3::text IS NULL OR item_type = $3)
                 AND ($4::uuid IS NULL OR id < $4)
               ORDER BY created_at DESC
               LIMIT $5"#,
        )
        .bind(recipient)
        .bind(status)
        .bind(item_type)
        .bind(cursor)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(rows.into_iter().map(WorkflowItem::from).collect())
    }

    async fn get_by_id(&self, id: Uuid, recipient: &str) -> StorageResult<Option<WorkflowItem>> {
        let row: Option<WorkflowItemRow> = sqlx::query_as(
            r#"SELECT id, idempotency_key, recipient_address, item_type, status, title, body,
                      payload, organization_id, account_id, source_service, action_deadline_ms,
                      conversation_ref, created_at, updated_at, actioned_by, actioned_at
               FROM workflow_items WHERE id = $1 AND recipient_address = $2"#,
        )
        .bind(id)
        .bind(recipient)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(row.map(WorkflowItem::from))
    }

    async fn transition_status(
        &self,
        id: Uuid,
        recipient: &str,
        new_status: &str,
        actioned_by: Option<&str>,
    ) -> StorageResult<Option<WorkflowItem>> {
        let row: Option<WorkflowItemRow> = sqlx::query_as(
            r#"UPDATE workflow_items SET
                status = $3,
                actioned_by = $4,
                actioned_at = NOW(),
                updated_at = NOW()
               WHERE id = $1 AND recipient_address = $2
               RETURNING id, idempotency_key, recipient_address, item_type, status, title, body,
                         payload, organization_id, account_id, source_service, action_deadline_ms,
                         conversation_ref, created_at, updated_at, actioned_by, actioned_at"#,
        )
        .bind(id)
        .bind(recipient)
        .bind(new_status)
        .bind(actioned_by)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        if let Some(item) = row.map(WorkflowItem::from) {
            self.notify_updated(&item).await?;
            return Ok(Some(item));
        }
        Ok(None)
    }

    async fn open_count(&self, recipient: &str) -> StorageResult<i64> {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)::bigint FROM workflow_items WHERE recipient_address = $1 AND status = 'open'",
        )
        .bind(recipient)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(count)
    }

    async fn transition_by_idempotency(
        &self,
        idempotency_key: &str,
        new_status: &str,
        actioned_by: Option<&str>,
        patch: WorkflowTransitionPatch,
    ) -> StorageResult<Option<WorkflowItem>> {
        let row: Option<WorkflowItemRow> = sqlx::query_as(
            r#"UPDATE workflow_items SET
                status = $2,
                actioned_by = $3,
                actioned_at = NOW(),
                updated_at = NOW(),
                payload = COALESCE(payload, '{}'::jsonb) || COALESCE($4, '{}'::jsonb),
                organization_id = COALESCE(organization_id, $5)
               WHERE idempotency_key = $1 AND status = 'open'
               RETURNING id, idempotency_key, recipient_address, item_type, status, title, body,
                         payload, organization_id, account_id, source_service, action_deadline_ms,
                         conversation_ref, created_at, updated_at, actioned_by, actioned_at"#,
        )
        .bind(idempotency_key)
        .bind(new_status)
        .bind(actioned_by)
        .bind(patch.payload_patch)
        .bind(patch.organization_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        if let Some(item) = row.map(WorkflowItem::from) {
            self.notify_updated(&item).await?;
            return Ok(Some(item));
        }
        Ok(None)
    }
}

pub async fn create_workflow_store_async(
    store_type: MembershipStoreType,
    database_url: Option<&str>,
    enabled: bool,
) -> Arc<dyn WorkflowStore> {
    if !enabled {
        return Arc::new(NoOpWorkflowStore);
    }
    match store_type {
        MembershipStoreType::InMemory => Arc::new(InMemoryWorkflowStore::new()),
        MembershipStoreType::Postgres => {
            let url = database_url.expect("DATABASE_URL required for postgres workflow store");
            PostgresWorkflowStore::connect(url)
                .await
                .expect("failed to connect workflow postgres store")
        }
    }
}
