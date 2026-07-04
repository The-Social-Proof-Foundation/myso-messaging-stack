//! On-chain `MessagingConfig` singleton: resolve at startup, hot-reload from checkpoint events.

use std::sync::{Arc, RwLock};

use reqwest::Client;
use serde_json::{json, Value};
use thiserror::Error;
use tracing::{info, warn};

use crate::config::Config;

const DEFAULT_TESTNET_GRAPHQL_URL: &str = "https://graphql.testnet.mysocial.network/graphql";

/// Mirrors on-chain `messaging::messaging_config::MessagingConfig` fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessagingConfigSnapshot {
    pub paid_msg_platform_fee_bps: u64,
    pub paid_msg_treasury_fee_bps: u64,
    pub payment_expiration_ms: u64,
    pub min_reply_chars: u32,
    pub max_dedupe_key_bytes: u64,
}

impl Default for MessagingConfigSnapshot {
    fn default() -> Self {
        Self {
            paid_msg_platform_fee_bps: 250,
            paid_msg_treasury_fee_bps: 250,
            payment_expiration_ms: 2_592_000_000,
            min_reply_chars: 6,
            max_dedupe_key_bytes: 256,
        }
    }
}

#[derive(Debug, Error)]
pub enum MessagingConfigError {
    #[error("GraphQL request failed: {0}")]
    Graphql(String),
    #[error("JSON-RPC request failed: {0}")]
    Rpc(String),
    #[error("MessagingConfig object not found")]
    NotFound,
    #[error("MessagingConfig object has unexpected shape")]
    InvalidObject,
}

/// Shared, hot-reloadable on-chain messaging parameters.
#[derive(Clone)]
pub struct MessagingConfigCache {
    object_id: String,
    snapshot: Arc<RwLock<MessagingConfigSnapshot>>,
}

impl MessagingConfigCache {
    pub fn snapshot(&self) -> MessagingConfigSnapshot {
        self.snapshot
            .read()
            .map(|s| *s)
            .unwrap_or_default()
    }

    pub fn object_id(&self) -> &str {
        &self.object_id
    }

    pub fn apply_update(&self, update: MessagingConfigSnapshot) {
        if let Ok(mut snapshot) = self.snapshot.write() {
            info!(
                "MessagingConfig updated: min_reply_chars={} payment_expiration_ms={}",
                update.min_reply_chars, update.payment_expiration_ms
            );
            *snapshot = update;
        } else {
            warn!("MessagingConfig cache lock poisoned during update");
        }
    }

    /// Returns true when `created_at_ms + payment_expiration_ms` is still in the future.
    pub fn escrow_not_expired(&self, created_at_ms: u64, now_ms: u64) -> bool {
        let expiration = self.snapshot().payment_expiration_ms;
        created_at_ms.saturating_add(expiration) > now_ms
    }
}

pub async fn bootstrap_messaging_config_cache(
    config: &Config,
) -> Result<MessagingConfigCache, MessagingConfigError> {
    let graphql_url = config
        .myso_graphql_url
        .clone()
        .unwrap_or_else(default_graphql_url);
    let messaging_package_id = config.messaging_package_id.clone();
    let move_type = format!(
        "{messaging_package_id}::messaging_config::MessagingConfig"
    );

    let object_id = resolve_shared_object_id(&graphql_url, &move_type).await?;
    let rpc_url = config
        .myso_json_rpc_url
        .clone()
        .unwrap_or_else(default_json_rpc_url);

    let snapshot = read_config_snapshot(&rpc_url, &object_id).await?;

    info!(
        "MessagingConfig resolved: object_id={} min_reply_chars={} payment_expiration_ms={}",
        object_id, snapshot.min_reply_chars, snapshot.payment_expiration_ms
    );

    Ok(MessagingConfigCache {
        object_id,
        snapshot: Arc::new(RwLock::new(snapshot)),
    })
}

fn default_graphql_url() -> String {
    DEFAULT_TESTNET_GRAPHQL_URL.to_string()
}

fn default_json_rpc_url() -> String {
    "https://fullnode.testnet.mysocial.network:9000".to_string()
}

async fn resolve_shared_object_id(
    graphql_url: &str,
    move_type: &str,
) -> Result<String, MessagingConfigError> {
    let client = Client::new();
    let response = client
        .post(graphql_url)
        .json(&json!({
            "query": r#"
                query findSharedObject($filter: ObjectFilter!) {
                  objects(first: 2, filter: $filter) {
                    nodes { address }
                  }
                }
            "#,
            "variables": {
                "filter": {
                    "ownerKind": "SHARED",
                    "type": move_type,
                }
            }
        }))
        .send()
        .await
        .map_err(|e| MessagingConfigError::Graphql(e.to_string()))?;

    if !response.status().is_success() {
        return Err(MessagingConfigError::Graphql(format!(
            "HTTP {}",
            response.status()
        )));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| MessagingConfigError::Graphql(e.to_string()))?;

    if let Some(errors) = body.get("errors") {
        return Err(MessagingConfigError::Graphql(errors.to_string()));
    }

    let nodes = body
        .pointer("/data/objects/nodes")
        .and_then(|v| v.as_array())
        .ok_or(MessagingConfigError::NotFound)?;

    match nodes.len() {
        0 => Err(MessagingConfigError::NotFound),
        1 => nodes[0]
            .get("address")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or(MessagingConfigError::NotFound),
        n => Err(MessagingConfigError::Graphql(format!(
            "expected one MessagingConfig, found {n}"
        ))),
    }
}

async fn read_config_snapshot(
    rpc_url: &str,
    object_id: &str,
) -> Result<MessagingConfigSnapshot, MessagingConfigError> {
    let client = Client::new();
    let response = client
        .post(rpc_url)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "myso_getObject",
            "params": [object_id, { "showContent": true }]
        }))
        .send()
        .await
        .map_err(|e| MessagingConfigError::Rpc(e.to_string()))?;

    if !response.status().is_success() {
        return Err(MessagingConfigError::Rpc(format!(
            "HTTP {}",
            response.status()
        )));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| MessagingConfigError::Rpc(e.to_string()))?;

    if body.get("error").is_some() {
        return Err(MessagingConfigError::Rpc(body["error"].to_string()));
    }

    let fields = body
        .pointer("/result/data/content/fields")
        .or_else(|| body.pointer("/result/data/content/dataType/fields"))
        .ok_or(MessagingConfigError::InvalidObject)?;

    Ok(MessagingConfigSnapshot {
        paid_msg_platform_fee_bps: parse_u64_field(fields, "paid_msg_platform_fee_bps")?,
        paid_msg_treasury_fee_bps: parse_u64_field(fields, "paid_msg_treasury_fee_bps")?,
        payment_expiration_ms: parse_u64_field(fields, "payment_expiration_ms")?,
        min_reply_chars: parse_u64_field(fields, "min_reply_chars")? as u32,
        max_dedupe_key_bytes: parse_u64_field(fields, "max_dedupe_key_bytes")?,
    })
}

fn parse_u64_field(fields: &Value, name: &str) -> Result<u64, MessagingConfigError> {
    fields
        .get(name)
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse().ok())
        .ok_or(MessagingConfigError::InvalidObject)
}

/// Fallback cache with genesis defaults when GraphQL/RPC bootstrap fails.
pub fn fallback_messaging_config_cache() -> MessagingConfigCache {
    warn!(
        "Using default MessagingConfig values; set MYSO_GRAPHQL_URL and MYSO_JSON_RPC_URL for live config"
    );
    MessagingConfigCache {
        object_id: String::new(),
        snapshot: Arc::new(RwLock::new(MessagingConfigSnapshot::default())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escrow_expiry_uses_payment_expiration_ms() {
        let cache = MessagingConfigCache {
            object_id: String::new(),
            snapshot: Arc::new(RwLock::new(MessagingConfigSnapshot {
                payment_expiration_ms: 1_000,
                ..MessagingConfigSnapshot::default()
            })),
        };
        assert!(cache.escrow_not_expired(100, 500));
        assert!(!cache.escrow_not_expired(100, 1_200));
    }
}
