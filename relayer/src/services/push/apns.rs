//! HTTP/2 APNs client (optional — requires credentials).

use std::fs::File;
use std::io::Read;

use a2::error::Error as A2Error;
use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, NotificationBuilder,
    NotificationOptions, Priority, PushType,
};
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::models::{MessageAttribution, PushTokenRecord};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApnsEnvironment {
    Sandbox,
    Production,
}

impl ApnsEnvironment {
    pub fn from_config_str(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "sandbox" => Ok(Self::Sandbox),
            "production" => Ok(Self::Production),
            other => Err(format!(
                "Invalid APNS_ENVIRONMENT '{}': expected sandbox or production",
                other
            )),
        }
    }

    pub fn from_token_str(value: &str) -> Result<Self, String> {
        Self::from_config_str(value)
    }

    fn to_a2_endpoint(self) -> Endpoint {
        match self {
            Self::Sandbox => Endpoint::Sandbox,
            Self::Production => Endpoint::Production,
        }
    }
}

pub fn apns_host(environment: &ApnsEnvironment) -> &'static str {
    match environment {
        ApnsEnvironment::Sandbox => "https://api.sandbox.push.apple.com",
        ApnsEnvironment::Production => "https://api.push.apple.com",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApnsSendError {
    EnvironmentMismatch,
    Unregistered,
    InvalidToken,
    Transient(String),
    Other(String),
}

impl std::fmt::Display for ApnsSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EnvironmentMismatch => write!(f, "token environment does not match server"),
            Self::Unregistered => write!(f, "device token unregistered"),
            Self::InvalidToken => write!(f, "invalid device token"),
            Self::Transient(msg) => write!(f, "transient APNs error: {msg}"),
            Self::Other(msg) => write!(f, "APNs error: {msg}"),
        }
    }
}

#[derive(Clone)]
enum ApnsBackend {
    A2(Client),
    HttpTest {
        client: reqwest::Client,
        base_url: String,
    },
}

#[derive(Clone)]
pub struct ApnsClient {
    bundle_id: String,
    environment: ApnsEnvironment,
    backend: ApnsBackend,
}

pub fn workflow_item_payload_json(item_type: &str, item_id: &str) -> Value {
    json!({
        "aps": { "content-available": 1 },
        "item_type": item_type,
        "item_id": item_id,
    })
}

pub fn new_message_payload_json(
    group_id: &str,
    attribution: &MessageAttribution,
) -> Value {
    if minimal_push_payload() {
        // The app does a full inbox refresh on a bare wake; Apple learns no group.
        return json!({ "aps": { "content-available": 1 }, "relayer_wake": true });
    }
    let mut payload = json!({
        "aps": { "content-available": 1 },
        "group_id": group_id,
        "is_agent_message": attribution.is_agent_message(),
    });
    if let Some(principal) = &attribution.principal_owner {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("principal_owner".to_string(), json!(principal));
        }
    }
    payload
}

/// APNs rejects payloads over 4096 bytes. Leave headroom for the `aps` block a2 rebuilds.
const ALERT_PAYLOAD_BUDGET_BYTES: usize = 3800;

/// `PUSH_MINIMAL_PAYLOAD=true`: APNs payloads carry only `message_id` + the per-device encrypted
/// preview, which now holds the group / sender routing. Apple learns nothing about who talks to whom.
/// Turn on only once every iOS build in use reads routing from the envelope.
fn minimal_push_payload() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| {
        std::env::var("PUSH_MINIMAL_PAYLOAD")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false)
    })
}

pub fn new_message_alert_payload_json(
    group_id: &str,
    message_id: uuid::Uuid,
    sender_wallet: &str,
    message_kind: &str,
    encrypted_notification: Option<&str>,
    message_wire: Option<&Value>,
    attribution: &MessageAttribution,
) -> Value {
    if minimal_push_payload() {
        return minimal_alert_payload_json(message_id, encrypted_notification);
    }
    let mut payload = json!({
        "aps": {
            "alert": {
                "title": "New message",
                "body": "Open to read"
            },
            "sound": "default",
            "mutable-content": 1
        },
        "group_id": group_id,
        "message_id": message_id.to_string(),
        "sender_wallet": sender_wallet,
        "message_kind": message_kind,
        "is_agent_message": attribution.is_agent_message(),
    });
    if let Some(envelope) = encrypted_notification {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("encrypted_notification".to_string(), json!(envelope));
        }
    }
    if let Some(principal) = &attribution.principal_owner {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("principal_owner".to_string(), json!(principal));
        }
    }
    // Full message wire (still E2E ciphertext) so the iOS Notification Service Extension can
    // decrypt with its cached group key and the chat opens without a fetch + decrypt.
    // Best-effort: long messages that would overflow the APNs limit are left out.
    if let Some(wire) = message_wire {
        let base_len = serde_json::to_vec(&payload).map(|v| v.len()).unwrap_or(usize::MAX);
        let wire_len = serde_json::to_vec(wire).map(|v| v.len()).unwrap_or(usize::MAX);
        // `,"message":` separator overhead.
        if base_len.saturating_add(wire_len).saturating_add(12) <= ALERT_PAYLOAD_BUDGET_BYTES {
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("message".to_string(), wire.clone());
            }
        }
    }
    payload
}

/// Metadata-free alert: no group, sender, kind or message wire — only the opaque id and the
/// device-sealed preview. The NSE restores routing from the decrypted envelope.
pub fn minimal_alert_payload_json(message_id: uuid::Uuid, encrypted_notification: Option<&str>) -> Value {
    let mut payload = json!({
        "aps": {
            "alert": { "title": "New message", "body": "Open to read" },
            "sound": "default",
            "mutable-content": 1
        },
        "message_id": message_id.to_string(),
    });
    if let (Some(envelope), Some(obj)) = (encrypted_notification, payload.as_object_mut()) {
        obj.insert("encrypted_notification".to_string(), json!(envelope));
    }
    payload
}

impl ApnsClient {
    pub fn from_config(config: &Config) -> Option<Self> {
        // Empty strings (blank dashboard vars) count as unset; say which one is missing,
        // since a silent `None` here is the only symptom of a misconfigured relayer.
        let non_empty = |value: &Option<String>| {
            value.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
        };
        let Some(key_id) = non_empty(&config.apns_key_id) else {
            warn!("APNs disabled: APNS_KEY_ID is not set");
            return None;
        };
        let Some(team_id) = non_empty(&config.apns_team_id) else {
            warn!("APNs disabled: APNS_TEAM_ID is not set");
            return None;
        };
        let Some(bundle_id) = non_empty(&config.apns_bundle_id) else {
            warn!("APNs disabled: APNS_BUNDLE_ID is not set");
            return None;
        };
        let environment = match ApnsEnvironment::from_config_str(&config.apns_environment) {
            Ok(environment) => environment,
            Err(err) => {
                warn!("APNs disabled: {}", err);
                return None;
            }
        };

        // Key contents from APNS_AUTH_KEY win; otherwise read the APNS_AUTH_KEY_PATH file.
        let key_bytes: Vec<u8> = if let Some(key) = &config.apns_auth_key {
            key.expose().as_bytes().to_vec()
        } else {
            let Some(path) = non_empty(&config.apns_auth_key_path) else {
                warn!("APNs disabled: set APNS_AUTH_KEY (key contents) or APNS_AUTH_KEY_PATH");
                return None;
            };
            let mut key_file = match File::open(&path) {
                Ok(file) => file,
                Err(err) => {
                    warn!("Failed to open APNS_AUTH_KEY_PATH '{}': {}", path, err);
                    return None;
                }
            };
            let mut bytes = Vec::new();
            if let Err(err) = key_file.read_to_end(&mut bytes) {
                warn!("Failed to read APNS auth key from '{}': {}", path, err);
                return None;
            }
            bytes
        };

        let client_config = ClientConfig::new(environment.to_a2_endpoint());
        let client = match Client::token(
            key_bytes.as_slice(),
            key_id,
            team_id,
            client_config,
        ) {
            Ok(client) => client,
            Err(err) => {
                warn!("Failed to create APNs client: {}", err);
                return None;
            }
        };

        info!(
            "APNs client initialized: host={} env={:?} topic={}",
            apns_host(&environment),
            environment,
            bundle_id
        );

        Some(Self {
            bundle_id,
            environment,
            backend: ApnsBackend::A2(client),
        })
    }

    /// Test-only constructor that sends HTTP requests to a mock APNs base URL.
    #[doc(hidden)]
    pub fn from_test_http(base_url: String, bundle_id: String, environment: ApnsEnvironment) -> Self {
        Self {
            bundle_id,
            environment,
            backend: ApnsBackend::HttpTest {
                client: reqwest::Client::new(),
                base_url,
            },
        }
    }

    pub fn environment(&self) -> ApnsEnvironment {
        self.environment
    }

    pub fn is_ios_token(token: &PushTokenRecord) -> bool {
        token.platform.eq_ignore_ascii_case("ios")
    }

    pub fn token_environment_matches(&self, token: &PushTokenRecord) -> bool {
        ApnsEnvironment::from_token_str(&token.environment)
            .map(|env| env == self.environment)
            .unwrap_or(false)
    }

    pub async fn send_new_message(
        &self,
        token: &PushTokenRecord,
        group_id: &str,
        attribution: &crate::models::MessageAttribution,
    ) -> Result<(), ApnsSendError> {
        if !Self::is_ios_token(token) {
            return Err(ApnsSendError::Other("non-ios platform".to_string()));
        }

        let token_environment = ApnsEnvironment::from_token_str(&token.environment)
            .map_err(ApnsSendError::Other)?;
        if token_environment != self.environment {
            return Err(ApnsSendError::EnvironmentMismatch);
        }

        match &self.backend {
            ApnsBackend::A2(client) => {
                self.send_via_a2(client, token, group_id, attribution)
                    .await
            }
            ApnsBackend::HttpTest { client, base_url } => {
                self.send_via_http_test(
                    client,
                    base_url,
                    token,
                    group_id,
                    attribution,
                )
                .await
            }
        }
    }

    pub async fn send_new_message_alert(
        &self,
        token: &PushTokenRecord,
        group_id: &str,
        message_id: uuid::Uuid,
        sender_wallet: &str,
        message_kind: &str,
        encrypted_notification: Option<&str>,
        message_wire: Option<&Value>,
        attribution: &crate::models::MessageAttribution,
    ) -> Result<(), ApnsSendError> {
        if !Self::is_ios_token(token) {
            return Err(ApnsSendError::Other("non-ios platform".to_string()));
        }

        let token_environment = ApnsEnvironment::from_token_str(&token.environment)
            .map_err(ApnsSendError::Other)?;
        if token_environment != self.environment {
            return Err(ApnsSendError::EnvironmentMismatch);
        }

        match &self.backend {
            ApnsBackend::A2(client) => {
                self.send_alert_via_a2(
                    client,
                    token,
                    group_id,
                    message_id,
                    sender_wallet,
                    message_kind,
                    encrypted_notification,
                    message_wire,
                    attribution,
                )
                .await
            }
            ApnsBackend::HttpTest { client, base_url } => {
                self.send_alert_via_http_test(
                    client,
                    base_url,
                    token,
                    group_id,
                    message_id,
                    sender_wallet,
                    message_kind,
                    encrypted_notification,
                    message_wire,
                    attribution,
                )
                .await
            }
        }
    }

    pub async fn send_workflow_item(
        &self,
        token: &PushTokenRecord,
        item_type: &str,
        item_id: &str,
    ) -> Result<(), ApnsSendError> {
        if !Self::is_ios_token(token) {
            return Err(ApnsSendError::Other("non-ios platform".to_string()));
        }

        let token_environment = ApnsEnvironment::from_token_str(&token.environment)
            .map_err(ApnsSendError::Other)?;
        if token_environment != self.environment {
            return Err(ApnsSendError::EnvironmentMismatch);
        }

        match &self.backend {
            ApnsBackend::A2(client) => {
                self.send_workflow_via_a2(client, token, item_type, item_id)
                    .await
            }
            ApnsBackend::HttpTest { client, base_url } => {
                self.send_workflow_via_http_test(client, base_url, token, item_type, item_id)
                    .await
            }
        }
    }

    async fn send_workflow_via_a2(
        &self,
        client: &Client,
        token: &PushTokenRecord,
        item_type: &str,
        item_id: &str,
    ) -> Result<(), ApnsSendError> {
        let mut payload = DefaultNotificationBuilder::new()
            .set_content_available()
            .build(
                &token.token,
                NotificationOptions {
                    apns_topic: Some(&self.bundle_id),
                    apns_push_type: Some(PushType::Background),
                    apns_priority: Some(Priority::Normal),
                    ..Default::default()
                },
            );
        payload
            .add_custom_data("item_type", &item_type)
            .map_err(|err| ApnsSendError::Other(err.to_string()))?;
        payload
            .add_custom_data("item_id", &item_id)
            .map_err(|err| ApnsSendError::Other(err.to_string()))?;

        debug!(
            "APNs workflow push: topic={} env={:?} token={} item_type={} item_id={}",
            self.bundle_id, self.environment, token.token, item_type, item_id
        );

        match client.send(payload).await {
            Ok(_) => Ok(()),
            Err(A2Error::ResponseError(response)) => map_apns_status(response.code),
            Err(A2Error::RequestTimeout(secs)) => Err(ApnsSendError::Transient(format!(
                "request timeout after {secs}s"
            ))),
            Err(err) => classify_a2_error(err),
        }
    }

    async fn send_workflow_via_http_test(
        &self,
        client: &reqwest::Client,
        base_url: &str,
        token: &PushTokenRecord,
        item_type: &str,
        item_id: &str,
    ) -> Result<(), ApnsSendError> {
        let url = format!(
            "{}/3/device/{}",
            base_url.trim_end_matches('/'),
            token.token
        );
        let body = workflow_item_payload_json(item_type, item_id);

        let response = client
            .post(url)
            .header("apns-topic", &self.bundle_id)
            .header("apns-push-type", "background")
            .header("apns-priority", "5")
            .json(&body)
            .send()
            .await
            .map_err(|err| ApnsSendError::Transient(err.to_string()))?;

        map_apns_status(response.status().as_u16())
    }

    async fn send_via_a2(
        &self,
        client: &Client,
        token: &PushTokenRecord,
        group_id: &str,
        attribution: &crate::models::MessageAttribution,
    ) -> Result<(), ApnsSendError> {
        let mut payload = DefaultNotificationBuilder::new()
            .set_content_available()
            .build(
                &token.token,
                NotificationOptions {
                    apns_topic: Some(&self.bundle_id),
                    apns_push_type: Some(PushType::Background),
                    apns_priority: Some(Priority::Normal),
                    ..Default::default()
                },
            );
        payload
            .add_custom_data("group_id", &group_id)
            .map_err(|err| ApnsSendError::Other(err.to_string()))?;
        payload
            .add_custom_data("is_agent_message", &attribution.is_agent_message())
            .map_err(|err| ApnsSendError::Other(err.to_string()))?;
        if let Some(principal) = &attribution.principal_owner {
            payload
                .add_custom_data("principal_owner", principal)
                .map_err(|err| ApnsSendError::Other(err.to_string()))?;
        }

        debug!(
            "APNs metadata push: topic={} env={:?} token={} group={}",
            self.bundle_id, self.environment, token.token, group_id
        );

        match client.send(payload).await {
            Ok(_) => Ok(()),
            Err(A2Error::ResponseError(response)) => map_apns_status(response.code),
            Err(A2Error::RequestTimeout(secs)) => Err(ApnsSendError::Transient(format!(
                "request timeout after {secs}s"
            ))),
            Err(err) => classify_a2_error(err),
        }
    }

    async fn send_alert_via_a2(
        &self,
        client: &Client,
        token: &PushTokenRecord,
        group_id: &str,
        message_id: uuid::Uuid,
        sender_wallet: &str,
        message_kind: &str,
        encrypted_notification: Option<&str>,
        message_wire: Option<&Value>,
        attribution: &crate::models::MessageAttribution,
    ) -> Result<(), ApnsSendError> {
        let body = new_message_alert_payload_json(
            group_id,
            message_id,
            sender_wallet,
            message_kind,
            encrypted_notification,
            message_wire,
            attribution,
        );
        let mut payload = DefaultNotificationBuilder::new()
            .set_title("New message")
            .set_body("Open to read")
            .set_mutable_content()
            .set_sound("default")
            .build(
                &token.token,
                NotificationOptions {
                    apns_topic: Some(&self.bundle_id),
                    apns_push_type: Some(PushType::Alert),
                    apns_priority: Some(Priority::High),
                    ..Default::default()
                },
            );
        if let Some(obj) = body.as_object() {
            for (key, value) in obj {
                if key == "aps" {
                    continue;
                }
                payload
                    .add_custom_data(key, value)
                    .map_err(|err| ApnsSendError::Other(err.to_string()))?;
            }
        }

        debug!(
            "APNs alert push: topic={} env={:?} token={} group={} message={}",
            self.bundle_id, self.environment, token.token, group_id, message_id
        );

        match client.send(payload).await {
            Ok(_) => Ok(()),
            Err(A2Error::ResponseError(response)) => map_apns_status(response.code),
            Err(A2Error::RequestTimeout(secs)) => Err(ApnsSendError::Transient(format!(
                "request timeout after {secs}s"
            ))),
            Err(err) => classify_a2_error(err),
        }
    }

    async fn send_via_http_test(
        &self,
        client: &reqwest::Client,
        base_url: &str,
        token: &PushTokenRecord,
        group_id: &str,
        attribution: &crate::models::MessageAttribution,
    ) -> Result<(), ApnsSendError> {
        let url = format!(
            "{}/3/device/{}",
            base_url.trim_end_matches('/'),
            token.token
        );
        let body = new_message_payload_json(group_id, attribution);

        let response = client
            .post(url)
            .header("apns-topic", &self.bundle_id)
            .header("apns-push-type", "background")
            .header("apns-priority", "5")
            .json(&body)
            .send()
            .await
            .map_err(|err| ApnsSendError::Transient(err.to_string()))?;

        map_apns_status(response.status().as_u16())
    }

    async fn send_alert_via_http_test(
        &self,
        client: &reqwest::Client,
        base_url: &str,
        token: &PushTokenRecord,
        group_id: &str,
        message_id: uuid::Uuid,
        sender_wallet: &str,
        message_kind: &str,
        encrypted_notification: Option<&str>,
        message_wire: Option<&Value>,
        attribution: &crate::models::MessageAttribution,
    ) -> Result<(), ApnsSendError> {
        let url = format!(
            "{}/3/device/{}",
            base_url.trim_end_matches('/'),
            token.token
        );
        let body = new_message_alert_payload_json(
            group_id,
            message_id,
            sender_wallet,
            message_kind,
            encrypted_notification,
            message_wire,
            attribution,
        );

        let response = client
            .post(url)
            .header("apns-topic", &self.bundle_id)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(&body)
            .send()
            .await
            .map_err(|err| ApnsSendError::Transient(err.to_string()))?;

        map_apns_status(response.status().as_u16())
    }
}

fn map_apns_status(code: u16) -> Result<(), ApnsSendError> {
    match code {
        200 => Ok(()),
        410 => Err(ApnsSendError::Unregistered),
        400 => Err(ApnsSendError::InvalidToken),
        500..=599 => Err(ApnsSendError::Transient(format!("APNs status {code}"))),
        other => Err(ApnsSendError::Other(format!("APNs status {other}"))),
    }
}

fn classify_a2_error(err: A2Error) -> Result<(), ApnsSendError> {
    match err {
        A2Error::ConnectionError(_) | A2Error::ClientError(_) | A2Error::Tls(_) => {
            Err(ApnsSendError::Transient(err.to_string()))
        }
        other => Err(ApnsSendError::Other(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn sample_token(environment: &str) -> PushTokenRecord {
        PushTokenRecord {
            wallet: "0xabc".to_string(),
            platform: "ios".to_string(),
            token: "a".repeat(64),
            environment: environment.to_string(),
            device_id: None,
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn parses_sandbox_environment() {
        assert_eq!(
            ApnsEnvironment::from_config_str("sandbox").unwrap(),
            ApnsEnvironment::Sandbox
        );
        assert_eq!(
            ApnsEnvironment::from_config_str("SANDBOX").unwrap(),
            ApnsEnvironment::Sandbox
        );
    }

    #[test]
    fn parses_production_environment() {
        assert_eq!(
            ApnsEnvironment::from_config_str("production").unwrap(),
            ApnsEnvironment::Production
        );
    }

    #[test]
    fn rejects_invalid_environment() {
        assert!(ApnsEnvironment::from_config_str("staging").is_err());
    }

    #[test]
    fn apns_host_urls() {
        assert_eq!(
            apns_host(&ApnsEnvironment::Sandbox),
            "https://api.sandbox.push.apple.com"
        );
        assert_eq!(
            apns_host(&ApnsEnvironment::Production),
            "https://api.push.apple.com"
        );
    }

    #[test]
    fn new_message_payload_shape() {
        let payload = new_message_payload_json(
            "group-123",
            &MessageAttribution::human_message(),
        );
        assert_eq!(payload["aps"]["content-available"], 1);
        assert_eq!(payload["group_id"], "group-123");
        // Unread is client-owned (read state is E2E); the relayer never sends a count.
        assert!(payload.get("message_unread_count").is_none());
        assert_eq!(payload["is_agent_message"], false);
    }

    #[test]
    fn minimal_payload_carries_no_routing_metadata() {
        let payload = minimal_alert_payload_json(uuid::Uuid::nil(), Some("sealed"));
        let obj = payload.as_object().unwrap();
        for leaked in ["group_id", "sender_wallet", "message_kind", "principal_owner", "message", "is_agent_message"] {
            assert!(!obj.contains_key(leaked), "{leaked} must not reach APNs");
        }
        assert_eq!(payload["encrypted_notification"], "sealed");
        assert_eq!(payload["aps"]["mutable-content"], 1);
    }

    #[test]
    fn new_message_alert_payload_shape() {
        let payload = new_message_alert_payload_json(
            "group-123",
            uuid::Uuid::nil(),
            "0xsender",
            "text",
            Some("abc123"),
            None,
            &MessageAttribution::human_message(),
        );
        assert_eq!(payload["aps"]["mutable-content"], 1);
        assert!(payload.get("message_unread_count").is_none());
        assert_eq!(payload["encrypted_notification"], "abc123");
        assert!(payload.get("message").is_none());
    }

    #[test]
    fn new_message_alert_payload_includes_small_wire() {
        let wire = json!({ "message_id": "m1", "encrypted_text": "ab", "nonce": "cd" });
        let payload = new_message_alert_payload_json(
            "group-123",
            uuid::Uuid::nil(),
            "0xsender",
            "text",
            None,
            Some(&wire),
            &MessageAttribution::human_message(),
        );
        assert_eq!(payload["message"]["message_id"], "m1");
    }

    #[test]
    fn new_message_alert_payload_drops_oversized_wire() {
        let wire = json!({ "encrypted_text": "a".repeat(ALERT_PAYLOAD_BUDGET_BYTES) });
        let payload = new_message_alert_payload_json(
            "group-123",
            uuid::Uuid::nil(),
            "0xsender",
            "text",
            Some("abc123"),
            Some(&wire),
            &MessageAttribution::human_message(),
        );
        assert!(payload.get("message").is_none());
        assert_eq!(payload["encrypted_notification"], "abc123");
    }

    #[test]
    fn ios_platform_filter() {
        assert!(ApnsClient::is_ios_token(&sample_token("sandbox")));
        let mut android = sample_token("sandbox");
        android.platform = "android".to_string();
        assert!(!ApnsClient::is_ios_token(&android));
    }

    #[test]
    fn environment_mismatch_detected() {
        let client = ApnsClient::from_test_http(
            "http://localhost".to_string(),
            "com.example.app".to_string(),
            ApnsEnvironment::Sandbox,
        );
        let token = sample_token("production");
        assert!(!client.token_environment_matches(&token));
    }

    #[test]
    fn map_apns_status_codes() {
        assert!(map_apns_status(200).is_ok());
        assert_eq!(map_apns_status(410), Err(ApnsSendError::Unregistered));
        assert_eq!(map_apns_status(400), Err(ApnsSendError::InvalidToken));
        assert!(matches!(
            map_apns_status(503),
            Err(ApnsSendError::Transient(_))
        ));
    }
}
