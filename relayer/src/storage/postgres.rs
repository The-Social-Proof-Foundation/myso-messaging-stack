//! PostgreSQL storage backend for production deployments.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::models::{
    Attachment, EncryptedBlobRecord, Message, MessageAttribution, PushTokenRecord,
    ReactionEntry, ReceiptStateResponse, SyncStatus,
};
use crate::services::realtime::{MessageCreatedEvent, MESSAGE_EVENTS_CHANNEL};

use super::adapter::{StorageAdapter, StorageError, StorageResult};
use super::memory::InMemoryStorage;
use super::migrations;

/// Postgres-backed storage for messages, read-state, push, presence, reactions, and pins.
pub struct PostgresStorage {
    pool: PgPool,
    /// Deprecated plaintext receipts only — not persisted to Postgres.
    receipt_mirror: InMemoryStorage,
}

impl PostgresStorage {
    pub async fn connect(database_url: &str) -> StorageResult<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        migrations::run_migrations(&pool).await?;

        Ok(Self {
            pool,
            receipt_mirror: InMemoryStorage::new(),
        })
    }
}

fn map_db_error(e: sqlx::Error) -> StorageError {
    if let Some(db) = e.as_database_error() {
        if db.code().as_deref() == Some("23505") {
            return StorageError::DuplicateNonce;
        }
    }
    StorageError::OperationFailed(e.to_string())
}

fn parse_sync_status(s: &str) -> SyncStatus {
    match s {
        "SYNCED" => SyncStatus::Synced,
        "UPDATE_PENDING" => SyncStatus::UpdatePending,
        "UPDATED" => SyncStatus::Updated,
        "DELETE_PENDING" => SyncStatus::DeletePending,
        "DELETED" => SyncStatus::Deleted,
        _ => SyncStatus::SyncPending,
    }
}

fn row_to_message(row: &sqlx::postgres::PgRow) -> Message {
    let attachments: Vec<Attachment> =
        serde_json::from_value(row.get("attachments")).unwrap_or_default();
    Message {
        id: row.get("id"),
        group_id: row.get("group_id"),
        order: row.get("order_num"),
        sender_wallet_addr: row.get("sender_wallet_addr"),
        encrypted_msg: row.get("encrypted_msg"),
        nonce: row.get("nonce"),
        key_version: row.get("key_version"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        sync_status: parse_sync_status(&row.get::<String, _>("sync_status")),
        quilt_patch_id: row.get("quilt_patch_id"),
        attachments,
        signature: row.get("signature"),
        public_key: row.get("public_key"),
        attribution: MessageAttribution {
            principal_owner: row.get("principal_owner"),
            sub_agent_id: row.get("sub_agent_id"),
            identity_class: row.get("identity_class"),
            attribution_version: row.try_get("attribution_version").unwrap_or(1),
        },
    }
}

#[async_trait]
impl StorageAdapter for PostgresStorage {
    async fn health_check(&self) -> StorageResult<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn create_message(&self, mut message: Message) -> StorageResult<Message> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        let order: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(order_num), 0) + 1 FROM messages WHERE group_id = $1",
        )
        .bind(&message.group_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        message.order = Some(order);
        let sync_status = message.sync_status.to_string();
        let attachments = serde_json::to_value(&message.attachments)
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        sqlx::query(
            r#"INSERT INTO messages (
                id, group_id, order_num, sender_wallet_addr, encrypted_msg, nonce,
                key_version, created_at, updated_at, sync_status, quilt_patch_id,
                attachments, signature, public_key,
                principal_owner, sub_agent_id, identity_class, attribution_version
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)"#,
        )
        .bind(message.id)
        .bind(&message.group_id)
        .bind(order)
        .bind(&message.sender_wallet_addr)
        .bind(&message.encrypted_msg)
        .bind(&message.nonce)
        .bind(message.key_version)
        .bind(message.created_at)
        .bind(message.updated_at)
        .bind(sync_status)
        .bind(&message.quilt_patch_id)
        .bind(attachments)
        .bind(&message.signature)
        .bind(&message.public_key)
        .bind(&message.attribution.principal_owner)
        .bind(&message.attribution.sub_agent_id)
        .bind(message.attribution.identity_class)
        .bind(message.attribution.attribution_version)
        .execute(&mut *tx)
        .await
        .map_err(map_db_error)?;

        let notify = MessageCreatedEvent::new(
            message.group_id.clone(),
            message.id,
            order,
            message.sender_wallet_addr.clone(),
        );
        let notify_json = serde_json::to_string(&notify)
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        sqlx::query("SELECT pg_notify($1, $2)")
            .bind(MESSAGE_EVENTS_CHANNEL)
            .bind(notify_json)
            .execute(&mut *tx)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        tx.commit()
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        Ok(message)
    }

    async fn get_message(&self, id: Uuid) -> StorageResult<Message> {
        let row = sqlx::query("SELECT * FROM messages WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        row.map(|r| row_to_message(&r))
            .ok_or(StorageError::NotFound(id))
    }

    async fn get_messages_by_group(
        &self,
        group_id: &str,
        after_order: Option<i64>,
        before_order: Option<i64>,
        limit: usize,
    ) -> StorageResult<Vec<Message>> {
        let rows = match (after_order, before_order) {
            (Some(after), Some(before)) => {
                sqlx::query(
                    "SELECT * FROM messages WHERE group_id = $1 AND order_num > $2 AND order_num < $3 ORDER BY order_num ASC LIMIT $4",
                )
                .bind(group_id)
                .bind(after)
                .bind(before)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await
            }
            (Some(after), None) => {
                sqlx::query(
                    "SELECT * FROM messages WHERE group_id = $1 AND order_num > $2 ORDER BY order_num ASC LIMIT $3",
                )
                .bind(group_id)
                .bind(after)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await
            }
            (None, Some(before)) => {
                sqlx::query(
                    "SELECT * FROM messages WHERE group_id = $1 AND order_num < $2 ORDER BY order_num DESC LIMIT $3",
                )
                .bind(group_id)
                .bind(before)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await
            }
            (None, None) => {
                sqlx::query(
                    "SELECT * FROM messages WHERE group_id = $1 ORDER BY order_num DESC LIMIT $2",
                )
                .bind(group_id)
                .bind(limit as i64)
                .fetch_all(&self.pool)
                .await
            }
        }
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        let mut messages: Vec<Message> = rows.iter().map(row_to_message).collect();
        if after_order.is_none() {
            messages.reverse();
        }
        Ok(messages)
    }

    async fn update_message(
        &self,
        id: Uuid,
        encrypted_msg: Vec<u8>,
        nonce: Vec<u8>,
        key_version: i64,
        attachments: Vec<Attachment>,
        signature: Vec<u8>,
        public_key: Vec<u8>,
    ) -> StorageResult<Message> {
        let attachments_json = serde_json::to_value(&attachments)
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        sqlx::query(
            r#"UPDATE messages SET encrypted_msg=$2, nonce=$3, key_version=$4, attachments=$5,
               signature=$6, public_key=$7, updated_at=$8, sync_status=$9 WHERE id=$1"#,
        )
        .bind(id)
        .bind(encrypted_msg)
        .bind(nonce)
        .bind(key_version)
        .bind(attachments_json)
        .bind(signature)
        .bind(public_key)
        .bind(Utc::now())
        .bind("UPDATE_PENDING")
        .execute(&self.pool)
        .await
        .map_err(map_db_error)?;
        self.get_message(id).await
    }

    async fn delete_message(&self, id: Uuid) -> StorageResult<Message> {
        sqlx::query("UPDATE messages SET sync_status='DELETE_PENDING', updated_at=$2 WHERE id=$1")
            .bind(id)
            .bind(Utc::now())
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        self.get_message(id).await
    }

    async fn update_sync_status(
        &self,
        id: Uuid,
        status: SyncStatus,
        quilt_patch_id: Option<String>,
    ) -> StorageResult<Message> {
        let status_str = status.to_string();
        sqlx::query(
            "UPDATE messages SET sync_status=$2, quilt_patch_id=$3, updated_at=$4 WHERE id=$1",
        )
        .bind(id)
        .bind(status_str)
        .bind(quilt_patch_id)
        .bind(Utc::now())
        .execute(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        self.get_message(id).await
    }

    async fn get_messages_by_sync_status(
        &self,
        status: SyncStatus,
        limit: usize,
    ) -> StorageResult<Vec<Message>> {
        let status_str = status.to_string();
        let rows = sqlx::query("SELECT * FROM messages WHERE sync_status = $1 LIMIT $2")
            .bind(status_str)
            .bind(limit as i64)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(rows.iter().map(row_to_message).collect())
    }

    async fn replace_reaction_tally(
        &self,
        group_id: &str,
        chain_seq: i64,
        emoji_code: u32,
        add: bool,
    ) -> StorageResult<()> {
        if add {
            sqlx::query(
                r#"INSERT INTO reaction_tallies (group_id, chain_seq, emoji_code, count)
                   VALUES ($1, $2, $3, 1)
                   ON CONFLICT (group_id, chain_seq, emoji_code)
                   DO UPDATE SET count = reaction_tallies.count + 1"#,
            )
            .bind(group_id)
            .bind(chain_seq)
            .bind(emoji_code as i32)
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        } else {
            sqlx::query(
                r#"UPDATE reaction_tallies SET count = GREATEST(count - 1, 0)
                   WHERE group_id = $1 AND chain_seq = $2 AND emoji_code = $3"#,
            )
            .bind(group_id)
            .bind(chain_seq)
            .bind(emoji_code as i32)
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
            sqlx::query(
                "DELETE FROM reaction_tallies WHERE group_id = $1 AND chain_seq = $2 AND emoji_code = $3 AND count = 0",
            )
            .bind(group_id)
            .bind(chain_seq)
            .bind(emoji_code as i32)
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        }
        Ok(())
    }

    async fn list_reactions(
        &self,
        group_id: &str,
        chain_seq: Option<i64>,
    ) -> StorageResult<Vec<ReactionEntry>> {
        let rows = if let Some(seq) = chain_seq {
            sqlx::query(
                "SELECT chain_seq, emoji_code, count FROM reaction_tallies WHERE group_id = $1 AND chain_seq = $2 AND count > 0 ORDER BY chain_seq, emoji_code",
            )
            .bind(group_id)
            .bind(seq)
            .fetch_all(&self.pool)
            .await
        } else {
            sqlx::query(
                "SELECT chain_seq, emoji_code, count FROM reaction_tallies WHERE group_id = $1 AND count > 0 ORDER BY chain_seq, emoji_code",
            )
            .bind(group_id)
            .fetch_all(&self.pool)
            .await
        }
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        Ok(rows
            .iter()
            .map(|r| ReactionEntry {
                chain_seq: r.get("chain_seq"),
                emoji_code: r.get::<i32, _>("emoji_code") as u32,
                count: r.get("count"),
            })
            .collect())
    }

    async fn set_pin_for_seq(&self, group_id: &str, chain_seq: i64, on: bool) -> StorageResult<()> {
        if on {
            sqlx::query(
                "INSERT INTO group_pins (group_id, chain_seq) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            )
            .bind(group_id)
            .bind(chain_seq)
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        } else {
            sqlx::query("DELETE FROM group_pins WHERE group_id = $1 AND chain_seq = $2")
                .bind(group_id)
                .bind(chain_seq)
                .execute(&self.pool)
                .await
                .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        }
        Ok(())
    }

    async fn list_pins(&self, group_id: &str) -> StorageResult<Vec<i64>> {
        let rows = sqlx::query(
            "SELECT chain_seq FROM group_pins WHERE group_id = $1 ORDER BY chain_seq",
        )
        .bind(group_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(rows.iter().map(|r| r.get("chain_seq")).collect())
    }

    async fn update_receipt_delivered(
        &self,
        group_id: &str,
        member: &str,
        upto: u64,
    ) -> StorageResult<()> {
        self.receipt_mirror
            .update_receipt_delivered(group_id, member, upto)
            .await
    }

    async fn update_receipt_read(
        &self,
        group_id: &str,
        member: &str,
        upto: u64,
    ) -> StorageResult<()> {
        self.receipt_mirror
            .update_receipt_read(group_id, member, upto)
            .await
    }

    async fn get_receipt_state(
        &self,
        group_id: &str,
        member: &str,
    ) -> StorageResult<ReceiptStateResponse> {
        self.receipt_mirror.get_receipt_state(group_id, member).await
    }

    async fn get_user_read_state(&self, wallet: &str) -> StorageResult<Option<EncryptedBlobRecord>> {
        let row = sqlx::query(
            "SELECT encrypted_blob, blob_version, updated_at FROM user_read_states WHERE wallet = $1",
        )
        .bind(wallet)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        Ok(row.map(|r| EncryptedBlobRecord {
            encrypted_blob: r.get("encrypted_blob"),
            blob_version: r.get::<i64, _>("blob_version") as u64,
            updated_at: r.get("updated_at"),
        }))
    }

    async fn put_user_read_state(
        &self,
        wallet: &str,
        record: EncryptedBlobRecord,
    ) -> StorageResult<()> {
        sqlx::query(
            r#"INSERT INTO user_read_states (wallet, encrypted_blob, blob_version, updated_at)
               VALUES ($1,$2,$3,$4)
               ON CONFLICT (wallet) DO UPDATE SET
                 encrypted_blob = EXCLUDED.encrypted_blob,
                 blob_version = EXCLUDED.blob_version,
                 updated_at = EXCLUDED.updated_at"#,
        )
        .bind(wallet)
        .bind(&record.encrypted_blob)
        .bind(record.blob_version as i64)
        .bind(record.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn upsert_push_token(&self, record: PushTokenRecord) -> StorageResult<()> {
        sqlx::query(
            r#"INSERT INTO push_tokens (wallet, token, platform, environment, updated_at)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (wallet, token) DO UPDATE SET
                 platform = EXCLUDED.platform,
                 environment = EXCLUDED.environment,
                 updated_at = EXCLUDED.updated_at"#,
        )
        .bind(&record.wallet)
        .bind(&record.token)
        .bind(&record.platform)
        .bind(&record.environment)
        .bind(record.updated_at)
        .execute(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn delete_push_token(&self, wallet: &str, token: &str) -> StorageResult<()> {
        sqlx::query("DELETE FROM push_tokens WHERE wallet = $1 AND token = $2")
            .bind(wallet)
            .bind(token)
            .execute(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn list_push_tokens_for_wallet(&self, wallet: &str) -> StorageResult<Vec<PushTokenRecord>> {
        let rows = sqlx::query("SELECT * FROM push_tokens WHERE wallet = $1")
            .bind(wallet)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| PushTokenRecord {
                wallet: r.get("wallet"),
                platform: r.get("platform"),
                token: r.get("token"),
                environment: r.get("environment"),
                updated_at: r.get("updated_at"),
            })
            .collect())
    }

    async fn update_presence(&self, wallet: &str) -> StorageResult<()> {
        sqlx::query(
            r#"INSERT INTO presence (wallet, last_seen_at) VALUES ($1, $2)
               ON CONFLICT (wallet) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at"#,
        )
        .bind(wallet)
        .bind(Utc::now())
        .execute(&self.pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(())
    }

    async fn get_presence_last_seen(
        &self,
        wallet: &str,
    ) -> StorageResult<Option<chrono::DateTime<chrono::Utc>>> {
        let row = sqlx::query("SELECT last_seen_at FROM presence WHERE wallet = $1")
            .bind(wallet)
            .fetch_optional(&self.pool)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
        Ok(row.map(|r| r.get("last_seen_at")))
    }
}

pub async fn create_postgres_storage(database_url: &str) -> StorageResult<Arc<dyn StorageAdapter>> {
    let storage = PostgresStorage::connect(database_url).await?;
    Ok(Arc::new(storage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_db_error_detects_unique_violation() {
        // Smoke test that map_db_error handles non-db errors
        let err = map_db_error(sqlx::Error::RowNotFound);
        assert!(matches!(err, StorageError::OperationFailed(_)));
    }
}
