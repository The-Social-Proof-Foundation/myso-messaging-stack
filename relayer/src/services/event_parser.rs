//! Parses MySo events from the Groups SDK into domain types.
//! - Filters events by package ID
//! - Parses event type strings to identify PermissionsGranted/Revoked/MemberAdded/Removed
//! - Deserializes BCS-encoded event contents into Rust structs

use crate::auth::MessagingPermission;
use serde::Deserialize;
use myso_rpc::proto::myso::rpc::v2::Event;
use tracing::{debug, warn};

/// Domain events parsed from Groups SDK MySo events
#[derive(Debug, Clone)]
pub enum GroupsEvent {
    MemberAdded {
        group_id: String,
        member: String,
    },
    MemberRemoved {
        group_id: String,
        member: String,
    },
    PermissionsGranted {
        group_id: String,
        member: String,
        permissions: Vec<MessagingPermission>,
    },
    PermissionsRevoked {
        group_id: String,
        member: String,
        permissions: Vec<MessagingPermission>,
    },
}

/// GroupCreated event for agent group detection (uses object::ID BCS layout).
#[derive(Debug, Clone)]
pub struct GroupCreatedEvent {
    pub group_id: String,
    pub creator: String,
}

/// Full metadata from messaging::AgentGroupCreated (preferred over permission-pattern stub).
#[derive(Debug, Clone)]
pub struct AgentGroupCreatedEvent {
    pub group_id: String,
    pub creator_actor: String,
    pub creator_principal: String,
    pub creator_sub_agent_id: Option<String>,
    pub creator_identity_class: u64,
    pub group_name: String,
    pub group_uuid: String,
    pub created_at_ms: u64,
}

/// PermissionsGranted with full permission type names (includes PermissionsAdmin).
#[derive(Debug, Clone)]
pub struct RawPermissionsGrantedEvent {
    pub group_id: String,
    pub member: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MemberEventBcs {
    group_id: [u8; 32],
    member: [u8; 32],
}

#[derive(Debug, Deserialize)]
struct PermissionsEventBcs {
    group_id: [u8; 32],
    member: [u8; 32],
    permissions: Vec<TypeNameBcs>,
}

#[derive(Debug, Deserialize)]
struct TypeNameBcs {
    name: String,
}

#[derive(Debug, Deserialize)]
struct BcsMoveObjectId {
    bytes: [u8; 32],
}

#[derive(Debug, Deserialize)]
struct BcsGroupCreated {
    group_id: BcsMoveObjectId,
    creator: [u8; 32],
}

#[derive(Debug, Deserialize)]
struct BcsAgentGroupCreated {
    group_id: BcsMoveObjectId,
    creator_actor: [u8; 32],
    creator_principal: [u8; 32],
    creator_sub_agent_id: Option<BcsMoveObjectId>,
    creator_identity_class: u64,
    organization_id: Option<BcsMoveObjectId>,
    group_name: String,
    group_uuid: String,
    created_at: u64,
}

/// Returns true when the event type uses the messaging witness generic.
pub fn is_messaging_witness_event(event_type: &str) -> bool {
    event_type.contains("::messaging::Messaging>")
}

/// Parses a GroupCreated event from BCS bytes (object::ID wrapper for group_id).
pub fn parse_group_created(bcs_bytes: &[u8]) -> Option<GroupCreatedEvent> {
    let event_data: BcsGroupCreated = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse GroupCreated BCS: {}", e))
        .ok()?;

    Some(GroupCreatedEvent {
        group_id: format!("0x{}", hex::encode(event_data.group_id.bytes)),
        creator: format!("0x{}", hex::encode(event_data.creator)),
    })
}

/// Parses PermissionsGranted retaining full permission type name strings.
pub fn parse_raw_permissions_granted(bcs_bytes: &[u8]) -> Option<RawPermissionsGrantedEvent> {
    let event_data: PermissionsEventBcs = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse PermissionsGranted BCS: {}", e))
        .ok()?;

    Some(RawPermissionsGrantedEvent {
        group_id: format!("0x{}", hex::encode(event_data.group_id)),
        member: format!("0x{}", hex::encode(event_data.member)),
        permissions: event_data
            .permissions
            .into_iter()
            .map(|tn| tn.name)
            .collect(),
    })
}

/// Parses agent-detection events from a MySo event (GroupCreated, PermissionsGranted).
pub fn parse_agent_detection_event(
    event: &Event,
    groups_package_id: &str,
) -> Option<AgentDetectionEvent> {
    let event_type = event.event_type.as_ref()?;
    if !is_groups_package_event(event_type, groups_package_id) {
        return None;
    }
    if !is_messaging_witness_event(event_type) {
        return None;
    }

    let contents = event.contents.as_ref()?;
    let bcs_bytes = contents.value.as_ref()?;

    if event_type.contains("::GroupCreated<") {
        parse_group_created(bcs_bytes).map(AgentDetectionEvent::GroupCreated)
    } else if event_type.contains("::PermissionsGranted<") {
        parse_raw_permissions_granted(bcs_bytes).map(AgentDetectionEvent::PermissionsGranted)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub enum AgentDetectionEvent {
    GroupCreated(GroupCreatedEvent),
    PermissionsGranted(RawPermissionsGrantedEvent),
}

fn format_address(bytes: [u8; 32]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn format_object_id(id: &BcsMoveObjectId) -> String {
    format!("0x{}", hex::encode(id.bytes))
}

fn is_messaging_package_event(event_type: &str, messaging_package_id: &str) -> bool {
    let normalized_pkg = messaging_package_id.trim_start_matches("0x").to_lowercase();
    let event_type_lower = event_type.to_lowercase();
    event_type_lower.starts_with(&format!("0x{}", normalized_pkg))
        || event_type_lower.starts_with(&normalized_pkg)
}

/// Parses AgentGroupCreated from BCS bytes (messaging package event).
pub fn parse_agent_group_created_bcs(bcs_bytes: &[u8]) -> Option<AgentGroupCreatedEvent> {
    let event_data: BcsAgentGroupCreated = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse AgentGroupCreated BCS: {}", e))
        .ok()?;

    Some(AgentGroupCreatedEvent {
        group_id: format_object_id(&event_data.group_id),
        creator_actor: format_address(event_data.creator_actor),
        creator_principal: format_address(event_data.creator_principal),
        creator_sub_agent_id: event_data
            .creator_sub_agent_id
            .as_ref()
            .map(format_object_id),
        creator_identity_class: event_data.creator_identity_class,
        group_name: event_data.group_name,
        group_uuid: event_data.group_uuid,
        created_at_ms: event_data.created_at,
    })
}

/// Parses AgentGroupCreated from a MySo checkpoint event.
pub fn parse_agent_group_created_event(
    event: &Event,
    messaging_package_id: &str,
) -> Option<AgentGroupCreatedEvent> {
    let event_type = event.event_type.as_ref()?;
    if !event_type.contains("::messaging::AgentGroupCreated") {
        return None;
    }
    if !is_messaging_package_event(event_type, messaging_package_id) {
        return None;
    }
    let contents = event.contents.as_ref()?;
    let bcs_bytes = contents.value.as_ref()?;
    parse_agent_group_created_bcs(bcs_bytes)
}

fn is_groups_package_event(event_type: &str, groups_package_id: &str) -> bool {
    let normalized_pkg = groups_package_id.trim_start_matches("0x").to_lowercase();
    let event_type_lower = event_type.to_lowercase();
    event_type_lower.starts_with(&format!("0x{}", normalized_pkg))
        || event_type_lower.starts_with(&normalized_pkg)
}

/// Parses a MySo event into a GroupsEvent if it's from our Groups SDK package.
pub fn parse_myso_event(event: &Event, groups_package_id: &str) -> Option<GroupsEvent> {
    // Get the event type string ("0x...::permissioned_group::PermissionsGranted<0x...::messaging::Messaging>")
    let event_type = event.event_type.as_ref()?;

    if !is_groups_package_event(event_type, groups_package_id) {
        return None;
    }

    debug!("Matched event from Groups SDK package: {}", event_type);

    let contents = event.contents.as_ref()?;
    let bcs_bytes = contents.value.as_ref()?;

    let result = if event_type.contains("::PermissionsGranted<") {
        parse_permissions_granted(bcs_bytes)
    } else if event_type.contains("::PermissionsRevoked<") {
        parse_permissions_revoked(bcs_bytes)
    } else if event_type.contains("::MemberAdded<") {
        parse_member_added(bcs_bytes)
    } else if event_type.contains("::MemberRemoved<") {
        parse_member_removed(bcs_bytes)
    } else {
        debug!("Unknown event type from Groups SDK: {}", event_type);
        None
    };

    if let Some(ref evt) = result {
        debug!("Successfully parsed event: {:?}", evt);
    }

    result
}

/// Parses a PermissionsGranted event from BCS bytes
fn parse_permissions_granted(bcs_bytes: &[u8]) -> Option<GroupsEvent> {
    let event_data: PermissionsEventBcs = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse PermissionsGranted BCS: {}", e))
        .ok()?;

    let group_id = format!("0x{}", hex::encode(event_data.group_id));
    let member = format!("0x{}", hex::encode(event_data.member));

    let permissions = event_data
        .permissions
        .iter()
        .filter_map(|tn| MessagingPermission::from_type_name(&tn.name))
        .collect();

    Some(GroupsEvent::PermissionsGranted {
        group_id,
        member,
        permissions,
    })
}

/// Parses a PermissionsRevoked event from BCS bytes
fn parse_permissions_revoked(bcs_bytes: &[u8]) -> Option<GroupsEvent> {
    let event_data: PermissionsEventBcs = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse PermissionsRevoked BCS: {}", e))
        .ok()?;

    let group_id = format!("0x{}", hex::encode(event_data.group_id));
    let member = format!("0x{}", hex::encode(event_data.member));

    let permissions = event_data
        .permissions
        .iter()
        .filter_map(|tn| MessagingPermission::from_type_name(&tn.name))
        .collect();

    Some(GroupsEvent::PermissionsRevoked {
        group_id,
        member,
        permissions,
    })
}

/// Parses a MemberAdded event from BCS bytes
fn parse_member_added(bcs_bytes: &[u8]) -> Option<GroupsEvent> {
    let event_data: MemberEventBcs = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse MemberAdded BCS: {}", e))
        .ok()?;

    let group_id = format!("0x{}", hex::encode(event_data.group_id));
    let member = format!("0x{}", hex::encode(event_data.member));

    Some(GroupsEvent::MemberAdded { group_id, member })
}

/// Parses a MemberRemoved event from BCS bytes
fn parse_member_removed(bcs_bytes: &[u8]) -> Option<GroupsEvent> {
    let event_data: MemberEventBcs = bcs::from_bytes(bcs_bytes)
        .map_err(|e| warn!("Failed to parse MemberRemoved BCS: {}", e))
        .ok()?;

    let group_id = format!("0x{}", hex::encode(event_data.group_id));
    let member = format!("0x{}", hex::encode(event_data.member));

    Some(GroupsEvent::MemberRemoved { group_id, member })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize)]
    struct BcsMoveObjectId {
        bytes: [u8; 32],
    }

    #[derive(serde::Serialize)]
    struct BcsGroupCreated {
        group_id: BcsMoveObjectId,
        creator: [u8; 32],
    }

    #[test]
    fn parse_group_created_uses_object_id_wrapper() {
        let group_bytes = [0x11u8; 32];
        let creator_bytes = [0x22u8; 32];
        let bcs = bcs::to_bytes(&BcsGroupCreated {
            group_id: BcsMoveObjectId { bytes: group_bytes },
            creator: creator_bytes,
        })
        .unwrap();

        let parsed = parse_group_created(&bcs).expect("GroupCreated should parse");
        assert_eq!(parsed.group_id, format!("0x{}", hex::encode(group_bytes)));
        assert_eq!(parsed.creator, format!("0x{}", hex::encode(creator_bytes)));
    }

    #[test]
    fn parse_raw_permissions_granted_keeps_admin_type_name() {
        #[derive(serde::Serialize)]
        struct TypeName {
            name: String,
        }

        #[derive(serde::Serialize)]
        struct PermissionsEventBcs {
            group_id: [u8; 32],
            member: [u8; 32],
            permissions: Vec<TypeName>,
        }

        let bcs = bcs::to_bytes(&PermissionsEventBcs {
            group_id: [0x33u8; 32],
            member: [0x44u8; 32],
            permissions: vec![TypeName {
                name: "0x2::permissioned_group::PermissionsAdmin".to_string(),
            }],
        })
        .unwrap();

        let parsed = parse_raw_permissions_granted(&bcs).expect("PermissionsGranted should parse");
        assert!(parsed
            .permissions
            .iter()
            .any(|p| p.ends_with("::PermissionsAdmin")));
    }

    #[test]
    fn parse_agent_group_created_bcs_round_trip() {
        #[derive(serde::Serialize)]
        struct BcsAgentGroupCreated {
            group_id: BcsMoveObjectId,
            creator_actor: [u8; 32],
            creator_principal: [u8; 32],
            creator_sub_agent_id: Option<BcsMoveObjectId>,
            creator_identity_class: u64,
            organization_id: Option<BcsMoveObjectId>,
            group_name: String,
            group_uuid: String,
            created_at: u64,
        }

        let sub_agent = [0x55u8; 32];
        let bcs = bcs::to_bytes(&BcsAgentGroupCreated {
            group_id: BcsMoveObjectId { bytes: [0x11u8; 32] },
            creator_actor: [0x22u8; 32],
            creator_principal: [0x33u8; 32],
            creator_sub_agent_id: Some(BcsMoveObjectId { bytes: sub_agent }),
            creator_identity_class: 1,
            organization_id: None,
            group_name: "Support".to_string(),
            group_uuid: "uuid-1".to_string(),
            created_at: 1_700_000_000_000,
        })
        .unwrap();

        let parsed = parse_agent_group_created_bcs(&bcs).expect("AgentGroupCreated should parse");
        assert_eq!(parsed.group_name, "Support");
        assert_eq!(parsed.group_uuid, "uuid-1");
        assert_eq!(
            parsed.creator_sub_agent_id,
            Some(format!("0x{}", hex::encode(sub_agent)))
        );
        assert_eq!(parsed.creator_identity_class, 1);
    }
}
