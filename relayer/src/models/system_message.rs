//! System message kinds and versioned metadata for the shared timeline.

use serde::{Deserialize, Serialize};

/// Top-level message kind in the shared timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    #[default]
    Text,
    System,
    Post,
    RequestPayment,
    Poll,
    TokenTransfer,
    /// Content envelope v2: any timeline message; the inner type is inside the ciphertext.
    Message,
    /// Content envelope v2: reaction / edit / delete / pin / poll vote; type and target are
    /// inside the ciphertext.
    Event,
    /// MLS commit (E2EE M4): ordered in the message log, one per epoch, never a timeline row.
    Commit,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::System => "system",
            Self::Post => "post",
            Self::RequestPayment => "request_payment",
            Self::Poll => "poll",
            Self::TokenTransfer => "token_transfer",
            Self::Message => "message",
            Self::Event => "event",
            Self::Commit => "commit",
        }
    }

    /// Parse stored / wire kind. Unknown values map to `text` for back-compat.
    pub fn parse(s: &str) -> Self {
        match s {
            "system" => Self::System,
            "post" => Self::Post,
            "request_payment" => Self::RequestPayment,
            "poll" => Self::Poll,
            "token_transfer" => Self::TokenTransfer,
            "message" => Self::Message,
            "event" => Self::Event,
            "commit" => Self::Commit,
            _ => Self::Text,
        }
    }

    /// Client-createable kinds for POST /messages. Rejects `system` and unknown.
    pub fn parse_client_kind(s: &str) -> Option<Self> {
        match s {
            "text" => Some(Self::Text),
            "post" => Some(Self::Post),
            "request_payment" => Some(Self::RequestPayment),
            "poll" => Some(Self::Poll),
            "token_transfer" => Some(Self::TokenTransfer),
            "message" => Some(Self::Message),
            "event" => Some(Self::Event),
            "commit" => Some(Self::Commit),
            _ => None,
        }
    }

    pub fn is_system(self) -> bool {
        matches!(self, Self::System)
    }

    /// Kinds that use encrypted client payloads (not cleartext system rows).
    pub fn is_encrypted_client_kind(self) -> bool {
        matches!(
            self,
            Self::Text
                | Self::Post
                | Self::RequestPayment
                | Self::Poll
                | Self::TokenTransfer
                | Self::Message
                | Self::Event
                | Self::Commit
        )
    }

    /// Content envelope v2 opaque kinds: no relayer-visible attachments or metadata allowed.
    pub fn is_opaque_v2_kind(self) -> bool {
        matches!(self, Self::Message | Self::Event | Self::Commit)
    }

    /// Rows that are not timeline messages (encrypted events, MLS commits).
    pub fn is_control(self) -> bool {
        matches!(self, Self::Event | Self::Commit)
    }

    /// 1:1 DM-only payment kinds. The relayer rejects these in groups with more than two members.
    pub fn is_dm_payment_kind(self) -> bool {
        matches!(self, Self::RequestPayment | Self::TokenTransfer)
    }

    /// Kinds whose cleartext `metadata` carries relayer-owned payment status.
    pub fn has_payment_metadata(self) -> bool {
        self.is_dm_payment_kind()
    }
}

impl std::fmt::Display for MessageKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Constrained system event types emitted in v1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SystemType {
    MemberJoined,
    MemberLeft,
    MemberRemoved,
}

impl SystemType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MemberJoined => "member_joined",
            Self::MemberLeft => "member_left",
            Self::MemberRemoved => "member_removed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "member_joined" => Some(Self::MemberJoined),
            "member_left" => Some(Self::MemberLeft),
            "member_removed" => Some(Self::MemberRemoved),
            _ => None,
        }
    }
}

impl std::fmt::Display for SystemType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Versioned cleartext metadata stored in `messages.metadata`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemMetadataV1 {
    pub version: u32,
    pub member: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
}

impl SystemMetadataV1 {
    pub const VERSION: u32 = 1;

    pub fn new(member: impl Into<String>, actor: Option<String>) -> Self {
        Self {
            version: Self::VERSION,
            member: member.into(),
            actor,
        }
    }
}

/// Typed system object exposed on the wire (never raw JSON to clients).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemMessageWire {
    #[serde(rename = "type")]
    pub system_type: String,
    pub member: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
}

impl SystemMessageWire {
    pub fn from_parts(system_type: SystemType, meta: &SystemMetadataV1) -> Self {
        Self {
            system_type: system_type.as_str().to_string(),
            member: meta.member.clone(),
            actor: meta.actor.clone(),
        }
    }
}
