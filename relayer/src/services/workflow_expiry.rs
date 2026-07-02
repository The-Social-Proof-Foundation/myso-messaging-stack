//! Background sweep that transitions expired workflow items to `expired`.
//!
//! v1 only sweeps `org_invitation` items (the only type with a chain-authoritative
//! `expires_at_ms`). The sweep runs every `interval_secs`, capped at `max_rows`
//! transitions per tick so no single sweep pinches the DB.

use std::sync::Arc;

use chrono::Utc;
use tracing::{debug, info, warn};

use crate::models::workflow_item::ITEM_TYPE_ORG_INVITATION;
use crate::storage::WorkflowStore;

pub async fn run_expiry_sweep(
    store: Arc<dyn WorkflowStore>,
    interval_secs: u64,
    max_rows: i64,
) {
    let interval_secs = interval_secs.max(60);
    let max_rows = max_rows.clamp(1, 5_000);
    info!(
        interval_secs,
        max_rows, "workflow expiry sweep loop started"
    );
    let mut ticker =
        tokio::time::interval(std::time::Duration::from_secs(interval_secs));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let now_ms = Utc::now().timestamp_millis();
        match store
            .sweep_expired(ITEM_TYPE_ORG_INVITATION, now_ms, max_rows)
            .await
        {
            Ok(0) => {
                debug!("workflow expiry sweep: no expired org invitations");
            }
            Ok(n) => {
                info!(
                    transitioned = n,
                    "workflow expiry sweep: transitioned org invitations to expired"
                );
            }
            Err(e) => {
                warn!("workflow expiry sweep failed: {e}");
            }
        }
    }
}
