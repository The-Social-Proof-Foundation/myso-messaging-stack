//! Optional APNs push notifications (metadata-only payloads).

mod apns;

use std::sync::Arc;

use chrono::Utc;
use tracing::{debug, info, warn};

use crate::auth::MembershipStore;
use crate::config::Config;
use crate::storage::StorageAdapter;

pub use apns::{ApnsClient, ApnsEnvironment, ApnsSendError};

#[derive(Clone)]
pub struct PushService {
    enabled: bool,
    presence_ttl_secs: u64,
    apns: Option<ApnsClient>,
}

impl PushService {
    pub fn from_config(config: &Config) -> Self {
        let apns = if config.push_enabled {
            ApnsClient::from_config(config)
        } else {
            None
        };
        if config.push_enabled && apns.is_none() {
            warn!("PUSH_ENABLED but APNs credentials incomplete — push disabled");
        }
        Self {
            enabled: config.push_enabled && apns.is_some(),
            presence_ttl_secs: config.presence_ttl_secs,
            apns,
        }
    }

    /// Test-only constructor with a pre-built APNs client.
    #[doc(hidden)]
    pub fn new_for_test(apns: ApnsClient, presence_ttl_secs: u64) -> Self {
        Self {
            enabled: true,
            presence_ttl_secs,
            apns: Some(apns),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Notify offline group members about a new message (metadata-only).
    pub async fn notify_new_message(
        &self,
        storage: &Arc<dyn StorageAdapter>,
        membership_store: &Arc<dyn MembershipStore>,
        group_id: &str,
        sender: &str,
    ) {
        if !self.is_enabled() {
            return;
        }
        let Some(apns) = self.apns.as_ref() else {
            return;
        };

        let mut members_skipped_active = 0usize;
        let mut tokens_sent = 0usize;
        let mut tokens_pruned = 0usize;
        let mut tokens_failed = 0usize;

        let members = membership_store.list_member_addresses(group_id);
        for member in members {
            if member == sender {
                continue;
            }
            if self.is_recently_active(storage, &member).await {
                members_skipped_active += 1;
                debug!("skip push for {} — recently active", member);
                continue;
            }
            let tokens = match storage.list_push_tokens_for_wallet(&member).await {
                Ok(tokens) => tokens,
                Err(err) => {
                    warn!("list push tokens for {} failed: {}", member, err);
                    continue;
                }
            };
            for token in tokens {
                if !ApnsClient::is_ios_token(&token) {
                    debug!("skip push token for {} — platform {}", member, token.platform);
                    continue;
                }
                if !apns.token_environment_matches(&token) {
                    debug!(
                        "skip push token for {} — environment {} does not match server {:?}",
                        member,
                        token.environment,
                        apns.environment()
                    );
                    continue;
                }

                match apns.send_new_message(&token, group_id).await {
                    Ok(()) => {
                        tokens_sent += 1;
                    }
                    Err(ApnsSendError::Unregistered) => {
                        tokens_pruned += 1;
                        info!(
                            "pruning unregistered APNs token for wallet {} token {}",
                            member, token.token
                        );
                        if let Err(err) = storage
                            .delete_push_token(&member, &token.token)
                            .await
                        {
                            warn!(
                                "failed to delete unregistered push token for {}: {}",
                                member, err
                            );
                        }
                    }
                    Err(ApnsSendError::InvalidToken) => {
                        tokens_failed += 1;
                        warn!("invalid APNs token for {}: {}", member, token.token);
                    }
                    Err(ApnsSendError::Transient(err)) => {
                        tokens_failed += 1;
                        warn!("transient APNs send failure for {}: {}", member, err);
                    }
                    Err(ApnsSendError::EnvironmentMismatch) => {
                        debug!("skip push token for {} — environment mismatch", member);
                    }
                    Err(ApnsSendError::Other(err)) => {
                        tokens_failed += 1;
                        warn!("APNs send failed for {}: {}", member, err);
                    }
                }
            }
        }

        info!(
            "push notify complete group={} sent={} pruned={} failed={} skipped_active={}",
            group_id, tokens_sent, tokens_pruned, tokens_failed, members_skipped_active
        );
    }

    async fn is_recently_active(
        &self,
        storage: &Arc<dyn StorageAdapter>,
        wallet: &str,
    ) -> bool {
        let Ok(Some(last_seen)) = storage.get_presence_last_seen(wallet).await else {
            return false;
        };
        let elapsed = Utc::now().signed_duration_since(last_seen);
        elapsed.num_seconds() >= 0
            && (elapsed.num_seconds() as u64) < self.presence_ttl_secs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_disabled_by_default() {
        let service = PushService::from_config(&Config::default());
        assert!(!service.is_enabled());
    }

    #[test]
    fn push_enabled_without_credentials_stays_disabled() {
        let mut config = Config::default();
        config.push_enabled = true;
        let service = PushService::from_config(&config);
        assert!(!service.is_enabled());
    }
}
