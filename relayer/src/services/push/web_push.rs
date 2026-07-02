//! Web Push (browser) — metadata-only workflow payloads via optional HTTP relay.

use reqwest::Client;
use serde_json::json;
use tracing::{debug, warn};

use crate::models::PushTokenRecord;
use crate::services::push::apns::workflow_item_payload_json;

#[derive(Clone)]
pub struct WebPushClient {
    http: Client,
    relay_url: String,
}

impl WebPushClient {
    pub fn from_env() -> Option<Self> {
        let url = std::env::var("WEB_PUSH_RELAY_URL").ok()?;
        if url.is_empty() {
            return None;
        }
        Some(Self {
            http: Client::new(),
            relay_url: url.trim_end_matches('/').to_string(),
        })
    }

    pub fn is_web_token(token: &PushTokenRecord) -> bool {
        token.platform.eq_ignore_ascii_case("web")
    }

    pub async fn send_workflow_item(
        &self,
        token: &PushTokenRecord,
        item_type: &str,
        item_id: &str,
    ) -> Result<(), String> {
        let body = json!({
            "subscription": token.token,
            "payload": workflow_item_payload_json(item_type, item_id),
        });
        let resp = self
            .http
            .post(format!("{}/v1/push", self.relay_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            debug!("web push workflow sent");
            Ok(())
        } else {
            warn!("web push failed status={}", resp.status());
            Err(format!("web push status {}", resp.status()))
        }
    }
}
