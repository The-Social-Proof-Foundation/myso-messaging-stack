//! Durable retry + dead-letter queue for push sends that fail retryably.
//!
//! The first attempt stays inline in [`super::PushService`] so delivery latency is unchanged.
//! On `ApnsSendError::Transient` the send is persisted here; [`run_retry_worker`] claims due
//! rows with `FOR UPDATE SKIP LOCKED` (safe with several relayer replicas), re-sends, and
//! settles each row: deleted on success / unregistered / recipient now active, rescheduled
//! with exponential backoff on another transient failure, `dead` once attempts run out or
//! the push has gone stale. Without Postgres (in-memory storage) retries are disabled.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use tracing::{debug, info, warn};

use super::{ApnsSendError, PushService};
use crate::models::{MessageAttribution, PushTokenRecord};
use crate::storage::StorageAdapter;

static POOL: OnceLock<PgPool> = OnceLock::new();

const MAX_BACKOFF_SECS: i64 = 300;
/// A message push older than this is noise, not news.
const STALE_AFTER_SECS: i64 = 15 * 60;
/// Leases older than this belong to a worker that died mid-send.
const STALE_LEASE_SECS: i64 = 120;
const DEAD_RETENTION_DAYS: i64 = 7;
const CLAIM_BATCH: i64 = 50;
const TICK: Duration = Duration::from_secs(2);
const PRUNE_EVERY_TICKS: u64 = 1_800; // ~1h

/// Everything needed to repeat the original send.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PushRetryJob {
    NewMessage {
        group_id: String,
        attribution: MessageAttribution,
    },
    NewMessageAlert {
        group_id: String,
        message_id: uuid::Uuid,
        sender: String,
        message_kind: String,
        encrypted_notification: Option<String>,
        message_wire: Option<serde_json::Value>,
        attribution: MessageAttribution,
    },
    WorkflowItem {
        item_type: String,
        item_id: String,
    },
}

/// Enables the queue. Call once at startup with the relayer's Postgres pool.
pub fn init(pool: PgPool) {
    if POOL.set(pool).is_err() {
        debug!("push retry queue already initialised");
    }
}

pub fn is_enabled() -> bool {
    POOL.get().is_some()
}

/// Seconds until the next attempt after `attempts` total attempts: 2, 4, 8 … capped.
pub fn backoff_secs(attempts: i32) -> i64 {
    let exp = attempts.clamp(1, 20) as u32;
    2_i64.saturating_pow(exp).min(MAX_BACKOFF_SECS)
}

/// Persists a send that just failed transiently (attempt #1 already happened).
pub async fn enqueue(wallet: &str, token: &PushTokenRecord, job: &PushRetryJob, error: &str) {
    let Some(pool) = POOL.get() else {
        debug!("push retry queue disabled — dropping transient failure for {wallet}");
        return;
    };
    let (token_json, job_json) = match (serde_json::to_value(token), serde_json::to_value(job)) {
        (Ok(t), Ok(j)) => (t, j),
        (Err(err), _) | (_, Err(err)) => {
            warn!("push retry serialize failed for {wallet}: {err}");
            return;
        }
    };
    let result = sqlx::query(
        "INSERT INTO push_retry_queue (wallet, token, job, last_error, available_at) \
         VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))",
    )
    .bind(wallet)
    .bind(token_json)
    .bind(job_json)
    .bind(truncate(error))
    .bind(backoff_secs(1) as f64)
    .execute(pool)
    .await;
    match result {
        Ok(_) => debug!("queued push retry for {wallet}"),
        Err(err) => warn!("push retry enqueue failed for {wallet}: {err}"),
    }
}

struct ClaimedRow {
    id: i64,
    wallet: String,
    token: PushTokenRecord,
    job: PushRetryJob,
    attempts: i32,
    max_attempts: i32,
    age_secs: i64,
}

/// Background loop; spawn once per relayer process.
pub async fn run_retry_worker(push: PushService, storage: Arc<dyn StorageAdapter>) {
    let Some(pool) = POOL.get().cloned() else {
        info!("push retry worker not started — no Postgres pool");
        return;
    };
    info!("push retry worker started");
    let mut ticker = tokio::time::interval(TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ticks: u64 = 0;
    loop {
        ticker.tick().await;
        ticks = ticks.wrapping_add(1);
        if let Err(err) = tick(&pool, &push, &storage).await {
            warn!("push retry tick failed: {err}");
        }
        if ticks % PRUNE_EVERY_TICKS == 0 {
            if let Err(err) = prune(&pool).await {
                warn!("push retry prune failed: {err}");
            }
        }
    }
}

async fn tick(
    pool: &PgPool,
    push: &PushService,
    storage: &Arc<dyn StorageAdapter>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE push_retry_queue SET status = 'pending', leased_at = NULL, updated_at = NOW() \
         WHERE status = 'leased' AND leased_at < NOW() - make_interval(secs => $1)",
    )
    .bind(STALE_LEASE_SECS as f64)
    .execute(pool)
    .await?;

    for row in claim(pool).await? {
        settle(pool, push, storage, row).await?;
    }
    Ok(())
}

async fn claim(pool: &PgPool) -> Result<Vec<ClaimedRow>, sqlx::Error> {
    let rows = sqlx::query(
        "UPDATE push_retry_queue SET status = 'leased', leased_at = NOW(), updated_at = NOW() \
         WHERE id IN ( \
           SELECT id FROM push_retry_queue \
           WHERE status = 'pending' AND available_at <= NOW() \
           ORDER BY available_at \
           FOR UPDATE SKIP LOCKED \
           LIMIT $1) \
         RETURNING id, wallet, token, job, attempts, max_attempts, \
           EXTRACT(EPOCH FROM (NOW() - created_at))::BIGINT AS age_secs",
    )
    .bind(CLAIM_BATCH)
    .fetch_all(pool)
    .await?;

    let mut claimed = Vec::with_capacity(rows.len());
    for row in rows {
        let id: i64 = row.try_get("id")?;
        let token: serde_json::Value = row.try_get("token")?;
        let job: serde_json::Value = row.try_get("job")?;
        match (serde_json::from_value(token), serde_json::from_value(job)) {
            (Ok(token), Ok(job)) => claimed.push(ClaimedRow {
                id,
                wallet: row.try_get("wallet")?,
                token,
                job,
                attempts: row.try_get("attempts")?,
                max_attempts: row.try_get("max_attempts")?,
                age_secs: row.try_get("age_secs")?,
            }),
            _ => {
                mark_dead(pool, id, "undecodable job").await?;
            }
        }
    }
    Ok(claimed)
}

async fn settle(
    pool: &PgPool,
    push: &PushService,
    storage: &Arc<dyn StorageAdapter>,
    row: ClaimedRow,
) -> Result<(), sqlx::Error> {
    if row.age_secs > STALE_AFTER_SECS {
        return mark_dead(pool, row.id, "expired before delivery").await;
    }
    match push.redeliver(storage, &row.wallet, &row.token, &row.job).await {
        Ok(()) => delete(pool, row.id).await,
        Err(ApnsSendError::Unregistered) => {
            if let Err(err) = storage.delete_push_token(&row.wallet, &row.token.token).await {
                warn!("prune unregistered token for {} failed: {err}", row.wallet);
            }
            delete(pool, row.id).await
        }
        Err(ApnsSendError::Transient(err)) => {
            let attempts = row.attempts + 1;
            if attempts >= row.max_attempts {
                warn!("push retry dead-lettered for {} after {attempts} attempts: {err}", row.wallet);
                return mark_dead(pool, row.id, &err).await;
            }
            sqlx::query(
                "UPDATE push_retry_queue SET status = 'pending', attempts = $2, leased_at = NULL, \
                 last_error = $3, available_at = NOW() + make_interval(secs => $4), updated_at = NOW() \
                 WHERE id = $1",
            )
            .bind(row.id)
            .bind(attempts)
            .bind(truncate(&err))
            .bind(backoff_secs(attempts) as f64)
            .execute(pool)
            .await
            .map(|_| ())
        }
        Err(other) => mark_dead(pool, row.id, &other.to_string()).await,
    }
}

async fn delete(pool: &PgPool, id: i64) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM push_retry_queue WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map(|_| ())
}

async fn mark_dead(pool: &PgPool, id: i64, error: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE push_retry_queue SET status = 'dead', leased_at = NULL, last_error = $2, \
         updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(truncate(error))
    .execute(pool)
    .await
    .map(|_| ())
}

async fn prune(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM push_retry_queue WHERE status = 'dead' \
         AND updated_at < NOW() - make_interval(days => $1)",
    )
    .bind(DEAD_RETENTION_DAYS as i32)
    .execute(pool)
    .await
    .map(|_| ())
}

fn truncate(error: &str) -> String {
    error.chars().take(500).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(3), 8);
        assert_eq!(backoff_secs(50), MAX_BACKOFF_SECS);
    }

    #[test]
    fn job_round_trips_through_json() {
        let job = PushRetryJob::NewMessageAlert {
            group_id: "g1".into(),
            message_id: uuid::Uuid::nil(),
            sender: "0xabc".into(),
            message_kind: "text".into(),
            encrypted_notification: Some("c2VhbGVk".into()),
            message_wire: Some(serde_json::json!({"v": 2})),
            attribution: MessageAttribution::default(),
        };
        let value = serde_json::to_value(&job).unwrap();
        assert_eq!(value["kind"], "new_message_alert");
        let back: PushRetryJob = serde_json::from_value(value).unwrap();
        assert_eq!(back, job);
    }

    #[test]
    fn workflow_job_tag() {
        let value = serde_json::to_value(PushRetryJob::WorkflowItem {
            item_type: "org_invitation".into(),
            item_id: "i1".into(),
        })
        .unwrap();
        assert_eq!(value["kind"], "workflow_item");
    }
}
