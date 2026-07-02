//! Firebase Cloud Messaging (Android) — metadata-only workflow payloads.

use reqwest::Client;
use serde_json::json;
use tracing::{debug, warn};

use crate::models::PushTokenRecord;
use crate::services::push::apns::workflow_item_payload_json;

#[derive(Clone)]
pub struct FcmClient {
    http: Client,
    server_key: String,
}

impl FcmClient {
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("FCM_SERVER_KEY").ok()?;
        if key.is_empty() {
            return None;
        }
        Some(Self {
            http: Client::new(),
            server_key: key,
        })
    }

    pub fn is_fcm_token(token: &PushTokenRecord) -> bool {
        token.platform.eq_ignore_ascii_case("android")
            || token.platform.eq_ignore_ascii_case("fcm")
    }

    pub async fn send_workflow_item(
        &self,
        token: &PushTokenRecord,
        item_type: &str,
        item_id: &str,
    ) -> Result<(), String> {
        let body = json!({
            "to": token.token,
            "data": workflow_item_payload_json(item_type, item_id),
        });
        let resp = self
            .http
            .post("https://fcm.googleapis.com/fcm/send")
            .header("Authorization", format!("key={}", self.server_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            debug!("FCM workflow push sent token={}", token.token);
            Ok(())
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            warn!("FCM send failed status={status} body={text}");
            Err(format!("fcm status {status}"))
        }
    }
}
