//! MLS delivery-service state (E2EE M4): KeyPackages, accepted epochs, Welcomes.
//! Postgres when attached (multi-instance safe: the epoch move is an atomic compare-and-set),
//! in-memory otherwise (tests / dev).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use sqlx::{PgPool, Row};

/// Max unclaimed KeyPackages kept per device.
pub const MAX_KEY_PACKAGES_PER_DEVICE: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedKeyPackage {
    pub wallet: String,
    pub device_id: String,
    pub key_package: Vec<u8>,
}

#[derive(Default)]
struct Mem {
    key_packages: Vec<(String, String, Vec<u8>, bool)>,
    epochs: HashMap<String, u64>,
    welcomes: Vec<(String, String, String, Vec<u8>)>,
    group_infos: HashMap<String, (u64, Vec<u8>)>,
    self_messages: Vec<(String, i64, Vec<u8>)>,
    /// (wallet, device_id) -> (first_seen_ms, last_seen_ms)
    device_seen: HashMap<(String, String), (i64, i64)>,
    /// (wallet, key_id, seq, body, created_ms)
    backup: Vec<(String, String, i64, Vec<u8>, i64)>,
    backup_seq: i64,
}

/// Max bytes of one backup segment (clients cut bundles smaller than this).
pub const MAX_BACKUP_SEGMENT_BYTES: usize = 768 * 1024;
/// Per-wallet backup quota.
pub const MAX_BACKUP_SEGMENTS: i64 = 20_000;
pub const MAX_BACKUP_BYTES: i64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupAppend {
    Stored(i64),
    QuotaExceeded,
}

/// One device's activity, as the relayer saw it (unix ms).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSeen {
    pub device_id: String,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

/// Max self-group rows kept per wallet (history bundles are transient).
pub const MAX_SELF_MESSAGES: i64 = 5_000;

#[derive(Clone, Default)]
pub struct MlsStore {
    mem: Arc<Mutex<Mem>>,
    pool: Arc<OnceLock<PgPool>>,
}

type R<T> = Result<T, sqlx::Error>;

impl MlsStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn attach_postgres(&self, pool: PgPool) {
        let _ = self.pool.set(pool);
    }

    pub async fn put_key_packages(&self, wallet: &str, device_id: &str, packages: &[Vec<u8>]) -> R<()> {
        if let Some(pool) = self.pool.get() {
            for kp in packages {
                sqlx::query("INSERT INTO mls_key_packages (wallet, device_id, key_package) VALUES ($1, $2, $3)")
                    .bind(wallet)
                    .bind(device_id)
                    .bind(kp)
                    .execute(pool)
                    .await?;
            }
            // Keep only the newest MAX unclaimed per device.
            sqlx::query(
                "DELETE FROM mls_key_packages WHERE id IN (
                   SELECT id FROM mls_key_packages
                   WHERE wallet = $1 AND device_id = $2 AND claimed_at IS NULL
                   ORDER BY created_at DESC OFFSET $3)",
            )
            .bind(wallet)
            .bind(device_id)
            .bind(MAX_KEY_PACKAGES_PER_DEVICE as i64)
            .execute(pool)
            .await?;
            return Ok(());
        }
        let mut mem = self.mem.lock().unwrap();
        for kp in packages {
            mem.key_packages.push((wallet.into(), device_id.into(), kp.clone(), false));
        }
        Ok(())
    }

    /// One unclaimed KeyPackage per device of each wallet (single use: marked claimed).
    pub async fn claim_key_packages(&self, wallets: &[String]) -> R<Vec<ClaimedKeyPackage>> {
        if let Some(pool) = self.pool.get() {
            let rows = sqlx::query(
                "UPDATE mls_key_packages SET claimed_at = NOW()
                 WHERE id IN (
                   SELECT id FROM (
                     SELECT id, row_number() OVER (PARTITION BY wallet, device_id ORDER BY created_at) AS rn
                     FROM mls_key_packages WHERE wallet = ANY($1) AND claimed_at IS NULL
                   ) ranked WHERE rn = 1)
                 RETURNING wallet, device_id, key_package",
            )
            .bind(wallets)
            .fetch_all(pool)
            .await?;
            return Ok(rows
                .iter()
                .map(|r| ClaimedKeyPackage {
                    wallet: r.get("wallet"),
                    device_id: r.get("device_id"),
                    key_package: r.get("key_package"),
                })
                .collect());
        }
        let mut mem = self.mem.lock().unwrap();
        let mut seen: Vec<(String, String)> = Vec::new();
        let mut out = Vec::new();
        for entry in mem.key_packages.iter_mut() {
            let key = (entry.0.clone(), entry.1.clone());
            if entry.3 || !wallets.contains(&entry.0) || seen.contains(&key) {
                continue;
            }
            entry.3 = true;
            seen.push(key);
            out.push(ClaimedKeyPackage { wallet: entry.0.clone(), device_id: entry.1.clone(), key_package: entry.2.clone() });
        }
        Ok(out)
    }

    pub async fn current_epoch(&self, group_id: &str) -> R<u64> {
        if let Some(pool) = self.pool.get() {
            let row = sqlx::query("SELECT epoch FROM mls_group_epochs WHERE group_id = $1")
                .bind(group_id)
                .fetch_optional(pool)
                .await?;
            return Ok(row.map(|r| r.get::<i64, _>("epoch") as u64).unwrap_or(0));
        }
        Ok(*self.mem.lock().unwrap().epochs.get(group_id).unwrap_or(&0))
    }

    /// Accept a commit made in `epoch` iff it is the group's current epoch (first one wins).
    pub async fn try_advance_epoch(&self, group_id: &str, epoch: u64) -> R<bool> {
        if let Some(pool) = self.pool.get() {
            let affected = if epoch == 0 {
                sqlx::query(
                    "INSERT INTO mls_group_epochs (group_id, epoch) VALUES ($1, 1)
                     ON CONFLICT (group_id) DO UPDATE SET epoch = 1, updated_at = NOW()
                     WHERE mls_group_epochs.epoch = 0",
                )
                .bind(group_id)
                .execute(pool)
                .await?
                .rows_affected()
            } else {
                sqlx::query("UPDATE mls_group_epochs SET epoch = $2 + 1, updated_at = NOW() WHERE group_id = $1 AND epoch = $2")
                    .bind(group_id)
                    .bind(epoch as i64)
                    .execute(pool)
                    .await?
                    .rows_affected()
            };
            return Ok(affected == 1);
        }
        let mut mem = self.mem.lock().unwrap();
        let current = mem.epochs.entry(group_id.to_string()).or_insert(0);
        if *current != epoch {
            return Ok(false);
        }
        *current = epoch + 1;
        Ok(true)
    }

    pub async fn put_welcome(&self, group_id: &str, wallet: &str, device_id: &str, welcome: &[u8]) -> R<()> {
        if let Some(pool) = self.pool.get() {
            sqlx::query("INSERT INTO mls_welcomes (group_id, wallet, device_id, welcome) VALUES ($1, $2, $3, $4)")
                .bind(group_id)
                .bind(wallet)
                .bind(device_id)
                .bind(welcome)
                .execute(pool)
                .await?;
            return Ok(());
        }
        self.mem.lock().unwrap().welcomes.push((group_id.into(), wallet.into(), device_id.into(), welcome.to_vec()));
        Ok(())
    }

    /// Pending Welcomes for one device; removed once handed out.
    pub async fn take_welcomes(&self, wallet: &str, device_id: &str) -> R<Vec<(String, Vec<u8>)>> {
        if let Some(pool) = self.pool.get() {
            let rows = sqlx::query(
                "DELETE FROM mls_welcomes WHERE wallet = $1 AND device_id = $2 RETURNING group_id, welcome",
            )
            .bind(wallet)
            .bind(device_id)
            .fetch_all(pool)
            .await?;
            return Ok(rows.iter().map(|r| (r.get("group_id"), r.get("welcome"))).collect());
        }
        let mut mem = self.mem.lock().unwrap();
        let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut mem.welcomes)
            .into_iter()
            .partition(|w| w.1 == wallet && w.2 == device_id);
        mem.welcomes = rest;
        Ok(mine.into_iter().map(|w| (w.0, w.3)).collect())
    }
}

impl MlsStore {
    /// Store a GroupInfo if it is for the current accepted epoch (stale ones are refused).
    pub async fn put_group_info(&self, group_id: &str, epoch: u64, info: &[u8]) -> R<bool> {
        if self.current_epoch(group_id).await? != epoch {
            return Ok(false);
        }
        if let Some(pool) = self.pool.get() {
            sqlx::query(
                "INSERT INTO mls_group_infos (group_id, epoch, group_info) VALUES ($1, $2, $3)
                 ON CONFLICT (group_id) DO UPDATE SET epoch = EXCLUDED.epoch,
                   group_info = EXCLUDED.group_info, updated_at = NOW()
                 WHERE mls_group_infos.epoch <= EXCLUDED.epoch",
            )
            .bind(group_id)
            .bind(epoch as i64)
            .bind(info)
            .execute(pool)
            .await?;
            return Ok(true);
        }
        self.mem.lock().unwrap().group_infos.insert(group_id.into(), (epoch, info.to_vec()));
        Ok(true)
    }

    pub async fn group_info(&self, group_id: &str) -> R<Option<(u64, Vec<u8>)>> {
        if let Some(pool) = self.pool.get() {
            let row = sqlx::query("SELECT epoch, group_info FROM mls_group_infos WHERE group_id = $1")
                .bind(group_id)
                .fetch_optional(pool)
                .await?;
            return Ok(row.map(|r| (r.get::<i64, _>("epoch") as u64, r.get("group_info"))));
        }
        Ok(self.mem.lock().unwrap().group_infos.get(group_id).cloned())
    }

    /// Append to a wallet's self-group log; returns the new sequence number.
    pub async fn append_self(&self, wallet: &str, body: &[u8]) -> R<i64> {
        if let Some(pool) = self.pool.get() {
            let row = sqlx::query("INSERT INTO mls_self_messages (wallet, body) VALUES ($1, $2) RETURNING seq")
                .bind(wallet)
                .bind(body)
                .fetch_one(pool)
                .await?;
            let seq: i64 = row.get("seq");
            sqlx::query("DELETE FROM mls_self_messages WHERE wallet = $1 AND seq <= $2 - $3")
                .bind(wallet)
                .bind(seq)
                .bind(MAX_SELF_MESSAGES)
                .execute(pool)
                .await?;
            return Ok(seq);
        }
        let mut mem = self.mem.lock().unwrap();
        let seq = mem.self_messages.iter().filter(|m| m.0 == wallet).map(|m| m.1).max().unwrap_or(0) + 1;
        mem.self_messages.push((wallet.into(), seq, body.to_vec()));
        Ok(seq)
    }

    pub async fn self_after(&self, wallet: &str, after: i64, limit: i64) -> R<Vec<(i64, Vec<u8>)>> {
        if let Some(pool) = self.pool.get() {
            let rows = sqlx::query(
                "SELECT seq, body FROM mls_self_messages WHERE wallet = $1 AND seq > $2 ORDER BY seq LIMIT $3",
            )
            .bind(wallet)
            .bind(after)
            .bind(limit)
            .fetch_all(pool)
            .await?;
            return Ok(rows.iter().map(|r| (r.get("seq"), r.get("body"))).collect());
        }
        let mem = self.mem.lock().unwrap();
        Ok(mem
            .self_messages
            .iter()
            .filter(|m| m.0 == wallet && m.1 > after)
            .take(limit as usize)
            .map(|m| (m.1, m.2.clone()))
            .collect())
    }

    /// Logout: drop a device's unclaimed KeyPackages so nobody can add it again, and its activity.
    pub async fn delete_device_key_packages(&self, wallet: &str, device_id: &str) -> R<()> {
        if let Some(pool) = self.pool.get() {
            sqlx::query("DELETE FROM mls_key_packages WHERE wallet = $1 AND device_id = $2 AND claimed_at IS NULL")
                .bind(wallet)
                .bind(device_id)
                .execute(pool)
                .await?;
            sqlx::query("DELETE FROM mls_device_seen WHERE wallet = $1 AND device_id = $2")
                .bind(wallet)
                .bind(device_id)
                .execute(pool)
                .await?;
            return Ok(());
        }
        let mut mem = self.mem.lock().unwrap();
        mem.key_packages.retain(|k| !(k.0 == wallet && k.1 == device_id && !k.3));
        mem.device_seen.remove(&(wallet.to_string(), device_id.to_string()));
        Ok(())
    }

    /// Append a backup segment, unless the wallet is over its quota.
    pub async fn append_backup(&self, wallet: &str, key_id: &str, body: &[u8]) -> R<BackupAppend> {
        if let Some(pool) = self.pool.get() {
            let usage = sqlx::query(
                "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0)::BIGINT AS bytes FROM mls_backup_segments WHERE wallet = $1",
            )
            .bind(wallet)
            .fetch_one(pool)
            .await?;
            let (n, bytes): (i64, i64) = (usage.get("n"), usage.get("bytes"));
            if n >= MAX_BACKUP_SEGMENTS || bytes + body.len() as i64 > MAX_BACKUP_BYTES {
                return Ok(BackupAppend::QuotaExceeded);
            }
            let row = sqlx::query("INSERT INTO mls_backup_segments (wallet, key_id, body) VALUES ($1, $2, $3) RETURNING seq")
                .bind(wallet)
                .bind(key_id)
                .bind(body)
                .fetch_one(pool)
                .await?;
            return Ok(BackupAppend::Stored(row.get("seq")));
        }
        let mut mem = self.mem.lock().unwrap();
        let (n, bytes) = mem.backup.iter().filter(|b| b.0 == wallet).fold((0i64, 0i64), |(n, s), b| (n + 1, s + b.3.len() as i64));
        if n >= MAX_BACKUP_SEGMENTS || bytes + body.len() as i64 > MAX_BACKUP_BYTES {
            return Ok(BackupAppend::QuotaExceeded);
        }
        mem.backup_seq += 1;
        let seq = mem.backup_seq;
        mem.backup.push((wallet.into(), key_id.into(), seq, body.to_vec(), chrono::Utc::now().timestamp_millis()));
        Ok(BackupAppend::Stored(seq))
    }

    /// A wallet's segments under `key_id` after `after`, in order: (seq, body, created_ms).
    pub async fn backup_after(&self, wallet: &str, key_id: &str, after: i64, limit: i64) -> R<Vec<(i64, Vec<u8>, i64)>> {
        if let Some(pool) = self.pool.get() {
            let rows = sqlx::query(
                "SELECT seq, body, (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_ms \
                 FROM mls_backup_segments WHERE wallet = $1 AND key_id = $2 AND seq > $3 ORDER BY seq LIMIT $4",
            )
            .bind(wallet)
            .bind(key_id)
            .bind(after)
            .bind(limit)
            .fetch_all(pool)
            .await?;
            return Ok(rows.iter().map(|r| (r.get("seq"), r.get("body"), r.get("created_ms"))).collect());
        }
        let mem = self.mem.lock().unwrap();
        Ok(mem
            .backup
            .iter()
            .filter(|b| b.0 == wallet && b.1 == key_id && b.2 > after)
            .take(limit.max(0) as usize)
            .map(|b| (b.2, b.3.clone(), b.4))
            .collect())
    }

    /// Delete every segment of `wallet` under `key_id` (backup turned off). Returns how many.
    pub async fn delete_backup(&self, wallet: &str, key_id: &str) -> R<u64> {
        if let Some(pool) = self.pool.get() {
            let done = sqlx::query("DELETE FROM mls_backup_segments WHERE wallet = $1 AND key_id = $2")
                .bind(wallet)
                .bind(key_id)
                .execute(pool)
                .await?;
            return Ok(done.rows_affected());
        }
        let mut mem = self.mem.lock().unwrap();
        let before = mem.backup.len();
        mem.backup.retain(|b| !(b.0 == wallet && b.1 == key_id));
        Ok((before - mem.backup.len()) as u64)
    }

    /// Record that a device of `wallet` is active now.
    pub async fn touch_device(&self, wallet: &str, device_id: &str) -> R<()> {
        if let Some(pool) = self.pool.get() {
            sqlx::query(
                "INSERT INTO mls_device_seen (wallet, device_id) VALUES ($1, $2) \
                 ON CONFLICT (wallet, device_id) DO UPDATE SET last_seen_at = NOW()",
            )
            .bind(wallet)
            .bind(device_id)
            .execute(pool)
            .await?;
            return Ok(());
        }
        let now = chrono::Utc::now().timestamp_millis();
        self.mem
            .lock()
            .unwrap()
            .device_seen
            .entry((wallet.to_string(), device_id.to_string()))
            .and_modify(|e| e.1 = now)
            .or_insert((now, now));
        Ok(())
    }

    /// A wallet's devices with their activity, most recently active first.
    pub async fn devices_seen(&self, wallet: &str) -> R<Vec<DeviceSeen>> {
        if let Some(pool) = self.pool.get() {
            let rows = sqlx::query(
                "SELECT device_id, \
                        (EXTRACT(EPOCH FROM first_seen_at) * 1000)::BIGINT AS first_ms, \
                        (EXTRACT(EPOCH FROM last_seen_at) * 1000)::BIGINT AS last_ms \
                 FROM mls_device_seen WHERE wallet = $1 ORDER BY last_seen_at DESC LIMIT 100",
            )
            .bind(wallet)
            .fetch_all(pool)
            .await?;
            return Ok(rows
                .iter()
                .map(|r| DeviceSeen {
                    device_id: r.get("device_id"),
                    first_seen_ms: r.get("first_ms"),
                    last_seen_ms: r.get("last_ms"),
                })
                .collect());
        }
        let mem = self.mem.lock().unwrap();
        let mut out: Vec<DeviceSeen> = mem
            .device_seen
            .iter()
            .filter(|((w, _), _)| w == wallet)
            .map(|((_, d), (first, last))| DeviceSeen { device_id: d.clone(), first_seen_ms: *first, last_seen_ms: *last })
            .collect();
        out.sort_by(|a, b| b.last_seen_ms.cmp(&a.last_seen_ms));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exactly_one_commit_per_epoch() {
        let store = MlsStore::new();
        assert!(store.try_advance_epoch("g", 0).await.unwrap());
        assert!(!store.try_advance_epoch("g", 0).await.unwrap(), "second commit for epoch 0 loses");
        assert!(store.try_advance_epoch("g", 1).await.unwrap());
        assert_eq!(store.current_epoch("g").await.unwrap(), 2);
    }

    #[tokio::test]
    async fn key_packages_are_single_use_one_per_device() {
        let store = MlsStore::new();
        store.put_key_packages("0xa", "phone", &[vec![1], vec![2]]).await.unwrap();
        store.put_key_packages("0xa", "laptop", &[vec![3]]).await.unwrap();
        let first = store.claim_key_packages(&["0xa".into()]).await.unwrap();
        assert_eq!(first.len(), 2);
        let second = store.claim_key_packages(&["0xa".into()]).await.unwrap();
        assert_eq!(second, vec![ClaimedKeyPackage { wallet: "0xa".into(), device_id: "phone".into(), key_package: vec![2] }]);
    }

    #[tokio::test]
    async fn group_info_only_for_the_current_epoch() {
        let store = MlsStore::new();
        assert!(store.try_advance_epoch("g", 0).await.unwrap());
        assert!(!store.put_group_info("g", 0, &[1]).await.unwrap(), "stale epoch refused");
        assert!(store.put_group_info("g", 1, &[2]).await.unwrap());
        assert_eq!(store.group_info("g").await.unwrap(), Some((1, vec![2])));
    }

    #[tokio::test]
    async fn self_log_is_per_wallet_and_ordered() {
        let store = MlsStore::new();
        store.append_self("0xa", &[1]).await.unwrap();
        store.append_self("0xb", &[9]).await.unwrap();
        store.append_self("0xa", &[2]).await.unwrap();
        assert_eq!(store.self_after("0xa", 0, 10).await.unwrap(), vec![(1, vec![1]), (2, vec![2])]);
        assert_eq!(store.self_after("0xa", 1, 10).await.unwrap(), vec![(2, vec![2])]);
    }

    #[tokio::test]
    async fn device_activity_is_per_wallet_and_cleared_on_logout() {
        let store = MlsStore::new();
        store.touch_device("0xa", "phone").await.unwrap();
        store.touch_device("0xb", "phone").await.unwrap();
        store.touch_device("0xa", "laptop").await.unwrap();
        let seen = store.devices_seen("0xa").await.unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen.iter().all(|d| d.last_seen_ms >= d.first_seen_ms));
        store.delete_device_key_packages("0xa", "laptop").await.unwrap();
        let ids: Vec<_> = store.devices_seen("0xa").await.unwrap().into_iter().map(|d| d.device_id).collect();
        assert_eq!(ids, vec!["phone".to_string()]);
    }

    #[tokio::test]
    async fn backup_segments_are_per_wallet_and_key_ordered_and_deletable() {
        let store = MlsStore::new();
        assert_eq!(store.append_backup("0xa", "k1", &[1]).await.unwrap(), BackupAppend::Stored(1));
        store.append_backup("0xb", "k1", &[9]).await.unwrap();
        store.append_backup("0xa", "k2", &[7]).await.unwrap();
        store.append_backup("0xa", "k1", &[2]).await.unwrap();
        let k1: Vec<_> = store.backup_after("0xa", "k1", 0, 10).await.unwrap().into_iter().map(|b| b.1).collect();
        assert_eq!(k1, vec![vec![1], vec![2]]);
        let first = store.backup_after("0xa", "k1", 0, 10).await.unwrap()[0].0;
        assert_eq!(store.backup_after("0xa", "k1", first, 10).await.unwrap().len(), 1);
        assert_eq!(store.delete_backup("0xa", "k1").await.unwrap(), 2);
        assert!(store.backup_after("0xa", "k1", 0, 10).await.unwrap().is_empty());
        assert_eq!(store.backup_after("0xa", "k2", 0, 10).await.unwrap().len(), 1);
        assert_eq!(store.backup_after("0xb", "k1", 0, 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn backup_quota_is_enforced() {
        let store = MlsStore::new();
        let big = vec![0u8; (MAX_BACKUP_BYTES as usize) / 2 + 1];
        assert!(matches!(store.append_backup("0xa", "k", &big).await.unwrap(), BackupAppend::Stored(_)));
        assert_eq!(store.append_backup("0xa", "k", &big).await.unwrap(), BackupAppend::QuotaExceeded);
        assert!(matches!(store.append_backup("0xb", "k", &[1]).await.unwrap(), BackupAppend::Stored(_)));
    }

    #[tokio::test]
    async fn welcomes_are_delivered_once_to_their_device() {
        let store = MlsStore::new();
        store.put_welcome("g", "0xa", "phone", &[9]).await.unwrap();
        assert!(store.take_welcomes("0xa", "laptop").await.unwrap().is_empty());
        assert_eq!(store.take_welcomes("0xa", "phone").await.unwrap(), vec![("g".to_string(), vec![9])]);
        assert!(store.take_welcomes("0xa", "phone").await.unwrap().is_empty());
    }
}
