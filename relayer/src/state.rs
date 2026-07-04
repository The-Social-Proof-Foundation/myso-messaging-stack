//! Application state shared across all handlers.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::auth::MembershipStore;
use crate::config::Config;
use crate::services::block_check::BlockCheckService;
use crate::services::message_gate::MessageGateService;
use crate::services::messaging_config::{fallback_messaging_config_cache, MessagingConfigCache};
use crate::services::presence_sync::PresenceRegistry;
use crate::services::push::PushService;
use crate::services::realtime::RealtimeHub;
use crate::services::AttributionVerifyService;
use crate::storage::{AgentGroupStore, StorageAdapter, WorkflowStore};

/// Per `(wallet, group)` throttle for `typing.start` broadcasts so keystroke
/// storms stay cheap. `typing.stop` is never throttled.
#[derive(Default)]
pub struct TypingRateLimiter {
    last_start: RwLock<HashMap<(String, String), Instant>>,
}

impl TypingRateLimiter {
    const MIN_START_INTERVAL: Duration = Duration::from_secs(2);
    /// Opportunistic cleanup threshold to bound memory under long uptimes.
    const CLEANUP_LEN: usize = 4096;

    pub fn allow_start(&self, wallet: &str, group_id: &str) -> bool {
        let mut map = self
            .last_start
            .write()
            .expect("typing rate limiter poisoned");

        if map.len() > Self::CLEANUP_LEN {
            let now = Instant::now();
            map.retain(|_, last| now.duration_since(*last) < Duration::from_secs(60));
        }

        let key = (wallet.to_string(), group_id.to_string());
        let now = Instant::now();
        match map.get(&key) {
            Some(last) if now.duration_since(*last) < Self::MIN_START_INTERVAL => false,
            _ => {
                map.insert(key, now);
                true
            }
        }
    }
}

/// Shared application state passed to all route handlers.
#[derive(Clone)]
pub struct AppState {
    /// Storage backend (in-memory or PostgreSQL)
    pub storage: Arc<dyn StorageAdapter>,
    pub sync_notifier: mpsc::UnboundedSender<()>,
    pub membership_store: Arc<dyn MembershipStore>,
    pub agent_group_store: Arc<dyn AgentGroupStore>,
    pub workflow_store: Arc<dyn WorkflowStore>,
    pub workflow_enabled: bool,
    pub attribution_verify: AttributionVerifyService,
    pub block_check: BlockCheckService,
    pub message_gate: MessageGateService,
    /// Hot-reloadable on-chain MessagingConfig (fees, reply rules, escrow expiry).
    pub messaging_config: MessagingConfigCache,
    pub push_service: PushService,
    pub realtime_hub: Arc<RealtimeHub>,
    pub realtime_enabled: bool,
    pub inline_realtime_publish: bool,
    pub ws_ping_interval_secs: u64,
    pub request_ttl_seconds: i64,
    /// Wallet connection refcounts for wallet-scoped presence transitions.
    pub presence_registry: Arc<PresenceRegistry>,
    /// Throttles `typing.start` broadcasts per (wallet, group).
    pub typing_rate: Arc<TypingRateLimiter>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        storage: Arc<dyn StorageAdapter>,
        sync_notifier: mpsc::UnboundedSender<()>,
        membership_store: Arc<dyn MembershipStore>,
        agent_group_store: Arc<dyn AgentGroupStore>,
        workflow_store: Arc<dyn WorkflowStore>,
        workflow_enabled: bool,
        attribution_verify: AttributionVerifyService,
        block_check: BlockCheckService,
        message_gate: MessageGateService,
        messaging_config: MessagingConfigCache,
        push_service: PushService,
        realtime_hub: Arc<RealtimeHub>,
        realtime_enabled: bool,
        inline_realtime_publish: bool,
        ws_ping_interval_secs: u64,
        request_ttl_seconds: i64,
    ) -> Self {
        Self {
            storage,
            sync_notifier,
            membership_store,
            agent_group_store,
            workflow_store,
            workflow_enabled,
            attribution_verify,
            block_check,
            message_gate,
            messaging_config,
            push_service,
            realtime_hub,
            realtime_enabled,
            inline_realtime_publish,
            ws_ping_interval_secs,
            request_ttl_seconds,
            presence_registry: Arc::new(PresenceRegistry::new()),
            typing_rate: Arc::new(TypingRateLimiter::default()),
        }
    }

    /// Convenience constructor for integration tests.
    pub fn new_for_tests(
        storage: Arc<dyn StorageAdapter>,
        sync_notifier: mpsc::UnboundedSender<()>,
        membership_store: Arc<dyn MembershipStore>,
        block_check: BlockCheckService,
        push_service: PushService,
    ) -> Self {
        Self::new(
            storage,
            sync_notifier,
            membership_store,
            Arc::new(crate::storage::NoOpAgentGroupStore),
            Arc::new(crate::storage::NoOpWorkflowStore),
            false,
            AttributionVerifyService::from_config(&Config::default()),
            block_check,
            MessageGateService::from_config(&Config::default()),
            fallback_messaging_config_cache(),
            push_service,
            Arc::new(RealtimeHub::new()),
            true,
            true,
            30,
            900,
        )
    }

    /// Test constructor with an explicit message gate (paid-DM gate tests).
    pub fn new_for_tests_with_gate(
        storage: Arc<dyn StorageAdapter>,
        sync_notifier: mpsc::UnboundedSender<()>,
        membership_store: Arc<dyn MembershipStore>,
        block_check: BlockCheckService,
        message_gate: MessageGateService,
        push_service: PushService,
    ) -> Self {
        Self::new(
            storage,
            sync_notifier,
            membership_store,
            Arc::new(crate::storage::NoOpAgentGroupStore),
            Arc::new(crate::storage::NoOpWorkflowStore),
            false,
            AttributionVerifyService::from_config(&Config::default()),
            block_check,
            message_gate,
            fallback_messaging_config_cache(),
            push_service,
            Arc::new(RealtimeHub::new()),
            true,
            true,
            30,
            900,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_rate_limiter_throttles_start_per_wallet_group() {
        let limiter = TypingRateLimiter::default();

        // First start passes, immediate repeat is throttled.
        assert!(limiter.allow_start("0xalice", "group-1"));
        assert!(!limiter.allow_start("0xalice", "group-1"));

        // Other wallets and other groups are independent buckets.
        assert!(limiter.allow_start("0xbob", "group-1"));
        assert!(limiter.allow_start("0xalice", "group-2"));
    }
}
