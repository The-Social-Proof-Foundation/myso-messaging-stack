//! Storage for agent-associated messaging groups discovered from chain events.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::auth::MembershipStoreType;
use crate::models::AgentMessagingGroup;

use super::adapter::{StorageError, StorageResult};

#[async_trait]
pub trait AgentGroupStore: Send + Sync {
    async fn upsert_agent_group(&self, group: &AgentMessagingGroup) -> StorageResult<()>;

    async fn list_by_principal(
        &self,
        principal: &str,
        limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>>;

    async fn list_by_creator_actor(
        &self,
        creator_actor: &str,
        limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>>;
}

pub struct NoOpAgentGroupStore;

/// In-memory agent group index for local dev (paired with MEMBERSHIP_STORE_TYPE=memory).
pub struct InMemoryAgentGroupStore {
    groups: RwLock<HashMap<String, AgentMessagingGroup>>,
}

impl InMemoryAgentGroupStore {
    pub fn new() -> Self {
        Self {
            groups: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for InMemoryAgentGroupStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentGroupStore for InMemoryAgentGroupStore {
    async fn upsert_agent_group(&self, group: &AgentMessagingGroup) -> StorageResult<()> {
        let mut groups = self.groups.write().map_err(|e| {
            StorageError::OperationFailed(format!("InMemoryAgentGroupStore lock poisoned: {e}"))
        })?;
        groups
            .entry(group.group_id.clone())
            .or_insert_with(|| group.clone());
        Ok(())
    }

    async fn list_by_principal(
        &self,
        principal: &str,
        limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>> {
        let groups = self.groups.read().map_err(|e| {
            StorageError::OperationFailed(format!("InMemoryAgentGroupStore lock poisoned: {e}"))
        })?;
        let mut rows: Vec<_> = groups
            .values()
            .filter(|g| g.creator_principal == principal)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }

    async fn list_by_creator_actor(
        &self,
        creator_actor: &str,
        limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>> {
        let groups = self.groups.read().map_err(|e| {
            StorageError::OperationFailed(format!("InMemoryAgentGroupStore lock poisoned: {e}"))
        })?;
        let mut rows: Vec<_> = groups
            .values()
            .filter(|g| g.creator_actor == creator_actor)
            .cloned()
            .collect();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        rows.truncate(limit as usize);
        Ok(rows)
    }
}

#[async_trait]
impl AgentGroupStore for NoOpAgentGroupStore {
    async fn upsert_agent_group(&self, _group: &AgentMessagingGroup) -> StorageResult<()> {
        Ok(())
    }

    async fn list_by_principal(
        &self,
        _principal: &str,
        _limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>> {
        Ok(vec![])
    }

    async fn list_by_creator_actor(
        &self,
        _creator_actor: &str,
        _limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>> {
        Ok(vec![])
    }
}

pub struct PostgresAgentGroupStore {
    pool: PgPool,
}

impl PostgresAgentGroupStore {
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
}

#[async_trait]
impl AgentGroupStore for PostgresAgentGroupStore {
    async fn upsert_agent_group(&self, group: &AgentMessagingGroup) -> StorageResult<()> {
        sqlx::query(
            r#"INSERT INTO agent_messaging_groups (
                group_id, creator_actor, creator_principal,
                creator_sub_agent_id, creator_identity_class,
                organization_id, group_name, group_uuid, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (group_id) DO NOTHING"#,
        )
        .bind(&group.group_id)
        .bind(&group.creator_actor)
        .bind(&group.creator_principal)
        .bind(&group.creator_sub_agent_id)
        .bind(group.creator_identity_class)
        .bind(&group.organization_id)
        .bind(&group.group_name)
        .bind(&group.group_uuid)
        .bind(group.created_at)
        .execute(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        Ok(())
    }

    async fn list_by_principal(
        &self,
        principal: &str,
        limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>> {
        let rows = sqlx::query_as::<_, AgentGroupRow>(
            r#"SELECT group_id, creator_actor, creator_principal,
                      creator_sub_agent_id, creator_identity_class,
                      organization_id, group_name, group_uuid, created_at
               FROM agent_messaging_groups
               WHERE creator_principal = $1
               ORDER BY created_at DESC
               LIMIT $2"#,
        )
        .bind(principal)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn list_by_creator_actor(
        &self,
        creator_actor: &str,
        limit: i64,
    ) -> StorageResult<Vec<AgentMessagingGroup>> {
        let rows = sqlx::query_as::<_, AgentGroupRow>(
            r#"SELECT group_id, creator_actor, creator_principal,
                      creator_sub_agent_id, creator_identity_class,
                      organization_id, group_name, group_uuid, created_at
               FROM agent_messaging_groups
               WHERE creator_actor = $1
               ORDER BY created_at DESC
               LIMIT $2"#,
        )
        .bind(creator_actor)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        Ok(rows.into_iter().map(Into::into).collect())
    }
}

#[derive(sqlx::FromRow)]
struct AgentGroupRow {
    group_id: String,
    creator_actor: String,
    creator_principal: String,
    creator_sub_agent_id: Option<String>,
    creator_identity_class: Option<i16>,
    organization_id: Option<String>,
    group_name: Option<String>,
    group_uuid: Option<String>,
    created_at: DateTime<Utc>,
}

impl From<AgentGroupRow> for AgentMessagingGroup {
    fn from(row: AgentGroupRow) -> Self {
        Self {
            group_id: row.group_id,
            creator_actor: row.creator_actor,
            creator_principal: row.creator_principal,
            creator_sub_agent_id: row.creator_sub_agent_id,
            creator_identity_class: row.creator_identity_class,
            organization_id: row.organization_id,
            group_name: row.group_name,
            group_uuid: row.group_uuid,
            created_at: row.created_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_store_round_trip() {
        let store = InMemoryAgentGroupStore::new();
        let group = AgentMessagingGroup {
            group_id: "0xgroup".to_string(),
            creator_actor: "0xagent".to_string(),
            creator_principal: "0xprincipal".to_string(),
            creator_sub_agent_id: Some("0xsub".to_string()),
            creator_identity_class: Some(1),
            organization_id: Some("0xorg".to_string()),
            group_name: Some("Support".to_string()),
            group_uuid: Some("uuid".to_string()),
            created_at: Utc::now(),
        };

        store.upsert_agent_group(&group).await.unwrap();
        let by_principal = store.list_by_principal("0xprincipal", 10).await.unwrap();
        assert_eq!(by_principal.len(), 1);
        assert_eq!(by_principal[0].group_name.as_deref(), Some("Support"));

        let by_agent = store.list_by_creator_actor("0xagent", 10).await.unwrap();
        assert_eq!(by_agent.len(), 1);
    }
}

pub async fn create_agent_group_store_async(
    store_type: MembershipStoreType,
    database_url: Option<&str>,
) -> Arc<dyn AgentGroupStore> {
    match store_type {
        MembershipStoreType::InMemory => Arc::new(InMemoryAgentGroupStore::new()),
        MembershipStoreType::Postgres => {
            let url = database_url
                .expect("DATABASE_URL required when MEMBERSHIP_STORE_TYPE=postgres");
            PostgresAgentGroupStore::connect(url)
                .await
                .expect("Failed to connect Postgres agent group store")
        }
    }
}
