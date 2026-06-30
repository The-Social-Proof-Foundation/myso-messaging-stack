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

pub fn new_message_payload_json(group_id: &str, attribution: &MessageAttribution) -> Value {
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

impl ApnsClient {
    pub fn from_config(config: &Config) -> Option<Self> {
        let key_id = config.apns_key_id.as_ref()?;
        let team_id = config.apns_team_id.as_ref()?;
        let bundle_id = config.apns_bundle_id.clone()?;
        let path = config.apns_auth_key_path.as_ref()?;
        let environment = ApnsEnvironment::from_config_str(&config.apns_environment).ok()?;

        let mut key_file = match File::open(path) {
            Ok(file) => file,
            Err(err) => {
                warn!("Failed to open APNS_AUTH_KEY_PATH '{}': {}", path, err);
                return None;
            }
        };
        let mut key_bytes = Vec::new();
        if let Err(err) = key_file.read_to_end(&mut key_bytes) {
            warn!("Failed to read APNS auth key from '{}': {}", path, err);
            return None;
        }

        let client_config = ClientConfig::new(environment.to_a2_endpoint());
        let client = match Client::token(
            key_bytes.as_slice(),
            key_id.clone(),
            team_id.clone(),
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
            ApnsBackend::A2(client) => self.send_via_a2(client, token, group_id, attribution).await,
            ApnsBackend::HttpTest { client, base_url } => {
                self.send_via_http_test(client, base_url, token, group_id, attribution)
                    .await
            }
        }
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
        let payload = new_message_payload_json("group-123", &MessageAttribution::human_message());
        assert_eq!(payload["aps"]["content-available"], 1);
        assert_eq!(payload["group_id"], "group-123");
        assert_eq!(payload["is_agent_message"], false);
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
