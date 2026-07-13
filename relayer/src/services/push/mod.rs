//! Optional APNs / FCM / web push notifications (metadata-only payloads).

mod apns;
mod fcm;
mod web_push;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Utc};
use futures_util::stream::{self, StreamExt};
use tracing::{debug, info, warn};

use crate::auth::MembershipStore;
use crate::config::Config;
use crate::models::PushTokenRecord;
use crate::storage::StorageAdapter;

pub use apns::{ApnsClient, ApnsEnvironment, ApnsSendError};
pub use fcm::FcmClient;
pub use web_push::WebPushClient;

#[derive(Clone)]
pub struct PushService {
    enabled: bool,
    presence_ttl_secs: u64,
    notify_concurrency: usize,
    large_group_warn_members: usize,
    apns: Option<ApnsClient>,
    fcm: Option<FcmClient>,
    web_push: Option<WebPushClient>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushSendOutcome {
    Sent,
    Pruned,
    Failed,
}

struct PushSendJob {
    member: String,
    token: PushTokenRecord,
}

impl PushService {
    pub fn from_config(config: &Config) -> Self {
        let apns = if config.push_enabled {
            ApnsClient::from_config(config)
        } else {
            None
        };
        let fcm = if config.push_enabled {
            FcmClient::from_env()
        } else {
            None
        };
        let web_push = if config.push_enabled {
            WebPushClient::from_env()
        } else {
            None
        };
        if config.push_enabled && apns.is_none() && fcm.is_none() && web_push.is_none() {
            warn!("PUSH_ENABLED but no push credentials — push disabled");
        }
        Self {
            enabled: config.push_enabled
                && (apns.is_some() || fcm.is_some() || web_push.is_some()),
            presence_ttl_secs: config.presence_ttl_secs,
            notify_concurrency: config.push_notify_concurrency,
            large_group_warn_members: config.push_large_group_warn_members,
            apns,
            fcm,
            web_push,
        }
    }

    /// Test-only constructor with a pre-built APNs client.
    #[doc(hidden)]
    pub fn new_for_test(apns: ApnsClient, presence_ttl_secs: u64) -> Self {
        Self {
            enabled: true,
            presence_ttl_secs,
            notify_concurrency: 50,
            large_group_warn_members: 500,
            apns: Some(apns),
            fcm: None,
            web_push: None,
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
        attribution: &crate::models::MessageAttribution,
    ) {
        if !self.is_enabled() {
            return;
        }
        let Some(apns) = self.apns.as_ref() else {
            return;
        };

        let started = Instant::now();
        let members = membership_store.list_member_addresses(group_id);
        let member_count = members.len();

        if member_count >= self.large_group_warn_members {
            warn!(
                "large group push fan-out: group={} members={} threshold={}",
                group_id, member_count, self.large_group_warn_members
            );
        }

        let recipients: Vec<String> = members
            .into_iter()
            .filter(|member| member != sender)
            .collect();

        let presence = match storage
            .get_presence_last_seen_for_wallets(&recipients)
            .await
        {
            Ok(presence) => presence,
            Err(err) => {
                warn!("batch presence lookup failed for group {group_id}: {err}");
                HashMap::new()
            }
        };

        let inactive: Vec<String> = recipients
            .iter()
            .filter(|wallet| {
                !presence
                    .get(*wallet)
                    .map(|last_seen| self.is_recently_active_at(*last_seen))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        let members_skipped_active = recipients.len().saturating_sub(inactive.len());

        let tokens_by_wallet = match storage.list_push_tokens_for_wallets(&inactive).await {
            Ok(tokens) => tokens,
            Err(err) => {
                warn!("batch push token lookup failed for group {group_id}: {err}");
                return;
            }
        };

        let mut jobs = Vec::new();
        for member in &inactive {
            let Some(tokens) = tokens_by_wallet.get(member) else {
                continue;
            };
            for token in tokens {
                if !ApnsClient::is_ios_token(token) {
                    debug!("skip push token for {} — platform {}", member, token.platform);
                    continue;
                }
                if !apns.token_environment_matches(token) {
                    debug!(
                        "skip push token for {} — environment {} does not match server {:?}",
                        member,
                        token.environment,
                        apns.environment()
                    );
                    continue;
                }
                jobs.push(PushSendJob {
                    member: member.clone(),
                    token: token.clone(),
                });
            }
        }

        let token_count = jobs.len();
        let concurrency = self.notify_concurrency.max(1);
        let apns = apns.clone();
        let storage = Arc::clone(storage);
        let group_id_owned = group_id.to_string();
        let attribution = attribution.clone();

        let outcomes: Vec<PushSendOutcome> = stream::iter(jobs)
            .map(|job| {
                let apns = apns.clone();
                let storage = Arc::clone(&storage);
                let group_id = group_id_owned.clone();
                let attribution = attribution.clone();
                async move {
                    match apns
                        .send_new_message(&job.token, &group_id, &attribution)
                        .await
                    {
                        Ok(()) => PushSendOutcome::Sent,
                        Err(ApnsSendError::Unregistered) => {
                            info!(
                                "pruning unregistered APNs token for wallet {} token {}",
                                job.member, job.token.token
                            );
                            if let Err(err) = storage
                                .delete_push_token(&job.member, &job.token.token)
                                .await
                            {
                                warn!(
                                    "failed to delete unregistered push token for {}: {}",
                                    job.member, err
                                );
                            }
                            PushSendOutcome::Pruned
                        }
                        Err(ApnsSendError::InvalidToken) => {
                            warn!("invalid APNs token for {}: {}", job.member, job.token.token);
                            PushSendOutcome::Failed
                        }
                        Err(ApnsSendError::Transient(err)) => {
                            warn!("transient APNs send failure for {}: {}", job.member, err);
                            PushSendOutcome::Failed
                        }
                        Err(ApnsSendError::EnvironmentMismatch) => {
                            debug!("skip push token for {} — environment mismatch", job.member);
                            PushSendOutcome::Failed
                        }
                        Err(ApnsSendError::Other(err)) => {
                            warn!("APNs send failed for {}: {}", job.member, err);
                            PushSendOutcome::Failed
                        }
                    }
                }
            })
            .buffer_unordered(concurrency)
            .collect()
            .await;

        let mut tokens_sent = 0usize;
        let mut tokens_pruned = 0usize;
        let mut tokens_failed = 0usize;
        for outcome in outcomes {
            match outcome {
                PushSendOutcome::Sent => tokens_sent += 1,
                PushSendOutcome::Pruned => tokens_pruned += 1,
                PushSendOutcome::Failed => tokens_failed += 1,
            }
        }

        info!(
            "push notify complete group={} members={} inactive={} tokens={} duration_ms={} sent={} pruned={} failed={} skipped_active={}",
            group_id,
            member_count,
            inactive.len(),
            token_count,
            started.elapsed().as_millis(),
            tokens_sent,
            tokens_pruned,
            tokens_failed,
            members_skipped_active
        );
    }

    /// Notify an offline wallet about a new workflow inbox item (metadata-only).
    pub async fn notify_workflow_item(
        &self,
        storage: &Arc<dyn StorageAdapter>,
        recipient: &str,
        item_type: &str,
        item_id: &str,
    ) {
        if !self.is_enabled() {
            return;
        }
        if self.is_recently_active(storage, recipient).await {
            debug!("skip workflow push for {recipient} — recently active");
            return;
        }
        let tokens = match storage.list_push_tokens_for_wallet(recipient).await {
            Ok(tokens) => tokens,
            Err(err) => {
                warn!("list push tokens for {recipient} failed: {err}");
                return;
            }
        };
        for token in tokens {
            if let Some(apns) = self.apns.as_ref() {
                if ApnsClient::is_ios_token(&token) && apns.token_environment_matches(&token) {
                    match apns.send_workflow_item(&token, item_type, item_id).await {
                        Ok(()) => {}
                        Err(ApnsSendError::Unregistered) => {
                            let _ = storage.delete_push_token(recipient, &token.token).await;
                        }
                        Err(err) => warn!("workflow APNs send failed for {recipient}: {err}"),
                    }
                }
            }
            if let Some(fcm) = self.fcm.as_ref() {
                if FcmClient::is_fcm_token(&token) {
                    if let Err(err) = fcm.send_workflow_item(&token, item_type, item_id).await {
                        warn!("workflow FCM send failed for {recipient}: {err}");
                    }
                }
            }
            if let Some(web) = self.web_push.as_ref() {
                if WebPushClient::is_web_token(&token) {
                    if let Err(err) = web.send_workflow_item(&token, item_type, item_id).await {
                        warn!("workflow web push failed for {recipient}: {err}");
                    }
                }
            }
        }
    }

    fn is_recently_active_at(&self, last_seen: DateTime<Utc>) -> bool {
        is_wallet_recently_active(last_seen, self.presence_ttl_secs)
    }

    async fn is_recently_active(
        &self,
        storage: &Arc<dyn StorageAdapter>,
        wallet: &str,
    ) -> bool {
        let Ok(Some(last_seen)) = storage.get_presence_last_seen(wallet).await else {
            return false;
        };
        self.is_recently_active_at(last_seen)
    }
}

fn is_wallet_recently_active(last_seen: DateTime<Utc>, presence_ttl_secs: u64) -> bool {
    let elapsed = Utc::now().signed_duration_since(last_seen);
    elapsed.num_seconds() >= 0 && (elapsed.num_seconds() as u64) < presence_ttl_secs
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

    #[test]
    fn push_reads_concurrency_from_config() {
        let mut config = Config::default();
        config.push_notify_concurrency = 25;
        config.push_large_group_warn_members = 1000;
        let service = PushService::from_config(&config);
        assert_eq!(service.notify_concurrency, 25);
        assert_eq!(service.large_group_warn_members, 1000);
    }

    #[test]
    fn recently_active_respects_ttl() {
        let recent = Utc::now() - chrono::Duration::seconds(10);
        assert!(is_wallet_recently_active(recent, 45));
        let stale = Utc::now() - chrono::Duration::seconds(60);
        assert!(!is_wallet_recently_active(stale, 45));
    }
}
