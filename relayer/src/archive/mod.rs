//! Pluggable message archive backends (Cloudflare R2 or File Storage).
//!
//! Local message storage remains on the relayer (`StorageAdapter`). Archive
//! backends provide durable, optional recovery for clients via `RecoveryTransport`.

pub mod file_storage;
pub mod index;
pub mod r2;
pub mod read;
pub mod sync;
pub mod types;

pub use file_storage::FileStorageArchiveBackend;
pub use index::{ArchiveIndex, ArchiveIndexRow, InMemoryArchiveIndex, PostgresArchiveIndex};
pub use r2::{MemoryObjectStore, ObjectStore, R2ArchiveBackend, R2ObjectStore};
pub use read::ArchiveReadService;
pub use sync::{
    create_archive_backend, create_archive_stack, ArchiveStack, ArchiveSyncService,
    FileStorageSyncService, MSG_PREFIX, SOURCE_TAG,
};
pub use types::{ArchiveBackend, ArchiveBackendKind, ArchiveError, ArchiveItem, ArchiveStoreResult};
