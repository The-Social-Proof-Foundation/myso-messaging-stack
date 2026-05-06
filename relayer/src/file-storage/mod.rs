//! This module provides an HTTP client for storing and retrieving data
//! from File Storage via public publisher/aggregator endpoints.

pub mod client;
pub mod types;

pub use client::FileStorageClient;
#[allow(unused_imports)]
pub use types::{
    BlobStoreResponse, PatchInfo, QuiltStoreResponse, StoredQuiltPatch, FileStorageError, FileStorageResult,
};
