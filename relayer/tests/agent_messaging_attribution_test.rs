//! Unit tests for agent message attribution validation rules.

use messaging_relayer::models::MessageAttribution;

fn validate_attribution(
    sender_address: &str,
    principal_owner: Option<&str>,
    sub_agent_id: Option<&str>,
    identity_class: Option<i16>,
) -> Result<MessageAttribution, String> {
    let has_any = principal_owner.is_some() || sub_agent_id.is_some() || identity_class.is_some();
    if !has_any {
        return Ok(MessageAttribution::human_message());
    }
    let principal = principal_owner.ok_or_else(|| {
        "principal_owner required for agent attribution".to_string()
    })?;
    let sub_agent = sub_agent_id.ok_or_else(|| {
        "sub_agent_id required for agent attribution".to_string()
    })?;
    let class = identity_class.ok_or_else(|| {
        "identity_class required for agent attribution".to_string()
    })?;
    if sender_address == principal {
        return Err("sender_address cannot equal principal_owner for agent messages".into());
    }
    Ok(MessageAttribution {
        principal_owner: Some(principal.to_string()),
        sub_agent_id: Some(sub_agent.to_string()),
        identity_class: Some(class),
        attribution_version: 1,
    })
}

#[test]
fn human_message_without_attribution_fields() {
    let attr = validate_attribution("0xagent", None, None, None).unwrap();
    assert!(!attr.is_agent_message());
}

#[test]
fn agent_message_requires_complete_attribution() {
    let attr = validate_attribution(
        "0xagent",
        Some("0xprincipal"),
        Some("0xsubagent"),
        Some(0),
    )
    .unwrap();
    assert!(attr.is_agent_message());
    assert_eq!(attr.principal_owner.as_deref(), Some("0xprincipal"));
}

#[test]
fn incomplete_attribution_rejected() {
    assert!(validate_attribution("0xagent", Some("0xprincipal"), None, None).is_err());
}

#[test]
fn sender_cannot_equal_principal() {
    assert!(validate_attribution(
        "0xprincipal",
        Some("0xprincipal"),
        Some("0xsubagent"),
        Some(0),
    )
    .is_err());
}
