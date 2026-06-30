use serde::{Deserialize, Serialize};

/// Cleartext agent attribution stored alongside encrypted message content.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageAttribution {
    pub principal_owner: Option<String>,
    pub sub_agent_id: Option<String>,
    pub identity_class: Option<i16>,
    pub attribution_version: i16,
}

impl MessageAttribution {
    pub fn human_message() -> Self {
        Self {
            principal_owner: None,
            sub_agent_id: None,
            identity_class: None,
            attribution_version: 1,
        }
    }

    pub fn is_agent_message(&self) -> bool {
        self.principal_owner.is_some()
    }
}
