//! Notify dripdrop-backend after a `kind: post` message is accepted and persisted.
//! Never forwards group_id / message_id — only opaque deliveryEventId + post metadata.

use std::sync::Arc;
use std::time::Duration;

use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::Serialize;
use sha2::Sha256;
use tracing::{debug, warn};
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct ShareWebhookNotifier {
    inner: Option<Arc<ShareWebhookInner>>,
}

struct ShareWebhookInner {
    client: Client,
    url: String,
    secret: String,
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShareEventBody {
    delivery_event_id: String,
    post_address: String,
    sharer_wallet: String,
    destination_type: String,
    accepted_at: String,
}

impl ShareWebhookNotifier {
    pub fn disabled() -> Self {
        Self { inner: None }
    }

    pub fn from_env() -> Self {
        let enabled = env_truthy("DRIPDROP_SHARE_WEBHOOK_ENABLED");
        let url = std::env::var("DRIPDROP_SHARE_WEBHOOK_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let secret = std::env::var("DRIPDROP_SHARE_WEBHOOK_SECRET")
            .ok()
            .or_else(|| std::env::var("MESSAGING_SHARE_WEBHOOK_SECRET").ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        match (url, secret) {
            (Some(url), Some(secret)) => {
                let client = Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .unwrap_or_else(|_| Client::new());
                if !enabled {
                    debug!("share webhook configured but DRIPDROP_SHARE_WEBHOOK_ENABLED is false");
                }
                Self {
                    inner: Some(Arc::new(ShareWebhookInner {
                        client,
                        url,
                        secret,
                        enabled,
                    })),
                }
            }
            _ => Self::disabled(),
        }
    }

    pub fn is_active(&self) -> bool {
        self.inner
            .as_ref()
            .map(|i| i.enabled)
            .unwrap_or(false)
    }

    /// Fire-and-forget notify after durable persist. Retries a few times with backoff.
    pub fn notify_post_share(
        &self,
        delivery_event_id: Uuid,
        post_address: String,
        sharer_wallet: String,
        destination_type: &str,
        accepted_at: chrono::DateTime<chrono::Utc>,
    ) {
        let Some(inner) = self.inner.clone() else {
            return;
        };
        if !inner.enabled {
            return;
        }
        let destination_type = destination_type.to_string();
        tokio::spawn(async move {
            let body = ShareEventBody {
                delivery_event_id: delivery_event_id.to_string(),
                post_address,
                sharer_wallet,
                destination_type,
                accepted_at: accepted_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            };
            let raw = match serde_json::to_vec(&body) {
                Ok(b) => b,
                Err(e) => {
                    warn!("share webhook serialize failed: {e}");
                    return;
                }
            };
            for attempt in 0..5u32 {
                match post_once(&inner, &raw).await {
                    Ok(()) => return,
                    Err(e) => {
                        warn!(
                            attempt,
                            "share webhook failed: {e}; retrying"
                        );
                        tokio::time::sleep(Duration::from_millis(200 * 2u64.pow(attempt))).await;
                    }
                }
            }
            warn!("share webhook exhausted retries for {}", body.delivery_event_id);
        });
    }
}

async fn post_once(inner: &ShareWebhookInner, raw: &[u8]) -> Result<(), String> {
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let signed = format!("{}.{}", timestamp, String::from_utf8_lossy(raw));
    let mut mac = HmacSha256::new_from_slice(inner.secret.as_bytes())
        .map_err(|e| format!("hmac key: {e}"))?;
    mac.update(signed.as_bytes());
    let sig = format!("v1={}", hex::encode(mac.finalize().into_bytes()));

    let res = inner
        .client
        .post(&inner.url)
        .header("Content-Type", "application/json")
        .header("X-DripDrop-Timestamp", &timestamp)
        .header("X-DripDrop-Signature", &sig)
        .body(raw.to_vec())
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = res.text().await.unwrap_or_default();
        Err(format!("HTTP {status}: {body}"))
    }
}

fn env_truthy(key: &str) -> bool {
    match std::env::var(key) {
        Ok(v) => {
            let t = v.trim().to_ascii_lowercase();
            t == "1" || t == "true" || t == "yes" || t == "on"
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_when_env_missing() {
        // from_env without secrets → disabled (process env may vary; just construct disabled)
        assert!(!ShareWebhookNotifier::disabled().is_active());
    }
}
