//! PostgreSQL-backed membership store with in-memory read cache and durable writes.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use chrono::Utc;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tracing::{error, info, warn};

use super::membership::{InMemoryMembershipStore, MembershipError, MembershipStore};
use super::permissions::MessagingPermission;

/// Postgres membership store: loads snapshot on connect, persists mutations to PG.
pub struct PostgresMembershipStore {
    inner: InMemoryMembershipStore,
    pool: PgPool,
}

impl PostgresMembershipStore {
    pub async fn connect(database_url: &str) -> Result<Arc<Self>, String> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await
            .map_err(|e| e.to_string())?;

        crate::storage::migrations::run_migrations(&pool)
            .await
            .map_err(|e| e.to_string())?;

        let store = Self {
            inner: InMemoryMembershipStore::new(),
            pool,
        };
        store.load_from_db().await?;
        Ok(Arc::new(store))
    }

    async fn load_from_db(&self) -> Result<(), String> {
        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT group_id, address, permission FROM membership_permissions",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut by_group: HashMap<String, HashMap<String, HashSet<MessagingPermission>>> =
            HashMap::new();

        for (group_id, address, permission) in rows {
            let Some(perm) = permission_from_db(&permission) else {
                warn!("Skipping unknown permission in DB: {}", permission);
                continue;
            };
            by_group
                .entry(group_id)
                .or_default()
                .entry(address)
                .or_default()
                .insert(perm);
        }

        let group_count = by_group.len();
        for (group_id, members) in by_group {
            let members_with_perms: Vec<(String, Vec<MessagingPermission>)> = members
                .into_iter()
                .map(|(address, perms)| (address, perms.into_iter().collect()))
                .collect();
            self.inner.set_group_members(&group_id, members_with_perms);
        }

        info!(
            "Loaded membership permissions from Postgres ({} groups)",
            group_count
        );
        Ok(())
    }

    fn run_db<F, T>(&self, fut: F) -> Option<T>
    where
        F: Future<Output = Result<T, sqlx::Error>>,
    {
        match tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(fut)) {
            Ok(v) => Some(v),
            Err(e) => {
                error!("Membership Postgres write failed: {}", e);
                None
            }
        }
    }

    fn persist_grant(&self, group_id: &str, address: &str, permissions: &[MessagingPermission]) {
        let pool = self.pool.clone();
        let group_id = group_id.to_string();
        let address = address.to_string();
        let perms: Vec<String> = permissions.iter().map(|p| p.as_str().to_string()).collect();
        self.run_db(async move {
            let now = Utc::now();
            for perm in perms {
                sqlx::query(
                    r#"INSERT INTO membership_permissions (group_id, address, permission, updated_at)
                       VALUES ($1, $2, $3, $4)
                       ON CONFLICT (group_id, address, permission) DO UPDATE SET updated_at = EXCLUDED.updated_at"#,
                )
                .bind(&group_id)
                .bind(&address)
                .bind(&perm)
                .bind(now)
                .execute(&pool)
                .await?;
            }
            Ok(())
        });
    }

    fn persist_revoke(&self, group_id: &str, address: &str, permissions: &[MessagingPermission]) {
        let pool = self.pool.clone();
        let group_id = group_id.to_string();
        let address = address.to_string();
        let perms: Vec<String> = permissions.iter().map(|p| p.as_str().to_string()).collect();
        self.run_db(async move {
            for perm in perms {
                sqlx::query(
                    "DELETE FROM membership_permissions WHERE group_id = $1 AND address = $2 AND permission = $3",
                )
                .bind(&group_id)
                .bind(&address)
                .bind(&perm)
                .execute(&pool)
                .await?;
            }
            Ok(())
        });
    }

    fn persist_add_member(
        &self,
        group_id: &str,
        address: &str,
        permissions: &[MessagingPermission],
    ) {
        if permissions.is_empty() {
            return;
        }
        self.persist_grant(group_id, address, permissions);
    }

    fn persist_remove_member(&self, group_id: &str, address: &str) {
        let pool = self.pool.clone();
        let group_id = group_id.to_string();
        let address = address.to_string();
        self.run_db(async move {
            sqlx::query(
                "DELETE FROM membership_permissions WHERE group_id = $1 AND address = $2",
            )
            .bind(&group_id)
            .bind(&address)
            .execute(&pool)
            .await?;
            Ok(())
        });
    }

    fn persist_set_group(&self, group_id: &str, members_with_perms: &[(String, Vec<MessagingPermission>)]) {
        let pool = self.pool.clone();
        let group_id = group_id.to_string();
        let rows: Vec<(String, String)> = members_with_perms
            .iter()
            .flat_map(|(address, perms)| {
                perms
                    .iter()
                    .map(|p| (address.clone(), p.as_str().to_string()))
            })
            .collect();
        self.run_db(async move {
            let mut tx = pool.begin().await?;
            sqlx::query("DELETE FROM membership_permissions WHERE group_id = $1")
                .bind(&group_id)
                .execute(&mut *tx)
                .await?;
            let now = Utc::now();
            for (address, perm) in rows {
                sqlx::query(
                    r#"INSERT INTO membership_permissions (group_id, address, permission, updated_at)
                       VALUES ($1, $2, $3, $4)"#,
                )
                .bind(&group_id)
                .bind(&address)
                .bind(&perm)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            Ok(())
        });
    }
}

fn permission_from_db(s: &str) -> Option<MessagingPermission> {
    match s {
        "MessagingSender" => Some(MessagingPermission::MessagingSender),
        "MessagingReader" => Some(MessagingPermission::MessagingReader),
        "MessagingEditor" => Some(MessagingPermission::MessagingEditor),
        "MessagingDeleter" => Some(MessagingPermission::MessagingDeleter),
        _ => None,
    }
}

impl MembershipStore for PostgresMembershipStore {
    fn has_permission(
        &self,
        group_id: &str,
        address: &str,
        permission: MessagingPermission,
    ) -> bool {
        self.inner.has_permission(group_id, address, permission)
    }

    fn is_member(&self, group_id: &str, address: &str) -> bool {
        self.inner.is_member(group_id, address)
    }

    fn get_permissions(&self, group_id: &str, address: &str) -> Vec<MessagingPermission> {
        self.inner.get_permissions(group_id, address)
    }

    fn grant_permissions(
        &self,
        group_id: &str,
        address: &str,
        permissions: Vec<MessagingPermission>,
    ) -> Result<(), MembershipError> {
        self.inner
            .grant_permissions(group_id, address, permissions.clone())?;
        self.persist_grant(group_id, address, &permissions);
        Ok(())
    }

    fn revoke_permissions(
        &self,
        group_id: &str,
        address: &str,
        permissions: Vec<MessagingPermission>,
    ) -> Result<(), MembershipError> {
        self.inner
            .revoke_permissions(group_id, address, permissions.clone())?;
        self.persist_revoke(group_id, address, &permissions);
        Ok(())
    }

    fn add_member(
        &self,
        group_id: &str,
        address: &str,
        initial_permissions: Vec<MessagingPermission>,
    ) {
        self.inner
            .add_member(group_id, address, initial_permissions.clone());
        self.persist_add_member(group_id, address, &initial_permissions);
    }

    fn remove_member(&self, group_id: &str, address: &str) {
        self.inner.remove_member(group_id, address);
        self.persist_remove_member(group_id, address);
    }

    fn set_group_members(
        &self,
        group_id: &str,
        members_with_perms: Vec<(String, Vec<MessagingPermission>)>,
    ) {
        self.persist_set_group(group_id, &members_with_perms);
        self.inner.set_group_members(group_id, members_with_perms);
    }

    fn list_member_addresses(&self, group_id: &str) -> Vec<String> {
        self.inner.list_member_addresses(group_id)
    }

    fn get_last_checkpoint_cursor(&self) -> Option<u64> {
        self.run_db(async {
            let row: Option<(Option<i64>,)> = sqlx::query_as(
                "SELECT last_cursor FROM membership_sync_state WHERE id = 1",
            )
            .fetch_optional(&self.pool)
            .await?;
            Ok(row.and_then(|(c,)| c.map(|v| v as u64)))
        })
        .flatten()
    }

    fn set_last_checkpoint_cursor(&self, cursor: u64) {
        let pool = self.pool.clone();
        self.run_db(async move {
            sqlx::query(
                r#"INSERT INTO membership_sync_state (id, last_cursor, updated_at)
                   VALUES (1, $1, $2)
                   ON CONFLICT (id) DO UPDATE SET last_cursor = EXCLUDED.last_cursor, updated_at = EXCLUDED.updated_at"#,
            )
            .bind(cursor as i64)
            .bind(Utc::now())
            .execute(&pool)
            .await?;
            Ok(())
        });
    }
}
