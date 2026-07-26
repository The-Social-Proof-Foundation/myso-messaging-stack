//! Debounce beginning-of-chat join activity/push so create+joins+first message
//! collapses to one notify, while invite-with-no-message still fires once.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::debug;

use crate::auth::MembershipStore;
use crate::models::MessageAttribution;
use crate::services::push::PushService;
use crate::services::realtime::RealtimeHub;
use crate::storage::StorageAdapter;

struct PendingJoin {
    handle: JoinHandle<()>,
}

/// Per-group debounce for invitee `member_joined` sidebar/push notify.
#[derive(Clone)]
pub struct BeginChatNotify {
    inner: Arc<Inner>,
}

struct Inner {
    pending: Mutex<HashMap<String, PendingJoin>>,
    delay: Duration,
    realtime_hub: Arc<RealtimeHub>,
    push_service: PushService,
    storage: Arc<dyn StorageAdapter>,
    membership_store: Arc<dyn MembershipStore>,
}

impl BeginChatNotify {
    pub fn new(
        delay: Duration,
        realtime_hub: Arc<RealtimeHub>,
        push_service: PushService,
        storage: Arc<dyn StorageAdapter>,
        membership_store: Arc<dyn MembershipStore>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                pending: Mutex::new(HashMap::new()),
                delay,
                realtime_hub,
                push_service,
                storage,
                membership_store,
            }),
        }
    }

    pub fn delay(&self) -> Duration {
        self.inner.delay
    }

    /// Schedule (or reschedule) a deferred join notify for an invitee.
    pub fn schedule_invitee_join(&self, group_id: &str, tip_order: i64, invitee: &str) {
        let group_key = group_id.to_ascii_lowercase();
        let invitee = invitee.to_string();
        let group_id = group_id.to_string();

        let mut pending = self
            .inner
            .pending
            .lock()
            .expect("begin chat notify lock poisoned");
        if let Some(prev) = pending.remove(&group_key) {
            prev.handle.abort();
        }

        let inner = Arc::clone(&self.inner);
        let delay = self.inner.delay;
        let pending_key = group_key.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut pending = inner.pending.lock().expect("begin chat notify lock poisoned");
                pending.remove(&pending_key);
            }
            debug!(
                "Begin-chat join notify firing group={} order={} invitee={}",
                group_id, tip_order, invitee
            );
            inner
                .realtime_hub
                .publish_group_activity(&group_id, tip_order);
            // Skip the invitee as "sender" so other members get push; invitee
            // already got `group.discovered` on MemberAdded. Creator sees the tip.
            inner
                .push_service
                .notify_new_message(
                    &inner.storage,
                    &inner.membership_store,
                    &group_id,
                    &invitee,
                    &MessageAttribution::human_message(),
                )
                .await;
        });

        pending.insert(group_key, PendingJoin { handle });
    }

    /// Cancel a pending join notify — human `create_message` already notifies.
    pub fn cancel(&self, group_id: &str) {
        let group_key = group_id.to_ascii_lowercase();
        let mut pending = self
            .inner
            .pending
            .lock()
            .expect("begin chat notify lock poisoned");
        if let Some(prev) = pending.remove(&group_key) {
            prev.handle.abort();
            debug!("Begin-chat join notify cancelled for group={}", group_id);
        }
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.inner
            .pending
            .lock()
            .expect("begin chat notify lock poisoned")
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::InMemoryMembershipStore;
    use crate::config::Config;
    use crate::services::push::PushService;
    use crate::storage::InMemoryStorage;

    #[tokio::test]
    async fn cancel_aborts_pending_join_notify() {
        let hub = Arc::new(RealtimeHub::new());
        let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
        let membership: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
        let notify = BeginChatNotify::new(
            Duration::from_millis(200),
            hub.clone(),
            PushService::from_config(&Config::default()),
            storage,
            membership,
        );
        let mut feed = hub.subscribe_user_feed();

        notify.schedule_invitee_join("0xgroup", 2, "0xpeer");
        assert_eq!(notify.pending_count(), 1);
        notify.cancel("0xgroup");
        assert_eq!(notify.pending_count(), 0);
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(feed.try_recv().is_err());
    }

    #[tokio::test]
    async fn timer_fires_group_activity_when_not_cancelled() {
        let storage: Arc<dyn StorageAdapter> = Arc::new(InMemoryStorage::new());
        let membership: Arc<dyn MembershipStore> = Arc::new(InMemoryMembershipStore::new());
        let hub = Arc::new(RealtimeHub::new());
        let mut feed = hub.subscribe_user_feed();
        let notify = BeginChatNotify::new(
            Duration::from_millis(40),
            hub,
            PushService::from_config(&Config::default()),
            storage,
            membership,
        );

        notify.schedule_invitee_join("0xgroup", 2, "0xpeer");
        let event = tokio::time::timeout(Duration::from_secs(2), feed.recv())
            .await
            .expect("timed out waiting for deferred activity")
            .expect("deferred activity");
        assert_eq!(
            event,
            crate::services::realtime::UserFeedEvent::GroupActivity {
                group_id: "0xgroup".to_string(),
                latest_order: 2,
            }
        );
        assert_eq!(notify.pending_count(), 0);
    }
}
