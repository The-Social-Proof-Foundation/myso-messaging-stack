//! Detects agent-associated messaging groups from permissioned-group events per transaction.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, TimeZone, Utc};

use crate::models::AgentMessagingGroup;

use super::event_parser::{AgentGroupCreatedEvent, GroupCreatedEvent, RawPermissionsGrantedEvent};

pub fn agent_group_from_created_event(
    created: &AgentGroupCreatedEvent,
) -> AgentMessagingGroup {
    let created_at = Utc
        .timestamp_millis_opt(created.created_at_ms as i64)
        .single()
        .unwrap_or_else(Utc::now);

    AgentMessagingGroup {
        group_id: created.group_id.clone(),
        creator_actor: created.creator_actor.clone(),
        creator_principal: created.creator_principal.clone(),
        creator_sub_agent_id: created.creator_sub_agent_id.clone(),
        creator_identity_class: Some(created.creator_identity_class as i16),
        group_name: Some(created.group_name.clone()),
        group_uuid: Some(created.group_uuid.clone()),
        created_at,
    }
}

pub fn detect_agent_groups_in_transaction(
    group_created: &[GroupCreatedEvent],
    permissions_granted: &[RawPermissionsGrantedEvent],
    agent_group_created: &HashMap<String, AgentGroupCreatedEvent>,
    fallback_created_at: DateTime<Utc>,
) -> Vec<AgentMessagingGroup> {
    let mut grants: HashMap<(String, String), HashSet<String>> = HashMap::new();

    for grant in permissions_granted {
        let entry = grants
            .entry((grant.group_id.clone(), grant.member.clone()))
            .or_default();
        for perm in &grant.permissions {
            entry.insert(perm.clone());
        }
    }

    group_created
        .iter()
        .filter_map(|created| {
            if let Some(metadata) = agent_group_created.get(&created.group_id) {
                return Some(agent_group_from_created_event(metadata));
            }

            detect_agent_group_pattern(&grants, &created.group_id, &created.creator).map(
                |(principal, agent_actor)| AgentMessagingGroup {
                    group_id: created.group_id.clone(),
                    creator_actor: agent_actor,
                    creator_principal: principal,
                    creator_sub_agent_id: None,
                    creator_identity_class: None,
                    group_name: None,
                    group_uuid: None,
                    created_at: fallback_created_at,
                },
            )
        })
        .collect()
}

fn has_permission(permissions: &HashSet<String>, suffix: &str) -> bool {
    permissions.iter().any(|p| p.ends_with(suffix))
}

fn detect_agent_group_pattern(
    grants: &HashMap<(String, String), HashSet<String>>,
    group_id: &str,
    creator: &str,
) -> Option<(String, String)> {
    let mut principal: Option<String> = None;
    let mut agent_actor: Option<String> = None;

    for ((gid, member), permissions) in grants {
        if gid != group_id {
            continue;
        }
        let is_admin = has_permission(permissions, "::PermissionsAdmin");
        let is_reader = has_permission(permissions, "::MessagingReader");
        let is_sender = has_permission(permissions, "::MessagingSender");

        if is_admin && is_reader && !is_sender {
            principal = Some(member.clone());
        }
        if is_sender && !is_admin && member == creator {
            agent_actor = Some(member.clone());
        }
    }

    match (principal, agent_actor) {
        (Some(p), Some(a)) if p != a => Some((p, a)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_principal_oversight_pattern() {
        let mut grants = HashMap::new();
        grants.insert(
            ("0xgroup".to_string(), "0xprincipal".to_string()),
            HashSet::from([
                "0x2::permissioned_group::PermissionsAdmin".to_string(),
                "0xe110::messaging::MessagingReader".to_string(),
            ]),
        );
        grants.insert(
            ("0xgroup".to_string(), "0xagent".to_string()),
            HashSet::from([
                "0xe110::messaging::MessagingSender".to_string(),
                "0xe110::messaging::MessagingReader".to_string(),
            ]),
        );

        let result = detect_agent_group_pattern(&grants, "0xgroup", "0xagent");
        assert_eq!(
            result,
            Some(("0xprincipal".to_string(), "0xagent".to_string()))
        );
    }

    #[test]
    fn detects_from_transaction_events() {
        let created = vec![GroupCreatedEvent {
            group_id: "0xgroup".to_string(),
            creator: "0xagent".to_string(),
        }];
        let granted = vec![
            RawPermissionsGrantedEvent {
                group_id: "0xgroup".to_string(),
                member: "0xprincipal".to_string(),
                permissions: vec![
                    "0x2::permissioned_group::PermissionsAdmin".to_string(),
                    "0xe110::messaging::MessagingReader".to_string(),
                ],
            },
            RawPermissionsGrantedEvent {
                group_id: "0xgroup".to_string(),
                member: "0xagent".to_string(),
                permissions: vec!["0xe110::messaging::MessagingSender".to_string()],
            },
        ];

        let rows = detect_agent_groups_in_transaction(&created, &granted, &HashMap::new(), Utc::now());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].creator_principal, "0xprincipal");
        assert_eq!(rows[0].creator_actor, "0xagent");
    }

    #[test]
    fn prefers_agent_group_created_metadata() {
        let created = vec![GroupCreatedEvent {
            group_id: "0xgroup".to_string(),
            creator: "0xagent".to_string(),
        }];
        let mut agent_created = HashMap::new();
        agent_created.insert(
            "0xgroup".to_string(),
            AgentGroupCreatedEvent {
                group_id: "0xgroup".to_string(),
                creator_actor: "0xagent".to_string(),
                creator_principal: "0xprincipal".to_string(),
                creator_sub_agent_id: Some("0xsub".to_string()),
                creator_identity_class: 2,
                group_name: "Agent DM".to_string(),
                group_uuid: "uuid".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        );

        let rows = detect_agent_groups_in_transaction(&created, &[], &agent_created, Utc::now());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].creator_sub_agent_id.as_deref(), Some("0xsub"));
        assert_eq!(rows[0].group_name.as_deref(), Some("Agent DM"));
        assert_eq!(rows[0].creator_identity_class, Some(2));
    }
}
