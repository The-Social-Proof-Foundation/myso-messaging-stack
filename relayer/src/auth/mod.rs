//! Authentication and authorization module.
//! - Ed25519, Secp256k1, Secp256r1 signature verification
//! - MySo wallet address derivation from public keys (Blake2b-256)
//! - Permission types matching the Groups SDK smart contract
//! - Membership store trait with in-memory implementation (synced from Groups SDK events)
//! - Axum middleware for request authentication

pub mod internal_sync;
pub mod membership;
pub mod membership_postgres;
pub mod middleware;
pub mod permissions;
pub mod schemes;
pub mod signature;
pub mod types;
pub mod wallet_middleware;
pub mod ws_auth;

#[allow(unused_imports)]
pub use membership::{
    create_membership_store, create_membership_store_async, InMemoryMembershipStore,
    MembershipError, MembershipStore, MembershipStoreType,
};
pub use internal_sync::{internal_sync_middleware, InternalSyncState};
pub use middleware::{auth_middleware, AuthState};
pub use wallet_middleware::wallet_auth_middleware;
pub use permissions::MessagingPermission;
pub use types::AuthContext;
