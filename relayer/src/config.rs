//! Application configuration loaded from environment variables.

use std::env;
use tracing::info;

use crate::auth::MembershipStoreType;
use crate::storage::StorageType;

const DEFAULT_FILE_STORAGE_PUBLISHER_URL: &str = "https://publisher.file-storage-testnet.mysocial.network";
const DEFAULT_FILE_STORAGE_AGGREGATOR_URL: &str = "https://aggregator.file-storage-testnet.mysocial.network";
const GENESIS_FRAMEWORK_PACKAGE_ID: &str =
    "0x0000000000000000000000000000000000000000000000000000000000000002";

#[derive(Debug, Clone)]
pub struct Config {
    /// Server port (default: 3000)
    pub port: u16,

    /// default: 900 = 15 minutes
    pub request_ttl_seconds: i64,

    /// Set via STORAGE_TYPE env var: "memory" (default) or "postgres"
    pub storage_type: StorageType,

    /// Set via MEMBERSHIP_STORE_TYPE env var: "memory" (default)
    pub membership_store_type: MembershipStoreType,

    /// MySo fullnode gRPC URL for checkpoint streaming
    pub myso_rpc_url: String,

    /// Groups SDK package ID on MySo
    pub groups_package_id: String,

    /// File Storage Configuration
    /// File Storage publisher URL for storing blobs/quilts.
    /// Default: File Storage testnet public publisher
    #[allow(dead_code)]
    pub file_storage_publisher_url: String,

    /// File Storage aggregator URL for reading blobs.
    /// Default: File Storage testnet public aggregator
    #[allow(dead_code)]
    pub file_storage_aggregator_url: String,

    /// Number of File Storage epochs to store blobs
    /// Default: 5 epochs
    #[allow(dead_code)]
    pub file_storage_storage_epochs: u32,

    /// How often the File Storage sync worker runs (in seconds).
    /// Default: 3600 (1 hour)
    pub file_storage_sync_interval_secs: u64,

    /// Max number of messages to batch per sync cycle.
    /// Default: 100, capped at 666 (File Storage quilt size limit)
    pub file_storage_sync_batch_size: usize,

    /// Number of new messages that trigger an immediate File Storage sync.
    /// Default: 50, set via FILE_STORAGE_SYNC_MESSAGE_THRESHOLD env var.
    /// Set to 0 to disable message-count-based syncing (interval-only).
    pub file_storage_sync_message_threshold: usize,

    /// Base URL for myso-social-server block checks (optional).
    pub social_server_url: Option<String>,
    /// Enable DM block checks (default: true when SOCIAL_SERVER_URL is set).
    pub block_check_enabled: bool,
    /// Block cache TTL in seconds (default: 300).
    pub block_cache_ttl_secs: u64,
    /// Block cache max entries (default: 100000).
    pub block_cache_max_entries: usize,

    /// Enable push notifications (default: false).
    pub push_enabled: bool,
    /// Skip push if wallet presence seen within this many seconds (default: 45).
    pub presence_ttl_secs: u64,
    /// APNs key id (optional).
    pub apns_key_id: Option<String>,
    /// APNs team id (optional).
    pub apns_team_id: Option<String>,
    /// APNs bundle id (optional).
    pub apns_bundle_id: Option<String>,
    /// Path to APNs .p8 auth key (optional).
    pub apns_auth_key_path: Option<String>,
    /// APNs environment: sandbox or production (default: sandbox).
    pub apns_environment: String,

    /// Enable WebSocket realtime + Postgres LISTEN worker (default: true).
    pub realtime_enabled: bool,
    /// WebSocket presence refresh interval in seconds (default: 30).
    pub ws_ping_interval_secs: u64,
}

impl Config {
    /// Loads configuration from environment variables.
    /// - `PORT`: Server port (default: 3000)
    /// - `REQUEST_TTL_SECONDS`: Request TTL for replay protection (default: 900)
    /// - `STORAGE_TYPE`: Storage backend type (default: "memory")
    /// - `MEMBERSHIP_STORE_TYPE`: Membership store type (default: "memory")
    /// - `MYSO_RPC_URL`: MySo fullnode gRPC URL
    /// - `GROUPS_PACKAGE_ID`: Groups SDK package ID
    /// - `FILE_STORAGE_PUBLISHER_URL`: File Storage publisher URL (default: testnet)
    /// - `FILE_STORAGE_AGGREGATOR_URL`: File Storage aggregator URL (default: testnet)
    /// - `FILE_STORAGE_STORAGE_EPOCHS`: How many epochs to store blobs (default: 5)
    pub fn from_env() -> Self {
        let port = env::var("PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3000);

        let request_ttl_seconds = env::var("REQUEST_TTL_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(900); // 15 minutes default

        // Parse storage type from STORAGE_TYPE env var
        let storage_type = match env::var("STORAGE_TYPE")
            .unwrap_or_else(|_| "memory".to_string())
            .to_lowercase()
            .as_str()
        {
            "postgres" => StorageType::Postgres(
                env::var("DATABASE_URL").expect("DATABASE_URL required for postgres storage"),
            ),
            _ => StorageType::InMemory,
        };

        // Parse membership store type from MEMBERSHIP_STORE_TYPE env var
        let membership_store_type = match env::var("MEMBERSHIP_STORE_TYPE")
            .unwrap_or_else(|_| "memory".to_string())
            .to_lowercase()
            .as_str()
        {
            "postgres" => MembershipStoreType::Postgres,
            _ => MembershipStoreType::InMemory,
        };

        // MySo event subscription config
        let myso_rpc_url =
            env::var("MYSO_RPC_URL").expect("MYSO_RPC_URL environment variable is required");
        let groups_package_id = env::var("GROUPS_PACKAGE_ID")
            .unwrap_or_else(|_| GENESIS_FRAMEWORK_PACKAGE_ID.to_string());

        // Publisher URL: where we send PUT requests to store blobs
        let file_storage_publisher_url = env::var("FILE_STORAGE_PUBLISHER_URL")
            .unwrap_or_else(|_| DEFAULT_FILE_STORAGE_PUBLISHER_URL.to_string());

        // Aggregator URL: where we send GET requests to read blobs
        let file_storage_aggregator_url = env::var("FILE_STORAGE_AGGREGATOR_URL")
            .unwrap_or_else(|_| DEFAULT_FILE_STORAGE_AGGREGATOR_URL.to_string());

        // Storage epochs: how long blobs persist on File Storage
        // parse::<u32>() converts string to unsigned 32-bit integer
        let file_storage_storage_epochs = env::var("FILE_STORAGE_STORAGE_EPOCHS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);

        let file_storage_sync_interval_secs = env::var("FILE_STORAGE_SYNC_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(3600);

        let file_storage_sync_batch_size = env::var("FILE_STORAGE_SYNC_BATCH_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100)
            .min(666); // File Storage quilt size limit

        // How many new messages trigger an immediate sync (0 = disabled, interval-only)
        let file_storage_sync_message_threshold = env::var("FILE_STORAGE_SYNC_MESSAGE_THRESHOLD")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(50);

        let social_server_url = env::var("SOCIAL_SERVER_URL").ok();
        let block_check_enabled = env::var("BLOCK_CHECK_ENABLED")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(social_server_url.is_some());
        let block_cache_ttl_secs = env::var("BLOCK_CACHE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);
        let block_cache_max_entries = env::var("BLOCK_CACHE_MAX_ENTRIES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100_000);

        let push_enabled = env::var("PUSH_ENABLED")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let presence_ttl_secs = env::var("PRESENCE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(45);
        let apns_key_id = env::var("APNS_KEY_ID").ok();
        let apns_team_id = env::var("APNS_TEAM_ID").ok();
        let apns_bundle_id = env::var("APNS_BUNDLE_ID").ok();
        let apns_auth_key_path = env::var("APNS_AUTH_KEY_PATH").ok();
        let apns_environment = env::var("APNS_ENVIRONMENT").unwrap_or_else(|_| "sandbox".to_string());

        let realtime_enabled = env::var("REALTIME_ENABLED")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(true);
        let ws_ping_interval_secs = env::var("WS_PING_INTERVAL_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

        let config = Self {
            port,
            request_ttl_seconds,
            storage_type,
            membership_store_type,
            myso_rpc_url,
            groups_package_id,
            file_storage_publisher_url,
            file_storage_aggregator_url,
            file_storage_storage_epochs,
            file_storage_sync_interval_secs,
            file_storage_sync_batch_size,
            file_storage_sync_message_threshold,
            social_server_url,
            block_check_enabled,
            block_cache_ttl_secs,
            block_cache_max_entries,
            push_enabled,
            presence_ttl_secs,
            apns_key_id,
            apns_team_id,
            apns_bundle_id,
            apns_auth_key_path,
            apns_environment,
            realtime_enabled,
            ws_ping_interval_secs,
        };

        info!("Configuration loaded: {:?}", config);
        config
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 3000,
            request_ttl_seconds: 900,
            storage_type: StorageType::InMemory,
            membership_store_type: MembershipStoreType::InMemory,
            myso_rpc_url: String::new(),
            groups_package_id: String::new(),
            file_storage_publisher_url: DEFAULT_FILE_STORAGE_PUBLISHER_URL.to_string(),
            file_storage_aggregator_url: DEFAULT_FILE_STORAGE_AGGREGATOR_URL.to_string(),
            file_storage_storage_epochs: 5,
            file_storage_sync_interval_secs: 3600,
            file_storage_sync_batch_size: 100,
            file_storage_sync_message_threshold: 50,
            social_server_url: None,
            block_check_enabled: false,
            block_cache_ttl_secs: 300,
            block_cache_max_entries: 100_000,
            push_enabled: false,
            presence_ttl_secs: 45,
            apns_key_id: None,
            apns_team_id: None,
            apns_bundle_id: None,
            apns_auth_key_path: None,
            apns_environment: "sandbox".to_string(),
            realtime_enabled: true,
            ws_ping_interval_secs: 30,
        }
    }
}

impl Config {
    pub fn uses_postgres_storage(&self) -> bool {
        matches!(self.storage_type, StorageType::Postgres(_))
    }

    pub fn inline_realtime_publish(&self) -> bool {
        self.realtime_enabled && !self.uses_postgres_storage()
    }

    pub fn postgres_database_url(&self) -> Option<String> {
        match &self.storage_type {
            StorageType::Postgres(url) => Some(url.clone()),
            StorageType::InMemory => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert_eq!(config.port, 3000);
        assert_eq!(config.request_ttl_seconds, 900);
    }

    #[test]
    fn test_file_storage_defaults() {
        let config = Config::default();
        // Verify File Storage defaults point to testnet
        assert!(config.file_storage_publisher_url.contains("testnet"));
        assert!(config.file_storage_aggregator_url.contains("testnet"));
        assert_eq!(config.file_storage_storage_epochs, 5);
    }
}
