//! A service that subscribes to MySo checkpoints and syncs membership cache.
//!
//! This service:
//! - Connects to a MySo fullnode via gRPC
//! - Subscribes to the checkpoint stream using SubscriptionService
//! - Filters events from the Groups SDK package
//! - Parses events and updates the MembershipCache
//! - Runs in a loop automatically reconnecting on errors

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{TimeZone, Utc};
use myso_rpc::field::{FieldMask, FieldMaskUtil};
use myso_rpc::proto::myso::rpc::v2::subscription_service_client::SubscriptionServiceClient;
use myso_rpc::proto::myso::rpc::v2::SubscribeCheckpointsRequest;
use tokio_stream::StreamExt;
use tracing::{debug, error, info, warn};

use crate::auth::MembershipStore;
use crate::config::Config;
use crate::models::PaidEscrowRecord;
use crate::storage::{AgentGroupStore, StorageAdapter};

use super::agent_group_detector::{
    agent_group_from_created_event, detect_agent_groups_in_transaction,
};
use super::event_parser::{
    parse_agent_detection_event, parse_agent_group_created_event, parse_follow_changed_event,
    parse_myso_event, parse_paid_message_sent_event, parse_paid_policy_updated_event,
    AgentDetectionEvent, GroupsEvent,
};
use super::message_gate::MessageGateService;

pub struct MembershipSyncService {
    myso_rpc_url: String,
    groups_package_id: String,
    messaging_package_id: String,
    social_package_id: String,
    membership_store: Arc<dyn MembershipStore>,
    agent_group_store: Arc<dyn AgentGroupStore>,
    /// Paid DM escrow index (PaidMessageSent events) lives in message storage.
    storage: Arc<dyn StorageAdapter>,
    /// Shared with HTTP handlers — checkpoint events refresh its follow/policy caches.
    message_gate: MessageGateService,
    last_cursor: Option<u64>,
}

impl MembershipSyncService {
    pub fn new(
        config: &Config,
        membership_store: Arc<dyn MembershipStore>,
        agent_group_store: Arc<dyn AgentGroupStore>,
        storage: Arc<dyn StorageAdapter>,
        message_gate: MessageGateService,
    ) -> Self {
        let last_cursor = membership_store.get_last_checkpoint_cursor();
        info!(
            "MembershipSyncService init: last_cursor={:?}, groups_package_id={}, messaging_package_id={}, social_package_id={}, myso_rpc_url={}",
            last_cursor,
            config.groups_package_id,
            config.messaging_package_id,
            config.social_package_id,
            config.myso_rpc_url,
        );
        Self {
            myso_rpc_url: config.myso_rpc_url.clone(),
            groups_package_id: config.groups_package_id.clone(),
            messaging_package_id: config.messaging_package_id.clone(),
            social_package_id: config.social_package_id.clone(),
            membership_store,
            agent_group_store,
            storage,
            message_gate,
            last_cursor,
        }
    }

    /// Runs the sync service forever, reconnecting on errors
    pub async fn run(&mut self) {
        info!(
            "Starting MembershipSyncService, connecting to {}",
            self.myso_rpc_url
        );
        info!("Filtering events for package: {}", self.groups_package_id);

        loop {
            match self.run_subscription().await {
                Ok(()) => {
                    warn!("Checkpoint subscription ended unexpectedly, reconnecting...");
                }
                Err(e) => {
                    error!("Subscription error: {}, reconnecting in 5 seconds...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                }
            }
        }
    }

    /// Connects to the MySo fullnode and processes the checkpoint stream.
    pub async fn run_subscription(
        &mut self,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut client = SubscriptionServiceClient::connect(self.myso_rpc_url.clone()).await?;

        info!("Connected to MySo fullnode, subscribing to checkpoints...");

        // Build the subscription request with field mask
        let mut request = SubscribeCheckpointsRequest::default();
        request.read_mask = Some(FieldMask::from_str("transactions.events"));

        let mut stream = client.subscribe_checkpoints(request).await?.into_inner();

        info!("Subscribed to checkpoint stream");

        // Process each checkpoint as it arrives
        while let Some(response) = stream.next().await {
            let checkpoint_response = response?;

            // Get the cursor (checkpoint sequence number)
            let cursor = checkpoint_response.cursor.unwrap_or(0);

            // Skip if we've already processed this checkpoint (shouldn't happen)
            if let Some(last) = self.last_cursor {
                if cursor < last {
                    warn!(
                        "Checkpoint cursor rewound from {} to {} (chain regenesis?) — clearing membership cache",
                        last, cursor
                    );
                    self.membership_store.clear_all();
                    self.last_cursor = None;
                } else if cursor <= last {
                    continue;
                }
            }

            // Process the checkpoint if present
            if let Some(checkpoint) = checkpoint_response.checkpoint {
                self.process_checkpoint(&checkpoint, cursor).await;
            }

            // Update cursor position
            self.last_cursor = Some(cursor);
            self.membership_store.set_last_checkpoint_cursor(cursor);
        }

        Ok(())
    }

    /// Processes a single checkpoint,
    async fn process_checkpoint(
        &self,
        checkpoint: &myso_rpc::proto::myso::rpc::v2::Checkpoint,
        cursor: u64,
    ) {
        let mut events_processed = 0;
        let checkpoint_ts = checkpoint
            .summary
            .as_ref()
            .and_then(|s| s.timestamp.as_ref())
            .and_then(|ts| Utc.timestamp_opt(ts.seconds, ts.nanos as u32).single())
            .unwrap_or_else(Utc::now);

        for transaction in &checkpoint.transactions {
            let events = match &transaction.events {
                Some(events) => &events.events,
                None => continue,
            };

            let mut group_created = Vec::new();
            let mut permissions_granted = Vec::new();
            let mut agent_group_created_map: HashMap<String, _> = HashMap::new();

            for event in events {
                if let Some(groups_event) = parse_myso_event(event, &self.groups_package_id) {
                    self.apply_event(&groups_event);
                    events_processed += 1;
                }

                if let Some(agent_created) =
                    parse_agent_group_created_event(event, &self.messaging_package_id)
                {
                    agent_group_created_map.insert(agent_created.group_id.clone(), agent_created);
                }

                if let Some(detection_event) =
                    parse_agent_detection_event(event, &self.groups_package_id)
                {
                    match detection_event {
                        AgentDetectionEvent::GroupCreated(created) => group_created.push(created),
                        AgentDetectionEvent::PermissionsGranted(granted) => {
                            permissions_granted.push(granted);
                        }
                    }
                }

                // Paid DM escrow index: authoritative payment state for the paid-DM gate.
                if let Some(paid) =
                    parse_paid_message_sent_event(event, &self.messaging_package_id)
                {
                    info!(
                        "PaidMessageSent: group={} seq={} payer={} recipient={} amount={}",
                        paid.group_id, paid.seq, paid.payer, paid.recipient, paid.amount
                    );
                    let record = PaidEscrowRecord {
                        group_id: paid.group_id.clone(),
                        seq: i64::try_from(paid.seq).unwrap_or(i64::MAX),
                        payer: paid.payer,
                        recipient: paid.recipient,
                        amount: i64::try_from(paid.amount).unwrap_or(i64::MAX),
                        created_at_ms: i64::try_from(paid.created_at_ms).unwrap_or(i64::MAX),
                    };
                    if let Err(e) = self.storage.record_paid_escrow(record).await {
                        warn!(
                            "Failed to record paid escrow for group {}: {}",
                            paid.group_id, e
                        );
                    }
                }

                // Gate cache refresh from chain truth (avoids stale social-server refetch).
                if let Some(policy) =
                    parse_paid_policy_updated_event(event, &self.messaging_package_id)
                {
                    debug!(
                        "PaidMessagingPolicyUpdated: wallet={} enabled={} min_cost={:?}",
                        policy.wallet, policy.enabled, policy.min_cost
                    );
                    self.message_gate
                        .apply_policy_update(&policy.wallet, policy.enabled, policy.min_cost);
                }

                if let Some(follow) = parse_follow_changed_event(event, &self.social_package_id) {
                    debug!(
                        "FollowChanged: {} -> {} following={}",
                        follow.follower, follow.followee, follow.following
                    );
                    self.message_gate.apply_follow_update(
                        &follow.follower,
                        &follow.followee,
                        follow.following,
                    );
                }
            }

            for created in agent_group_created_map.values() {
                let group = agent_group_from_created_event(created);
                if let Err(e) = self.agent_group_store.upsert_agent_group(&group).await {
                    warn!(
                        "Failed to upsert agent messaging group {} from AgentGroupCreated: {}",
                        group.group_id, e
                    );
                }
            }

            let indexed_group_ids: HashSet<_> =
                agent_group_created_map.keys().cloned().collect();
            let agent_groups = detect_agent_groups_in_transaction(
                &group_created,
                &permissions_granted,
                &agent_group_created_map,
                checkpoint_ts,
            );
            for group in agent_groups {
                if indexed_group_ids.contains(&group.group_id) {
                    continue;
                }
                if let Err(e) = self.agent_group_store.upsert_agent_group(&group).await {
                    warn!(
                        "Failed to upsert agent messaging group {}: {}",
                        group.group_id, e
                    );
                }
            }
        }

        if events_processed > 0 || cursor.is_multiple_of(100) {
            debug!(
                "Processed checkpoint {}, {} Groups SDK events",
                cursor, events_processed
            );
        }
    }

    /// Applies a parsed GroupsEvent to the membership store
    fn apply_event(&self, event: &GroupsEvent) {
        match event {
            GroupsEvent::MemberAdded { group_id, member } => {
                info!("MemberAdded: {} -> {}", member, group_id);
                self.membership_store.add_member(group_id, member, vec![]);
            }

            GroupsEvent::MemberRemoved { group_id, member } => {
                info!("MemberRemoved: {} from {}", member, group_id);
                self.membership_store.remove_member(group_id, member);
            }

            GroupsEvent::PermissionsGranted {
                group_id,
                member,
                permissions,
            } => {
                if permissions.is_empty() {
                    warn!(
                        "PermissionsGranted with no recognized messaging permissions: {} -> {} (check GROUPS_PACKAGE_ID / event type names)",
                        member, group_id
                    );
                    return;
                }
                info!(
                    "PermissionsGranted: {} -> {} permissions: {:?}",
                    member, group_id, permissions
                );
                if let Err(e) = self
                    .membership_store
                    .grant_permissions(group_id, member, permissions.clone())
                {
                    warn!("Failed to grant permissions: {}", e);
                }
            }

            GroupsEvent::PermissionsRevoked {
                group_id,
                member,
                permissions,
            } => {
                info!(
                    "PermissionsRevoked: {} from {} permissions: {:?}",
                    member, group_id, permissions
                );
                if let Err(e) =
                    self.membership_store
                        .revoke_permissions(group_id, member, permissions.clone())
                {
                    warn!(
                        "Failed to revoke permissions: {} - possible missed MemberAdded event",
                        e
                    );
                }
            }
        }
    }
}
