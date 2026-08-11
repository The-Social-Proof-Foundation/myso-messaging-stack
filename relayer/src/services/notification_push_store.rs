//! In-memory + optional postgres-backed notification push metadata.
//! Relayer stores/forwards opaque envelopes only — never plaintext previews.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct DeviceNotificationKeyRecord {
    pub wallet: String,
    pub device_id: String,
    pub public_key: String,
    pub platform: String,
    pub updated_at: DateTime<Utc>,
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
    envelopes: HashMap<(Uuid, String), Vec<u8>>,
    prefs: HashMap<String, WalletNotificationMode>,
}

#[derive(Clone, Default)]
pub struct NotificationPushStore {
    inner: Arc<RwLock<Inner>>,
}

impl NotificationPushStore {
    pub fn new() -> Self {
        Self::default()
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
        for (device_id, blob) in items {
            inner
                .envelopes
                .insert((message_id, device_id.clone()), blob.clone());
        }
    }

    pub fn get_envelope(&self, message_id: Uuid, device_id: &str) -> Option<Vec<u8>> {
        let inner = self.inner.read().expect("notification push store poisoned");
        inner
            .envelopes
            .get(&(message_id, device_id.to_string()))
            .cloned()
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
