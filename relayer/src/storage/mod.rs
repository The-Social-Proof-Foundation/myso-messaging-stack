//! Storage layer for the messaging relayer.
//!
//! Provides pluggable storage backends via the `StorageAdapter` trait.

use std::sync::Arc;

pub mod adapter;
pub mod memory;
pub mod migrations;
pub mod postgres;
#[allow(unused_imports)]
pub use adapter::{StorageAdapter, StorageError, StorageResult};
pub use memory::InMemoryStorage;
pub use postgres::create_postgres_storage;

/// Storage backend type configuration
#[derive(Debug, Clone, Default)]
pub enum StorageType {
    #[default]
    InMemory,
    Postgres(String),
}

/// Creates a storage adapter based on the configured storage type.
pub fn create_storage(storage_type: StorageType) -> Arc<dyn StorageAdapter> {
    match storage_type {
        StorageType::InMemory => Arc::new(InMemoryStorage::new()),
        StorageType::Postgres(_) => {
            panic!("Postgres storage requires create_storage_async — use create_storage_from_env")
        }
    }
}

pub async fn create_storage_async(storage_type: StorageType) -> Arc<dyn StorageAdapter> {
    match storage_type {
        StorageType::InMemory => Arc::new(InMemoryStorage::new()),
        StorageType::Postgres(url) => create_postgres_storage(&url)
            .await
            .expect("Failed to connect to Postgres"),
    }
}
