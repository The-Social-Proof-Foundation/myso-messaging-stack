//! System message kinds and versioned metadata for the shared timeline.

use serde::{Deserialize, Serialize};

/// Top-level message kind in the shared timeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    #[default]
    Text,
    System,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::System => "system",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "system" => Self::System,
            _ => Self::Text,
        }
    }

    pub fn is_system(self) -> bool {
        matches!(self, Self::System)
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
