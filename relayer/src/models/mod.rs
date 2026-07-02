//! This module contains all data structures used throughout the relayer:
//! - Message: Encrypted messages stored and synced to File Storage
//! - Attachment: File attachments linked to messages
//! - GroupMembership: Local cache of group membership for validation

pub mod attachment;
pub mod group_aux;
pub mod membership;
pub mod message;
pub mod message_attribution;
pub mod agent_messaging_group;
pub mod paid_escrow;
pub mod push_device;
pub mod user_read_state;

// Re-export commonly used types
pub use attachment::Attachment;
#[allow(unused_imports)]
pub use membership::GroupMembership;
pub use group_aux::{GroupActivity, ReactionEntry, ReceiptStateResponse};
pub use message::{Message, SyncStatus};
pub use message_attribution::MessageAttribution;
pub use agent_messaging_group::AgentMessagingGroup;
pub use paid_escrow::PaidEscrowRecord;
pub use push_device::PushTokenRecord;
pub use user_read_state::EncryptedBlobRecord;
