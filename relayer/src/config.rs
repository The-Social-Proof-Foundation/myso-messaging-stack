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
            "memory" => StorageType::InMemory,
            _ => StorageType::InMemory,
        };

        // Parse membership store type from MEMBERSHIP_STORE_TYPE env var
        let membership_store_type = match env::var("MEMBERSHIP_STORE_TYPE")
            .unwrap_or_else(|_| "memory".to_string())
            .to_lowercase()
            .as_str()
        {
            "memory" => MembershipStoreType::InMemory,
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
