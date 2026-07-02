//! Message gate service — social-graph follow checks and paid-messaging policies
//! via myso-social-server HTTP, with a TTL cache that is eagerly refreshed from
//! on-chain checkpoint events (`FollowEvent` / `UnfollowEvent` /
//! `PaidMessagingPolicyUpdated`).
//!
//! Today this backs the paid-DM gate; future gates (moderation, rate limits, …)
//! should slot into this service rather than adding new one-off services.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use reqwest::Client;
use tracing::{debug, warn};

use crate::config::Config;

/// Recipient paid-messaging policy mirrored from `paid_messaging_policy::PaidMessagingRegistry`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaidPolicy {
    pub enabled: bool,
    pub min_cost: Option<u64>,
}

impl PaidPolicy {
    /// Mirrors on-chain `requires_payment_from`: payment applies only when the
    /// policy is enabled with a configured minimum.
    pub fn required_min_cost(&self) -> Option<u64> {
        if self.enabled {
            self.min_cost
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
struct CacheEntry<T> {
    value: T,
    inserted_at: Instant,
}

type FollowCache = HashMap<(String, String), CacheEntry<bool>>;
type PolicyCache = HashMap<String, CacheEntry<Option<PaidPolicy>>>;

/// Follow + paid-policy lookups against myso-social-server with a shared TTL cache.
///
/// Cloning is cheap and shares the underlying caches, so the instance handed to
/// the checkpoint sync service refreshes the same entries the HTTP handlers read.
#[derive(Clone)]
pub struct MessageGateService {
    enabled: bool,
    base_url: Option<String>,
    client: Client,
    cache_ttl: Duration,
    cache_max_entries: usize,
    /// Directional follow edges keyed by `(follower, followee)`.
    follow_cache: Arc<RwLock<FollowCache>>,
    /// Paid policy keyed by wallet; `None` caches a "no policy row" (404) result.
    policy_cache: Arc<RwLock<PolicyCache>>,
}

impl MessageGateService {
    pub fn from_config(config: &Config) -> Self {
        Self {
            enabled: config.paid_gate_enabled,
            base_url: config.social_server_url.clone(),
            client: Client::new(),
            cache_ttl: Duration::from_secs(config.paid_gate_cache_ttl_secs),
            cache_max_entries: config.paid_gate_cache_max_entries,
            follow_cache: Arc::new(RwLock::new(HashMap::new())),
            policy_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled && self.base_url.is_some()
    }

    /// Returns true when `follower` follows `followee` (directional).
    pub async fn is_following(
        &self,
        follower: &str,
        followee: &str,
    ) -> Result<bool, MessageGateError> {
        if !self.is_enabled() {
            return Ok(false);
        }

        let key = (follower.to_string(), followee.to_string());
        if let Some(following) = read_cache(&self.follow_cache, &key, self.cache_ttl) {
            debug!(
                "follow cache hit for ({}, {}) -> {}",
                key.0, key.1, following
            );
            return Ok(following);
        }

        let base = self
            .base_url
            .as_ref()
            .ok_or(MessageGateError::NotConfigured)?;
        let url = format!(
            "{}/social-graph/check/{}/{}",
            base.trim_end_matches('/'),
            follower,
            followee,
        );

        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| MessageGateError::Http(e.to_string()))?;

        if !response.status().is_success() {
            return Err(MessageGateError::Http(format!(
                "social server returned {}",
                response.status()
            )));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| MessageGateError::Http(e.to_string()))?;

        let following = body
            .get("is_following")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| {
                MessageGateError::InvalidResponse("missing is_following field".into())
            })?;

        write_cache(
            &self.follow_cache,
            key,
            following,
            self.cache_ttl,
            self.cache_max_entries,
        );
        Ok(following)
    }

    /// Returns the recipient's paid-messaging policy, or `None` when the wallet
    /// never opted in (social server 404).
    pub async fn paid_policy(&self, wallet: &str) -> Result<Option<PaidPolicy>, MessageGateError> {
        if !self.is_enabled() {
            return Ok(None);
        }

        let key = wallet.to_string();
        if let Some(policy) = read_cache(&self.policy_cache, &key, self.cache_ttl) {
            debug!("policy cache hit for {} -> {:?}", key, policy);
            return Ok(policy);
        }

        let base = self
            .base_url
            .as_ref()
            .ok_or(MessageGateError::NotConfigured)?;
        let url = format!(
            "{}/wallets/{}/messaging-policy",
            base.trim_end_matches('/'),
            wallet,
        );

        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| MessageGateError::Http(e.to_string()))?;

        if response.status() == reqwest::StatusCode::NOT_FOUND {
            write_cache(
                &self.policy_cache,
                key,
                None,
                self.cache_ttl,
                self.cache_max_entries,
            );
            return Ok(None);
        }

        if !response.status().is_success() {
            return Err(MessageGateError::Http(format!(
                "social server returned {}",
                response.status()
            )));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| MessageGateError::Http(e.to_string()))?;

        let enabled = body
            .get("enabled")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| MessageGateError::InvalidResponse("missing enabled field".into()))?;
        let min_cost = match body.get("min_cost") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => Some(v.as_u64().ok_or_else(|| {
                MessageGateError::InvalidResponse("min_cost is not a non-negative integer".into())
            })?),
        };

        let policy = Some(PaidPolicy { enabled, min_cost });
        write_cache(
            &self.policy_cache,
            key,
            policy,
            self.cache_ttl,
            self.cache_max_entries,
        );
        Ok(policy)
    }

    /// Refreshes the follow cache from an on-chain `FollowEvent` / `UnfollowEvent`.
    ///
    /// Applying chain truth directly (rather than evicting) avoids re-caching a
    /// stale social-server row while its indexer catches up to the same checkpoint.
    pub fn apply_follow_update(&self, follower: &str, followee: &str, following: bool) {
        write_cache(
            &self.follow_cache,
            (follower.to_string(), followee.to_string()),
            following,
            self.cache_ttl,
            self.cache_max_entries,
        );
    }

    /// Refreshes the policy cache from an on-chain `PaidMessagingPolicyUpdated` event.
    pub fn apply_policy_update(&self, wallet: &str, enabled: bool, min_cost: Option<u64>) {
        write_cache(
            &self.policy_cache,
            wallet.to_string(),
            Some(PaidPolicy { enabled, min_cost }),
            self.cache_ttl,
            self.cache_max_entries,
        );
    }
}

fn read_cache<K, T>(
    cache: &Arc<RwLock<HashMap<K, CacheEntry<T>>>>,
    key: &K,
    ttl: Duration,
) -> Option<T>
where
    K: std::hash::Hash + Eq,
    T: Clone,
{
    let cache = cache.read().ok()?;
    let entry = cache.get(key)?;
    if entry.inserted_at.elapsed() > ttl {
        return None;
    }
    Some(entry.value.clone())
}

fn write_cache<K, T>(
    cache: &Arc<RwLock<HashMap<K, CacheEntry<T>>>>,
    key: K,
    value: T,
    ttl: Duration,
    max_entries: usize,
) where
    K: std::hash::Hash + Eq,
{
    let Ok(mut cache) = cache.write() else {
        warn!("message gate cache lock poisoned");
        return;
    };
    if cache.len() >= max_entries {
        cache.retain(|_, entry| entry.inserted_at.elapsed() <= ttl);
        if cache.len() >= max_entries {
            cache.clear();
        }
    }
    cache.insert(
        key,
        CacheEntry {
            value,
            inserted_at: Instant::now(),
        },
    );
}

#[derive(Debug, thiserror::Error)]
pub enum MessageGateError {
    #[error("message gate not configured")]
    NotConfigured,
    #[error("message gate HTTP error: {0}")]
    Http(String),
    #[error("invalid message gate response: {0}")]
    InvalidResponse(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disabled_service() -> MessageGateService {
        MessageGateService::from_config(&Config::default())
    }

    #[tokio::test]
    async fn disabled_service_allows_everything() {
        let service = disabled_service();
        assert!(!service.is_enabled());
        assert!(!service.is_following("0xa", "0xb").await.unwrap());
        assert!(service.paid_policy("0xb").await.unwrap().is_none());
    }

    #[test]
    fn required_min_cost_mirrors_on_chain_semantics() {
        assert_eq!(
            PaidPolicy {
                enabled: true,
                min_cost: Some(100)
            }
            .required_min_cost(),
            Some(100)
        );
        assert_eq!(
            PaidPolicy {
                enabled: false,
                min_cost: Some(100)
            }
            .required_min_cost(),
            None
        );
        assert_eq!(
            PaidPolicy {
                enabled: true,
                min_cost: None
            }
            .required_min_cost(),
            None
        );
    }

    #[test]
    fn apply_updates_populate_caches() {
        let service = disabled_service();
        service.apply_follow_update("0xa", "0xb", true);
        service.apply_policy_update("0xb", true, Some(500));

        let follow = read_cache(
            &service.follow_cache,
            &("0xa".to_string(), "0xb".to_string()),
            service.cache_ttl,
        );
        assert_eq!(follow, Some(true));

        let policy = read_cache(
            &service.policy_cache,
            &"0xb".to_string(),
            service.cache_ttl,
        )
        .flatten();
        assert_eq!(
            policy,
            Some(PaidPolicy {
                enabled: true,
                min_cost: Some(500)
            })
        );
    }
}
