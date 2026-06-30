//! Optional on-chain verification of agent message attribution via JSON-RPC.

use reqwest::Client;
use serde_json::{json, Value};
use thiserror::Error;
use tracing::warn;

use crate::config::Config;

#[derive(Debug, Error)]
pub enum AttributionVerifyError {
    #[error("attribution strict verify is enabled but MYSO_JSON_RPC_URL is not configured")]
    NotConfigured,
    #[error("JSON-RPC request failed: {0}")]
    RpcFailed(String),
    #[error("sub_agent_id object not found: {0}")]
    ObjectNotFound(String),
    #[error("sub_agent attribution mismatch: {0}")]
    Mismatch(String),
}

/// Verifies agent attribution against on-chain SubAgent object fields when enabled.
#[derive(Clone)]
pub struct AttributionVerifyService {
    enabled: bool,
    rpc_url: Option<String>,
    client: Client,
}

impl AttributionVerifyService {
    pub fn from_config(config: &Config) -> Self {
        Self {
            enabled: config.attribution_strict_verify,
            rpc_url: config.myso_json_rpc_url.clone(),
            client: Client::new(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub async fn verify_agent_attribution(
        &self,
        sender_address: &str,
        principal_owner: &str,
        sub_agent_id: &str,
    ) -> Result<(), AttributionVerifyError> {
        if !self.enabled {
            return Ok(());
        }

        let rpc_url = self
            .rpc_url
            .as_ref()
            .ok_or(AttributionVerifyError::NotConfigured)?;

        let response = self
            .client
            .post(rpc_url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "myso_getObject",
                "params": [
                    sub_agent_id,
                    { "showContent": true }
                ]
            }))
            .send()
            .await
            .map_err(|e| AttributionVerifyError::RpcFailed(e.to_string()))?;

        if !response.status().is_success() {
            return Err(AttributionVerifyError::RpcFailed(format!(
                "HTTP {}",
                response.status()
            )));
        }

        let body: Value = response
            .json()
            .await
            .map_err(|e| AttributionVerifyError::RpcFailed(e.to_string()))?;

        if body.get("error").is_some() {
            return Err(AttributionVerifyError::RpcFailed(
                body["error"].to_string(),
            ));
        }

        let content = body
            .pointer("/result/data/content/fields")
            .or_else(|| body.pointer("/result/data/content/dataType/fields"))
            .ok_or_else(|| AttributionVerifyError::ObjectNotFound(sub_agent_id.to_string()))?;

        let derived = extract_address_field(content, "derived_address")
            .ok_or_else(|| AttributionVerifyError::Mismatch("missing derived_address".into()))?;
        let principal = extract_address_field(content, "principal_owner")
            .ok_or_else(|| AttributionVerifyError::Mismatch("missing principal_owner".into()))?;

        if !addresses_equal(&derived, sender_address) {
            return Err(AttributionVerifyError::Mismatch(format!(
                "derived_address {derived} != sender {sender_address}"
            )));
        }
        if !addresses_equal(&principal, principal_owner) {
            return Err(AttributionVerifyError::Mismatch(format!(
                "principal_owner {principal} != attribution principal {principal_owner}"
            )));
        }

        Ok(())
    }
}

fn extract_address_field(content: &Value, field: &str) -> Option<String> {
    content.get(field).and_then(|value| {
        if let Some(s) = value.as_str() {
            return Some(s.to_string());
        }
        value.get("fields").and_then(|nested| {
            nested
                .get(field)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
        })
    })
}

fn addresses_equal(a: &str, b: &str) -> bool {
    a.trim_start_matches("0x").to_lowercase() == b.trim_start_matches("0x").to_lowercase()
}

impl AttributionVerifyService {
    pub async fn verify_agent_attribution_or_warn(
        &self,
        sender_address: &str,
        principal_owner: &str,
        sub_agent_id: &str,
    ) -> Result<(), AttributionVerifyError> {
        match self
            .verify_agent_attribution(sender_address, principal_owner, sub_agent_id)
            .await
        {
            Ok(()) => Ok(()),
            Err(AttributionVerifyError::NotConfigured) => {
                warn!(
                    "ATTRIBUTION_STRICT_VERIFY is enabled but MYSO_JSON_RPC_URL is unset; skipping on-chain verify"
                );
                Ok(())
            }
            Err(err) => Err(err),
        }
    }
}
