//! This module contains all data structures used throughout the relayer:
//! - Message: Encrypted messages stored and synced to File Storage
//! - Attachment: File attachments linked to messages
//! - GroupMembership: Local cache of group membership for validation

pub mod agent_messaging_group;
pub mod attachment;
pub mod conversation_report;
pub mod group_aux;
pub mod membership;
pub mod message;
pub mod message_attribution;
pub mod paid_escrow;
pub mod payment_metadata;
pub mod push_device;
pub mod system_message;
pub mod user_read_state;
pub mod workflow_item;

// Re-export commonly used types
pub use agent_messaging_group::AgentMessagingGroup;
pub use attachment::Attachment;
pub use conversation_report::ConversationReport;
pub use group_aux::{
    ConversationPreferences, ConversationPreferencesPatch, GroupActivity, GroupReceiptsResponse,
    MemberReceipt, ReactionEntry, ReceiptStateResponse,
};
#[allow(unused_imports)]
pub use membership::GroupMembership;
pub use message::{Message, SyncStatus};
pub use message_attribution::MessageAttribution;
pub use paid_escrow::PaidEscrowRecord;
pub use push_device::PushTokenRecord;
pub use system_message::{MessageKind, SystemMessageWire, SystemMetadataV1, SystemType};
pub use user_read_state::EncryptedBlobRecord;
