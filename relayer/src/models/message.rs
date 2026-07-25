use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

use super::attachment::Attachment;
use super::message_attribution::MessageAttribution;
use super::system_message::{MessageKind, SystemMetadataV1, SystemType};

/// Represents a message in the relayer storage.
/// Text messages are received via HTTP POST; system messages are inserted only
/// by trusted server services (e.g. membership sync).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    /// Unique message identifier (UUID v4)
    pub id: Uuid,
    /// Group ID where this message belongs
    pub group_id: String,
    /// Message ordering within the group (counter)
    /// None until storage layer assigns it
    pub order: Option<i64>,
    /// Sender's MySo wallet address (verified via signature)
    pub sender_wallet_addr: String,
    /// Encrypted message content (encrypted by client before sending)
    pub encrypted_msg: Vec<u8>,
    /// 12-byte AES-GCM nonce used to encrypt this message
    pub nonce: Vec<u8>,
    /// Encryption key version
    pub key_version: i64,
    /// Message creation timestamp
    pub created_at: DateTime<Utc>,
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    /// True only after a real content edit (`update_content`). Not set by archival sync.
    #[serde(default)]
    pub is_edited: bool,
    /// Synchronization status with File Storage storage
    pub sync_status: SyncStatus,
    /// File Storage quilt patch ID after archival (NULL until synced)
    pub quilt_patch_id: Option<String>,
    /// Attachments associated with this message.
    /// Each entry contains the storage ID and encryption metadata needed by
    /// clients to download and decrypt the attachment.
    pub attachments: Vec<Attachment>,
    /// 64-byte cryptographic signature over the message content.
    /// Allows receivers to independently verify the sender authored this message.
    pub signature: Vec<u8>,
    /// Sender's public key (flag byte + key bytes) for signature verification.
    pub public_key: Vec<u8>,
    /// Optional agent attribution (principal, sub-agent id, identity class).
    pub attribution: MessageAttribution,
    /// Timeline kind (`text` or `system`).
    pub kind: MessageKind,
    /// Present when `kind == system`.
    pub system_type: Option<SystemType>,
    /// Versioned cleartext metadata (system events; reserved for future text metadata).
    pub metadata: Option<serde_json::Value>,
    /// Chain-derived unique key for replay-safe system inserts.
    pub idempotency_key: Option<String>,
}

/// Tracks the synchronization status of a message with File Storage storage.
/// (SYNC_PENDING | SYNCED | UPDATE_PENDING | UPDATED | DELETE_PENDING | DELETED)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SyncStatus {
    /// Message received by relayer, pending File Storage archival
    SyncPending,
    /// Message successfully archived to File Storage
    Synced,
    /// Message updated, pending re-archival to File Storage
    UpdatePending,
    /// Message updated and re-synced to File Storage
    Updated,
    /// Message marked for deletion, pending removal from File Storage
    DeletePending,
    /// Message deleted from both relayer and File Storage
    Deleted,
}

/// Default to SyncPending
impl Default for SyncStatus {
    fn default() -> Self {
        Self::SyncPending
    }
}

impl fmt::Display for SyncStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            SyncStatus::SyncPending => "SYNC_PENDING",
            SyncStatus::Synced => "SYNCED",
            SyncStatus::UpdatePending => "UPDATE_PENDING",
            SyncStatus::Updated => "UPDATED",
            SyncStatus::DeletePending => "DELETE_PENDING",
            SyncStatus::Deleted => "DELETED",
        };
        write!(f, "{}", s)
    }
}
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
impl Message {
    /// Creates a new message from HTTP POST request data.
    /// The message starts in SYNC_PENDING status and has no quilt_patch_id yet.
    pub fn new(
        group_id: String,
        sender_wallet_addr: String,
        encrypted_msg: Vec<u8>,
        nonce: Vec<u8>,
        key_version: i64,
        attachments: Vec<Attachment>,
        signature: Vec<u8>,
        public_key: Vec<u8>,
    ) -> Self {
        Self::with_attribution(
            group_id,
            sender_wallet_addr,
            encrypted_msg,
            nonce,
            key_version,
            attachments,
            signature,
            public_key,
            MessageAttribution::human_message(),
        )
    }

    pub fn with_attribution(
        group_id: String,
        sender_wallet_addr: String,
        encrypted_msg: Vec<u8>,
        nonce: Vec<u8>,
        key_version: i64,
        attachments: Vec<Attachment>,
        signature: Vec<u8>,
        public_key: Vec<u8>,
        attribution: MessageAttribution,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            group_id,
            order: None,
            sender_wallet_addr,
            encrypted_msg,
            nonce,
            key_version,
            created_at: now,
            updated_at: now,
            is_edited: false,
            sync_status: SyncStatus::default(),
            quilt_patch_id: None,
            attachments,
            signature,
            public_key,
            attribution,
            kind: MessageKind::Text,
            system_type: None,
            metadata: None,
            idempotency_key: None,
        }
    }

    /// Trusted-server constructor for immutable system timeline rows.
    pub fn new_system(
        group_id: String,
        member: String,
        system_type: SystemType,
        actor: Option<String>,
        idempotency_key: String,
        created_at: DateTime<Utc>,
    ) -> Self {
        use blake2::{Blake2b512, Digest};

        let meta = SystemMetadataV1::new(member.clone(), actor);
        let metadata = serde_json::to_value(&meta).unwrap_or_else(|_| serde_json::json!({}));
        // Unique 12-byte nonce so (group_id, nonce) unique index is satisfied.
        let mut hasher = Blake2b512::new();
        hasher.update(idempotency_key.as_bytes());
        let digest = hasher.finalize();
        let nonce = digest[..12].to_vec();

        Self {
            id: Uuid::new_v4(),
            group_id,
            order: None,
            sender_wallet_addr: member,
            encrypted_msg: Vec::new(),
            nonce,
            key_version: 0,
            created_at,
            updated_at: created_at,
            is_edited: false,
            sync_status: SyncStatus::Synced,
            quilt_patch_id: None,
            attachments: Vec::new(),
            signature: Vec::new(),
            public_key: Vec::new(),
            attribution: MessageAttribution::human_message(),
            kind: MessageKind::System,
            system_type: Some(system_type),
            metadata: Some(metadata),
            idempotency_key: Some(idempotency_key),
        }
    }

    pub fn is_system(&self) -> bool {
        self.kind.is_system()
    }

    /// Sets the order field (called by storage layer after determining next order)
    pub fn set_order(&mut self, order: i64) {
        self.order = Some(order);
    }

    /// Marks the message as synced to File Storage with the given quilt patchID.
    /// Updates the sync_status to SYNCED and sets the quilt_patch_id
    #[allow(dead_code)]
    pub fn mark_synced(&mut self, quilt_patch_id: String) {
        self.sync_status = SyncStatus::Synced;
        self.quilt_patch_id = Some(quilt_patch_id);
        self.updated_at = Utc::now();
    }

    /// Marks the message for deletion
    /// Sets sync_status to DELETE_PENDING
    pub fn mark_for_deletion(&mut self) {
        self.sync_status = SyncStatus::DeletePending;
        self.updated_at = Utc::now();
    }

    /// Updates the message content and marks it for re-sync
    /// Sets sync_status to UPDATE_PENDING
    pub fn update_content(
        &mut self,
        encrypted_msg: Vec<u8>,
        nonce: Vec<u8>,
        key_version: i64,
        attachments: Vec<Attachment>,
        signature: Vec<u8>,
        public_key: Vec<u8>,
    ) {
        self.encrypted_msg = encrypted_msg;
        self.nonce = nonce;
        self.key_version = key_version;
        self.attachments = attachments;
        self.signature = signature;
        self.public_key = public_key;
        self.sync_status = SyncStatus::UpdatePending;
        self.updated_at = Utc::now();
        self.is_edited = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SystemType;

    #[test]
    fn system_message_is_synced_and_cleartext() {
        let msg = Message::new_system(
            "0xgroup".into(),
            "0xmember".into(),
            SystemType::MemberJoined,
            None,
            "digest:0:member_joined".into(),
            Utc::now(),
        );
        assert!(msg.is_system());
        assert_eq!(msg.sync_status, SyncStatus::Synced);
        assert!(msg.encrypted_msg.is_empty());
        assert_eq!(msg.nonce.len(), 12);
        assert_eq!(msg.idempotency_key.as_deref(), Some("digest:0:member_joined"));
    }
}
