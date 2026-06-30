//! Application state shared across all handlers.

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::auth::MembershipStore;
use crate::config::Config;
use crate::services::block_check::BlockCheckService;
use crate::services::push::PushService;
use crate::services::realtime::RealtimeHub;
use crate::services::AttributionVerifyService;
use crate::storage::{AgentGroupStore, StorageAdapter};

/// Shared application state passed to all route handlers.
#[derive(Clone)]
pub struct AppState {
    /// Storage backend (in-memory or PostgreSQL)
    pub storage: Arc<dyn StorageAdapter>,
    pub sync_notifier: mpsc::UnboundedSender<()>,
    pub membership_store: Arc<dyn MembershipStore>,
    pub agent_group_store: Arc<dyn AgentGroupStore>,
    pub attribution_verify: AttributionVerifyService,
    pub block_check: BlockCheckService,
    pub push_service: PushService,
    pub realtime_hub: Arc<RealtimeHub>,
    pub realtime_enabled: bool,
    pub inline_realtime_publish: bool,
    pub ws_ping_interval_secs: u64,
    pub request_ttl_seconds: i64,
}

impl AppState {
    pub fn new(
        storage: Arc<dyn StorageAdapter>,
        sync_notifier: mpsc::UnboundedSender<()>,
        membership_store: Arc<dyn MembershipStore>,
        agent_group_store: Arc<dyn AgentGroupStore>,
        attribution_verify: AttributionVerifyService,
        block_check: BlockCheckService,
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
            attribution_verify,
            block_check,
            push_service,
            realtime_hub,
            realtime_enabled,
            inline_realtime_publish,
            ws_ping_interval_secs,
            request_ttl_seconds,
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
            AttributionVerifyService::from_config(&Config::default()),
            block_check,
            push_service,
            Arc::new(RealtimeHub::new()),
            true,
            true,
            30,
            900,
        )
    }
}
