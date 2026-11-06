//! In-memory + optional postgres-backed notification push metadata.
//! Relayer stores/forwards opaque envelopes only — never plaintext previews.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
use tracing::info;
use uuid::Uuid;

/// Envelopes are only needed between `POST /messages` and the push fan-out (seconds).
const ENVELOPE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub struct DeviceNotificationKeyRecord {
    pub wallet: String,
    pub device_id: String,
    pub public_key: String,
    pub platform: String,
    pub updated_at: DateTime<Utc>,
    /// Wallet-signed certificate over this key (`None` = legacy unsigned registration).
    pub certificate: Option<DeviceKeyCertificate>,
}

/// The owning wallet's signature over a device notification key. Stored and served verbatim
/// so senders can verify it themselves; see `handlers::notification_push::key_certificate_canonical`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKeyCertificate {
    pub version: i16,
    pub issued_at_ms: i64,
    /// Hex signature in request-auth encoding (raw 64 bytes, or a full serialized zkLogin signature).
    pub signature: String,
    /// Hex flagged public key in request-auth encoding (`00…` ed25519, or `05` for zkLogin).
    pub public_key: String,
}

fn certificate_from_columns(
    version: Option<i16>,
    issued_at_ms: Option<i64>,
    signature: Option<String>,
    public_key: Option<String>,
) -> Option<DeviceKeyCertificate> {
    Some(DeviceKeyCertificate {
        version: version?,
        issued_at_ms: issued_at_ms?,
        signature: signature?,
        public_key: public_key?,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletNotificationMode {
    All,
    BadgeOnly,
    None,
}

impl WalletNotificationMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "all" => Some(Self::All),
            "badge_only" => Some(Self::BadgeOnly),
            "none" => Some(Self::None),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::BadgeOnly => "badge_only",
            Self::None => "none",
        }
    }
}

#[derive(Default)]
struct Inner {
    keys: HashMap<(String, String), DeviceNotificationKeyRecord>,
    envelopes: HashMap<(Uuid, String), (Vec<u8>, Instant)>,
    prefs: HashMap<String, WalletNotificationMode>,
}

/// Device keys and wallet prefs are durable (Postgres, `017_notification_push.sql`) and
/// cached in memory for the push hot path. Without the durable copy every relayer deploy
/// wiped all keys, senders sealed no previews, and every push fell back to "New message".
#[derive(Clone, Default)]
pub struct NotificationPushStore {
    inner: Arc<RwLock<Inner>>,
    pool: Arc<OnceLock<PgPool>>,
}

impl NotificationPushStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Enable write-through persistence and load every stored key / pref into memory.
    pub async fn attach_postgres(&self, pool: PgPool) -> Result<(), sqlx::Error> {
        let key_rows = sqlx::query(
            "SELECT wallet, device_id, public_key, platform, updated_at,
                    cert_version, cert_issued_at_ms, cert_signature, cert_public_key
             FROM device_notification_keys",
        )
        .fetch_all(&pool)
        .await?;
        let pref_rows = sqlx::query("SELECT wallet, notification_mode FROM wallet_notification_prefs")
            .fetch_all(&pool)
            .await?;
        {
            let mut inner = self.inner.write().expect("notification push store poisoned");
            for row in &key_rows {
                let record = DeviceNotificationKeyRecord {
                    wallet: row.get("wallet"),
                    device_id: row.get("device_id"),
                    public_key: row.get("public_key"),
                    platform: row.get("platform"),
                    updated_at: row.get("updated_at"),
                    certificate: certificate_from_columns(
                        row.get("cert_version"),
                        row.get("cert_issued_at_ms"),
                        row.get("cert_signature"),
                        row.get("cert_public_key"),
                    ),
                };
                inner
                    .keys
                    .insert((record.wallet.clone(), record.device_id.clone()), record);
            }
            for row in &pref_rows {
                let raw: String = row.get("notification_mode");
                if let Some(mode) = WalletNotificationMode::parse(&raw) {
                    inner.prefs.insert(row.get("wallet"), mode);
                }
            }
        }
        let _ = self.pool.set(pool);
        info!(
            "notification push store loaded {} device keys, {} wallet prefs from postgres",
            key_rows.len(),
            pref_rows.len()
        );
        Ok(())
    }

    /// Cache + persist a device key (handler path). Errors surface to the client so the
    /// app retries instead of believing it is registered.
    pub async fn save_device_key(&self, record: DeviceNotificationKeyRecord) -> Result<(), sqlx::Error> {
        if let Some(pool) = self.pool.get() {
            sqlx::query(
                "INSERT INTO device_notification_keys
                    (wallet, device_id, public_key, platform, updated_at,
                     cert_version, cert_issued_at_ms, cert_signature, cert_public_key)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (wallet, device_id) DO UPDATE
                 SET public_key = EXCLUDED.public_key,
                     platform = EXCLUDED.platform,
                     updated_at = EXCLUDED.updated_at,
                     cert_version = EXCLUDED.cert_version,
                     cert_issued_at_ms = EXCLUDED.cert_issued_at_ms,
                     cert_signature = EXCLUDED.cert_signature,
                     cert_public_key = EXCLUDED.cert_public_key",
            )
            .bind(&record.wallet)
            .bind(&record.device_id)
            .bind(&record.public_key)
            .bind(&record.platform)
            .bind(record.updated_at)
            .bind(record.certificate.as_ref().map(|c| c.version))
            .bind(record.certificate.as_ref().map(|c| c.issued_at_ms))
            .bind(record.certificate.as_ref().map(|c| c.signature.clone()))
            .bind(record.certificate.as_ref().map(|c| c.public_key.clone()))
            .execute(pool)
            .await?;
        }
        self.upsert_device_key(record);
        Ok(())
    }

    /// Cache + persist a wallet notification mode (handler path).
    pub async fn save_wallet_mode(
        &self,
        wallet: &str,
        mode: WalletNotificationMode,
    ) -> Result<(), sqlx::Error> {
        if let Some(pool) = self.pool.get() {
            sqlx::query(
                "INSERT INTO wallet_notification_prefs (wallet, notification_mode, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (wallet) DO UPDATE
                 SET notification_mode = EXCLUDED.notification_mode, updated_at = NOW()",
            )
            .bind(wallet)
            .bind(mode.as_str())
            .execute(pool)
            .await?;
        }
        self.set_wallet_mode(wallet, mode);
        Ok(())
    }

    pub fn upsert_device_key(&self, record: DeviceNotificationKeyRecord) {
        let mut inner = self.inner.write().expect("notification push store poisoned");
        inner
            .keys
            .insert((record.wallet.clone(), record.device_id.clone()), record);
    }

    pub fn list_device_keys_for_wallets(&self, wallets: &[String]) -> Vec<DeviceNotificationKeyRecord> {
        let inner = self.inner.read().expect("notification push store poisoned");
        wallets
            .iter()
            .flat_map(|wallet| {
                let wallet = wallet.clone();
                inner
                    .keys
                    .values()
                    .filter(move |k| k.wallet == wallet)
                    .cloned()
            })
            .collect()
    }

    pub fn store_envelopes(&self, message_id: Uuid, items: &[(String, Vec<u8>)]) {
        let mut inner = self.inner.write().expect("notification push store poisoned");
        let now = Instant::now();
        // Bounded memory: envelopes used to accumulate for the life of the process.
        inner
            .envelopes
            .retain(|_, (_, stored)| now.duration_since(*stored) < ENVELOPE_TTL);
        for (device_id, blob) in items {
            inner
                .envelopes
                .insert((message_id, device_id.clone()), (blob.clone(), now));
        }
    }

    pub fn get_envelope(&self, message_id: Uuid, device_id: &str) -> Option<Vec<u8>> {
        let inner = self.inner.read().expect("notification push store poisoned");
        inner
            .envelopes
            .get(&(message_id, device_id.to_string()))
            .map(|(blob, _)| blob.clone())
    }

    /// Number of cached device keys (diagnostics).
    pub fn device_key_count(&self) -> usize {
        self.inner.read().expect("notification push store poisoned").keys.len()
    }

    pub fn get_wallet_mode(&self, wallet: &str) -> WalletNotificationMode {
        let inner = self.inner.read().expect("notification push store poisoned");
        inner
            .prefs
            .get(wallet)
            .copied()
            .unwrap_or(WalletNotificationMode::All)
    }

    pub fn set_wallet_mode(&self, wallet: &str, mode: WalletNotificationMode) {
        let mut inner = self.inner.write().expect("notification push store poisoned");
        inner.prefs.insert(wallet.to_string(), mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn stores_and_retrieves_envelopes() {
        let store = NotificationPushStore::new();
        let message_id = Uuid::new_v4();
        store.store_envelopes(
            message_id,
            &[("device-a".to_string(), vec![1, 2, 3])],
        );
        assert_eq!(
            store.get_envelope(message_id, "device-a"),
            Some(vec![1, 2, 3])
        );
    }

    #[test]
    fn wallet_mode_defaults_to_all() {
        let store = NotificationPushStore::new();
        assert_eq!(
            store.get_wallet_mode("0xwallet"),
            WalletNotificationMode::All
        );
    }
}
