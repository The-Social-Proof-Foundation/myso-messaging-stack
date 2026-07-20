//! In-memory storage implementation for in-memory storage of messages and attachments.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::RwLock;
use uuid::Uuid;

use crate::models::{
    Attachment, EncryptedBlobRecord, GroupActivity, Message, PaidEscrowRecord, PushTokenRecord,
    ReactionEntry, ReceiptStateResponse, SyncStatus,
};

use super::adapter::{PutUserReadStateResult, StorageAdapter, StorageError, StorageResult};

/// In-memory storage backend using HashMaps protected by RwLock for thread-safety.
/// RwLock allows either many readers OR one writer at a time
/// Thread-safe for concurrent access. Data is lost on restart.
///
/// Lock ordering: always acquire `messages` before `nonces` to prevent deadlocks.
pub struct InMemoryStorage {
    /// All messages indexed by ID
    messages: RwLock<HashMap<Uuid, Message>>,
    /// Tracks the highest order number per group
    group_orders: RwLock<HashMap<String, i64>>,
    /// All message nonces for O(1) duplicate detection
    nonces: RwLock<HashSet<Vec<u8>>>,
    /// Per-user reactions keyed by `(group_id, chain_seq, emoji)` — `chain_seq` is the
    /// relayer-assigned message order, `emoji` the canonical Unicode string.
    /// Values are the reacting member addresses.
    reactions: RwLock<HashMap<(String, i64, String), BTreeSet<String>>>,
    /// Pinned on-chain sequence numbers per group.
    pins_by_group: RwLock<HashMap<String, BTreeSet<i64>>>,
    /// Delivery watermark per `(group_id, member_address) )`.
    delivered_watermarks: RwLock<HashMap<(String, String), u64>>,
    read_watermarks: RwLock<HashMap<(String, String), u64>>,
    user_read_states: RwLock<HashMap<String, EncryptedBlobRecord>>,
    push_tokens: RwLock<HashMap<(String, String), PushTokenRecord>>,
    presence: RwLock<HashMap<String, chrono::DateTime<chrono::Utc>>>,
    /// On-chain paid DM escrows keyed by `(group_id, seq)`.
    paid_escrows: RwLock<HashMap<(String, i64), PaidEscrowRecord>>,
}

impl InMemoryStorage {
    pub fn new() -> Self {
        Self {
            messages: RwLock::new(HashMap::new()),
            group_orders: RwLock::new(HashMap::new()),
            nonces: RwLock::new(HashSet::new()),
            reactions: RwLock::new(HashMap::new()),
            pins_by_group: RwLock::new(HashMap::new()),
            delivered_watermarks: RwLock::new(HashMap::new()),
            read_watermarks: RwLock::new(HashMap::new()),
            user_read_states: RwLock::new(HashMap::new()),
            push_tokens: RwLock::new(HashMap::new()),
            presence: RwLock::new(HashMap::new()),
            paid_escrows: RwLock::new(HashMap::new()),
        }
    }

    /// Gets the next order number for a specific group (auto-increment)
    fn next_order(&self, group_id: &str) -> StorageResult<i64> {
        let mut orders = self
            .group_orders
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let next = orders.get(group_id).map(|o| o + 1).unwrap_or(1); // Look up current max order for this group, add 1, store the new max
        orders.insert(group_id.to_string(), next);
        Ok(next)
    }
}

impl Default for InMemoryStorage {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl StorageAdapter for InMemoryStorage {
    async fn health_check(&self) -> StorageResult<()> {
        Ok(())
    }

    async fn create_message(&self, mut message: Message) -> StorageResult<Message> {
        // Assign next order for the group
        let order = self.next_order(&message.group_id)?;
        message.set_order(order);

        let mut messages = self
            .messages
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        // Check for duplicate ID
        if messages.contains_key(&message.id) {
            return Err(StorageError::DuplicateId(message.id));
        }

        // O(1) nonce duplicate check via HashSet
        let mut nonces = self
            .nonces
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        if nonces.contains(&message.nonce) {
            return Err(StorageError::DuplicateNonce);
        }

        nonces.insert(message.nonce.clone());
        messages.insert(message.id, message.clone());

        Ok(message)
    }

    async fn get_message(&self, id: Uuid) -> StorageResult<Message> {
        let messages = self
            .messages
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        messages.get(&id).cloned().ok_or(StorageError::NotFound(id))
    }

    async fn get_messages_by_group(
        &self,
        group_id: &str,
        after_order: Option<i64>,
        before_order: Option<i64>,
        limit: usize,
    ) -> StorageResult<Vec<Message>> {
        let messages = self
            .messages
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let mut filtered: Vec<Message> = messages
            .values()
            .filter(|m| m.group_id == group_id)
            .filter(|m| {
                let order = m.order.unwrap_or(0);
                // Apply both after_order and before_order filters together
                // after_order: exclusive lower bound (order > after_order)
                // before_order: exclusive upper bound (order < before_order)
                match (after_order, before_order) {
                    (Some(after), Some(before)) => order > after && order < before,
                    (Some(after), None) => order > after,
                    (None, Some(before)) => order < before,
                    (None, None) => true,
                }
            })
            .cloned()
            .collect();

        // Sort by order ascending
        filtered.sort_by_key(|m| m.order.unwrap_or(0));

        // Newest window when scrolling up or on initial load; oldest-first when after_order set
        if after_order.is_none() {
            if filtered.len() > limit {
                let start = filtered.len() - limit;
                filtered = filtered.split_off(start);
            }
        } else if filtered.len() > limit {
            filtered.truncate(limit);
        }

        Ok(filtered)
    }

    async fn update_message(
        &self,
        id: Uuid,
        encrypted_msg: Vec<u8>,
        nonce: Vec<u8>,
        key_version: i64,
        attachments: Vec<Attachment>,
        signature: Vec<u8>,
        public_key: Vec<u8>,
    ) -> StorageResult<Message> {
        let mut messages = self
            .messages
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let message = messages.get_mut(&id).ok_or(StorageError::NotFound(id))?;

        // Check new nonce isn't already used by another message
        let mut nonces = self
            .nonces
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        if message.nonce != nonce && nonces.contains(&nonce) {
            return Err(StorageError::DuplicateNonce);
        }
        // Swap old nonce for new one in the set
        nonces.remove(&message.nonce);
        nonces.insert(nonce.clone());

        message.update_content(
            encrypted_msg,
            nonce,
            key_version,
            attachments,
            signature,
            public_key,
        );

        Ok(message.clone())
    }

    async fn delete_message(&self, id: Uuid) -> StorageResult<Message> {
        let mut messages = self
            .messages
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let message = messages.get_mut(&id).ok_or(StorageError::NotFound(id))?;

        message.mark_for_deletion();

        Ok(message.clone())
    }

    async fn update_sync_status(
        &self,
        id: Uuid,
        status: SyncStatus,
        quilt_patch_id: Option<String>,
    ) -> StorageResult<Message> {
        let mut messages = self
            .messages
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let message = messages.get_mut(&id).ok_or(StorageError::NotFound(id))?;

        message.sync_status = status;
        message.updated_at = Utc::now();
        if let Some(patch_id) = quilt_patch_id {
            message.quilt_patch_id = Some(patch_id);
        }

        Ok(message.clone())
    }
    async fn get_messages_by_sync_status(
        &self,
        status: SyncStatus,
        limit: usize,
    ) -> StorageResult<Vec<Message>> {
        let messages = self
            .messages
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let filtered: Vec<Message> = messages
            .values()
            .filter(|m| m.sync_status == status)
            .take(limit)
            .cloned()
            .collect();

        Ok(filtered)
    }

    async fn record_paid_escrow(&self, escrow: PaidEscrowRecord) -> StorageResult<()> {
        let mut escrows = self
            .paid_escrows
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        escrows.insert((escrow.group_id.clone(), escrow.seq), escrow);
        Ok(())
    }

    async fn has_paid_escrow(
        &self,
        group_id: &str,
        payer: &str,
        recipient: &str,
        min_amount: i64,
        validity: Option<crate::storage::PaidEscrowValidityFilter>,
    ) -> StorageResult<bool> {
        let escrows = self
            .paid_escrows
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(escrows.values().any(|e| {
            e.group_id == group_id
                && e.payer == payer
                && e.recipient == recipient
                && e.amount >= min_amount
                && validity.map_or(true, |v| v.is_valid(e.created_at_ms))
        }))
    }

    async fn latest_paid_escrow_amount(
        &self,
        group_id: &str,
        payer: &str,
        recipient: &str,
        validity: Option<crate::storage::PaidEscrowValidityFilter>,
    ) -> StorageResult<Option<i64>> {
        let escrows = self
            .paid_escrows
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(escrows
            .values()
            .filter(|e| {
                e.group_id == group_id
                    && e.payer == payer
                    && e.recipient == recipient
                    && validity.map_or(true, |v| v.is_valid(e.created_at_ms))
            })
            .max_by_key(|e| e.seq)
            .map(|e| e.amount))
    }

    async fn has_message_from(&self, group_id: &str, sender: &str) -> StorageResult<bool> {
        let messages = self
            .messages
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(messages
            .values()
            .any(|m| m.group_id == group_id && m.sender_wallet_addr == sender))
    }

    async fn get_group_activity(
        &self,
        group_id: &str,
        after_order: i64,
    ) -> StorageResult<GroupActivity> {
        let messages = self
            .messages
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let mut latest_order = 0i64;
        let mut unread_count = 0i64;
        for m in messages.values().filter(|m| m.group_id == group_id) {
            let order = m.order.unwrap_or(0);
            latest_order = latest_order.max(order);
            let deleted = matches!(
                m.sync_status,
                SyncStatus::DeletePending | SyncStatus::Deleted
            );
            if order > after_order && !deleted {
                unread_count += 1;
            }
        }

        Ok(GroupActivity {
            latest_order,
            unread_count,
        })
    }

    async fn set_reaction(
        &self,
        group_id: &str,
        chain_seq: i64,
        emoji: &str,
        member: &str,
        add: bool,
    ) -> StorageResult<Option<ReactionEntry>> {
        let mut reactions = self
            .reactions
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let key = (group_id.to_string(), chain_seq, emoji.to_string());
        let changed = if add {
            reactions.entry(key.clone()).or_default().insert(member.to_string())
        } else {
            match reactions.get_mut(&key) {
                Some(set) => {
                    let removed = set.remove(member);
                    if set.is_empty() {
                        reactions.remove(&key);
                    }
                    removed
                }
                None => false,
            }
        };

        if !changed {
            return Ok(None);
        }

        let reactors: Vec<String> = reactions
            .get(&key)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default();
        Ok(Some(ReactionEntry {
            chain_seq,
            emoji: emoji.to_string(),
            count: reactors.len() as i32,
            reactors,
        }))
    }

    async fn list_reactions(
        &self,
        group_id: &str,
        chain_seq: Option<i64>,
    ) -> StorageResult<Vec<ReactionEntry>> {
        let reactions = self
            .reactions
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let mut out: Vec<ReactionEntry> = reactions
            .iter()
            .filter(|(k, set)| k.0 == group_id && !set.is_empty())
            .filter(|(k, _)| chain_seq.map(|s| s == k.1).unwrap_or(true))
            .map(|(k, set)| ReactionEntry {
                chain_seq: k.1,
                emoji: k.2.clone(),
                count: set.len() as i32,
                reactors: set.iter().cloned().collect(),
            })
            .collect();
        out.sort_by(|a, b| {
            a.chain_seq
                .cmp(&b.chain_seq)
                .then_with(|| a.emoji.cmp(&b.emoji))
        });
        Ok(out)
    }

    async fn set_pin_for_seq(&self, group_id: &str, chain_seq: i64, on: bool) -> StorageResult<()> {
        let mut pins = self
            .pins_by_group
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let set = pins.entry(group_id.to_string()).or_default();
        if on {
            set.insert(chain_seq);
        } else {
            set.remove(&chain_seq);
        }
        Ok(())
    }

    async fn list_pins(&self, group_id: &str) -> StorageResult<Vec<i64>> {
        let pins = self
            .pins_by_group
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let mut v: Vec<i64> = pins
            .get(group_id)
            .map(|s| s.iter().copied().collect())
            .unwrap_or_default();
        v.sort_unstable();
        Ok(v)
    }

    async fn update_receipt_delivered(
        &self,
        group_id: &str,
        member: &str,
        upto: u64,
    ) -> StorageResult<()> {
        let mut m = self
            .delivered_watermarks
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let key = (group_id.to_string(), member.to_string());
        let cur = m.get(&key).copied().unwrap_or(0);
        if upto > cur {
            m.insert(key, upto);
        }
        Ok(())
    }

    async fn update_receipt_read(
        &self,
        group_id: &str,
        member: &str,
        upto: u64,
    ) -> StorageResult<()> {
        let mut m = self
            .read_watermarks
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let key = (group_id.to_string(), member.to_string());
        let cur = m.get(&key).copied().unwrap_or(0);
        if upto > cur {
            m.insert(key, upto);
        }
        Ok(())
    }

    async fn get_receipt_state(
        &self,
        group_id: &str,
        member: &str,
    ) -> StorageResult<ReceiptStateResponse> {
        let d = self
            .delivered_watermarks
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let r = self
            .read_watermarks
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let key = (group_id.to_string(), member.to_string());
        Ok(ReceiptStateResponse {
            delivered_upto: d.get(&key).copied(),
            read_upto: r.get(&key).copied(),
        })
    }

    async fn get_user_read_state(&self, wallet: &str) -> StorageResult<Option<EncryptedBlobRecord>> {
        let states = self
            .user_read_states
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(states.get(wallet).cloned())
    }

    async fn put_user_read_state(
        &self,
        wallet: &str,
        encrypted_blob: Vec<u8>,
        expected_version: Option<u64>,
    ) -> StorageResult<PutUserReadStateResult> {
        let mut states = self
            .user_read_states
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;

        let current_version = states.get(wallet).map(|r| r.blob_version);

        // CAS check: only when the caller supplied an expectation AND a row
        // exists. Rows are never deleted, so "expected but absent" only occurs
        // for odd client state — treat it as a create.
        if let (Some(expected), Some(current)) = (expected_version, current_version) {
            if expected != current {
                return Ok(PutUserReadStateResult::Conflict {
                    current: states.get(wallet).cloned().expect("checked above"),
                });
            }
        }

        let blob_version = current_version.unwrap_or(0) + 1;
        states.insert(
            wallet.to_string(),
            EncryptedBlobRecord {
                encrypted_blob,
                blob_version,
                updated_at: Utc::now(),
            },
        );
        Ok(PutUserReadStateResult::Stored { blob_version })
    }

    async fn upsert_push_token(&self, record: PushTokenRecord) -> StorageResult<()> {
        let mut tokens = self
            .push_tokens
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        tokens.insert(
            (record.wallet.clone(), record.token.clone()),
            record,
        );
        Ok(())
    }

    async fn delete_push_token(&self, wallet: &str, token: &str) -> StorageResult<()> {
        let mut tokens = self
            .push_tokens
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        tokens.remove(&(wallet.to_string(), token.to_string()));
        Ok(())
    }

    async fn list_push_tokens_for_wallet(&self, wallet: &str) -> StorageResult<Vec<PushTokenRecord>> {
        let tokens = self
            .push_tokens
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(tokens
            .values()
            .filter(|t| t.wallet == wallet)
            .cloned()
            .collect())
    }

    async fn list_push_tokens_for_wallets(
        &self,
        wallets: &[String],
    ) -> StorageResult<HashMap<String, Vec<PushTokenRecord>>> {
        if wallets.is_empty() {
            return Ok(HashMap::new());
        }
        let wallet_set: HashSet<&str> = wallets.iter().map(String::as_str).collect();
        let tokens = self
            .push_tokens
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        let mut out: HashMap<String, Vec<PushTokenRecord>> = HashMap::new();
        for token in tokens.values() {
            if wallet_set.contains(token.wallet.as_str()) {
                out.entry(token.wallet.clone()).or_default().push(token.clone());
            }
        }
        Ok(out)
    }

    async fn update_presence(&self, wallet: &str) -> StorageResult<()> {
        let mut presence = self
            .presence
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        presence.insert(wallet.to_string(), Utc::now());
        Ok(())
    }

    async fn clear_presence(&self, wallet: &str) -> StorageResult<()> {
        let mut presence = self
            .presence
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        presence.remove(wallet);
        Ok(())
    }

    async fn get_presence_last_seen(
        &self,
        wallet: &str,
    ) -> StorageResult<Option<chrono::DateTime<chrono::Utc>>> {
        let presence = self
            .presence
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(presence.get(wallet).copied())
    }

    async fn get_presence_last_seen_for_wallets(
        &self,
        wallets: &[String],
    ) -> StorageResult<HashMap<String, chrono::DateTime<chrono::Utc>>> {
        if wallets.is_empty() {
            return Ok(HashMap::new());
        }
        let wallet_set: HashSet<&str> = wallets.iter().map(String::as_str).collect();
        let presence = self
            .presence
            .read()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        Ok(presence
            .iter()
            .filter(|(wallet, _)| wallet_set.contains(wallet.as_str()))
            .map(|(wallet, last_seen)| (wallet.clone(), *last_seen))
            .collect())
    }

    async fn notify_realtime_event(&self, _payload_json: &str) -> StorageResult<()> {
        // Single-instance in-memory deployments publish inline; nothing to do.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Message;

    fn unique_nonce(i: u8) -> Vec<u8> {
        let mut nonce = vec![0u8; 12];
        nonce[0] = i;
        nonce
    }

    #[tokio::test]
    async fn test_create_message_assigns_order() {
        let storage = InMemoryStorage::new();
        let msg = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1, 2, 3],
            unique_nonce(0),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );

        let created = storage.create_message(msg).await.unwrap();

        assert_eq!(created.order, Some(1));
        assert_eq!(created.group_id, "group_1");
    }

    fn sample_message(group_id: &str, nonce_seed: u8) -> Message {
        Message::new(
            group_id.to_string(),
            "0xabc".to_string(),
            vec![1, 2, 3],
            unique_nonce(nonce_seed),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        )
    }

    #[tokio::test]
    async fn test_get_group_activity_counts_and_boundaries() {
        let storage = InMemoryStorage::new();

        // Empty group: zeros.
        let empty = storage.get_group_activity("group_1", 0).await.unwrap();
        assert_eq!(empty.latest_order, 0);
        assert_eq!(empty.unread_count, 0);

        for i in 0..4u8 {
            storage
                .create_message(sample_message("group_1", i))
                .await
                .unwrap();
        }
        // Another group's messages must not leak into the count.
        storage
            .create_message(sample_message("group_2", 100))
            .await
            .unwrap();

        let all = storage.get_group_activity("group_1", 0).await.unwrap();
        assert_eq!(all.latest_order, 4);
        assert_eq!(all.unread_count, 4);

        // after_order is exclusive: order > 2 leaves orders 3 and 4.
        let after = storage.get_group_activity("group_1", 2).await.unwrap();
        assert_eq!(after.latest_order, 4);
        assert_eq!(after.unread_count, 2);

        // Watermark at (or past) the head: zero unread.
        let head = storage.get_group_activity("group_1", 4).await.unwrap();
        assert_eq!(head.unread_count, 0);
        assert_eq!(head.latest_order, 4);
    }

    #[tokio::test]
    async fn test_get_group_activity_excludes_deleted_but_keeps_latest_order() {
        let storage = InMemoryStorage::new();

        let mut ids = Vec::new();
        for i in 0..3u8 {
            let created = storage
                .create_message(sample_message("group_1", i))
                .await
                .unwrap();
            ids.push(created.id);
        }

        // Soft-delete the newest message (order 3).
        storage.delete_message(ids[2]).await.unwrap();

        let activity = storage.get_group_activity("group_1", 0).await.unwrap();
        // Order assignment is monotonic — deleted rows keep their slot.
        assert_eq!(activity.latest_order, 3);
        // But deleted messages never count as unread.
        assert_eq!(activity.unread_count, 2);
    }

    #[tokio::test]
    async fn test_put_user_read_state_versions_and_cas() {
        let storage = InMemoryStorage::new();

        // First write (no expectation): server assigns version 1.
        let first = storage
            .put_user_read_state("0xw", vec![1], None)
            .await
            .unwrap();
        let PutUserReadStateResult::Stored { blob_version } = first else {
            panic!("expected stored");
        };
        assert_eq!(blob_version, 1);

        // Legacy last-writer-wins (no expected_version): always succeeds, bumps version.
        let lww = storage
            .put_user_read_state("0xw", vec![2], None)
            .await
            .unwrap();
        let PutUserReadStateResult::Stored { blob_version } = lww else {
            panic!("expected stored");
        };
        assert_eq!(blob_version, 2);

        // CAS success: matching expectation.
        let cas_ok = storage
            .put_user_read_state("0xw", vec![3], Some(2))
            .await
            .unwrap();
        let PutUserReadStateResult::Stored { blob_version } = cas_ok else {
            panic!("expected stored");
        };
        assert_eq!(blob_version, 3);

        // CAS conflict: stale expectation returns the current record unchanged.
        let conflict = storage
            .put_user_read_state("0xw", vec![9], Some(2))
            .await
            .unwrap();
        let PutUserReadStateResult::Conflict { current } = conflict else {
            panic!("expected conflict");
        };
        assert_eq!(current.blob_version, 3);
        assert_eq!(current.encrypted_blob, vec![3]);

        // Stored blob was not clobbered by the conflicting write.
        let stored = storage.get_user_read_state("0xw").await.unwrap().unwrap();
        assert_eq!(stored.blob_version, 3);
        assert_eq!(stored.encrypted_blob, vec![3]);
    }

    #[tokio::test]
    async fn test_create_multiple_messages_increments_order() {
        let storage = InMemoryStorage::new();

        let msg1 = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1],
            unique_nonce(1),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg2 = Message::new(
            "group_1".to_string(),
            "0xdef".to_string(),
            vec![2],
            unique_nonce(2),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg3 = Message::new(
            "group_1".to_string(),
            "0x123".to_string(),
            vec![3],
            unique_nonce(3),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );

        let created1 = storage.create_message(msg1).await.unwrap();
        let created2 = storage.create_message(msg2).await.unwrap();
        let created3 = storage.create_message(msg3).await.unwrap();

        assert_eq!(created1.order, Some(1));
        assert_eq!(created2.order, Some(2));
        assert_eq!(created3.order, Some(3));
    }

    #[tokio::test]
    async fn test_paid_escrow_upsert_and_lookup() {
        let storage = InMemoryStorage::new();
        let record = crate::models::PaidEscrowRecord {
            group_id: "group_1".to_string(),
            seq: 0,
            payer: "0xpayer".to_string(),
            recipient: "0xrecipient".to_string(),
            amount: 100,
            created_at_ms: 0,
        };

        storage.record_paid_escrow(record.clone()).await.unwrap();
        // Checkpoint replay upserts on (group_id, seq).
        storage.record_paid_escrow(record).await.unwrap();

        assert!(storage
            .has_paid_escrow("group_1", "0xpayer", "0xrecipient", 0, None)
            .await
            .unwrap());
        assert!(storage
            .has_paid_escrow("group_1", "0xpayer", "0xrecipient", 100, None)
            .await
            .unwrap());
        // min_amount above escrowed value does not match.
        assert!(!storage
            .has_paid_escrow("group_1", "0xpayer", "0xrecipient", 101, None)
            .await
            .unwrap());
        // Direction matters.
        assert!(!storage
            .has_paid_escrow("group_1", "0xrecipient", "0xpayer", 0, None)
            .await
            .unwrap());
        // Group scope matters.
        assert!(!storage
            .has_paid_escrow("group_2", "0xpayer", "0xrecipient", 0, None)
            .await
            .unwrap());

        // Latest-amount lookup returns the highest-seq escrow for the pair.
        assert_eq!(
            storage
                .latest_paid_escrow_amount("group_1", "0xpayer", "0xrecipient", None)
                .await
                .unwrap(),
            Some(100)
        );
        storage
            .record_paid_escrow(crate::models::PaidEscrowRecord {
                group_id: "group_1".to_string(),
                seq: 1,
                payer: "0xpayer".to_string(),
                recipient: "0xrecipient".to_string(),
                amount: 250,
                created_at_ms: 1,
            })
            .await
            .unwrap();
        assert_eq!(
            storage
                .latest_paid_escrow_amount("group_1", "0xpayer", "0xrecipient", None)
                .await
                .unwrap(),
            Some(250)
        );
        // Direction matters for the amount lookup too.
        assert_eq!(
            storage
                .latest_paid_escrow_amount("group_1", "0xrecipient", "0xpayer", None)
                .await
                .unwrap(),
            None
        );

        let now_ms = chrono::Utc::now().timestamp_millis();
        let validity = crate::storage::PaidEscrowValidityFilter {
            now_ms,
            payment_expiration_ms: 2_592_000_000,
        };
        // Legacy test fixtures with `created_at_ms: 0` are treated as expired.
        assert!(!storage
            .has_paid_escrow("group_1", "0xpayer", "0xrecipient", 0, Some(validity))
            .await
            .unwrap());
        storage
            .record_paid_escrow(crate::models::PaidEscrowRecord {
                group_id: "group_1".to_string(),
                seq: 2,
                payer: "0xpayer".to_string(),
                recipient: "0xrecipient".to_string(),
                amount: 500,
                created_at_ms: now_ms,
            })
            .await
            .unwrap();
        assert!(storage
            .has_paid_escrow("group_1", "0xpayer", "0xrecipient", 0, Some(validity))
            .await
            .unwrap());
        assert_eq!(
            storage
                .latest_paid_escrow_amount("group_1", "0xpayer", "0xrecipient", Some(validity))
                .await
                .unwrap(),
            Some(500)
        );
    }

    #[tokio::test]
    async fn test_has_message_from_is_per_sender() {
        let storage = InMemoryStorage::new();
        let msg = Message::new(
            "group_1".to_string(),
            "0xalice".to_string(),
            vec![1],
            unique_nonce(42),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        storage.create_message(msg).await.unwrap();

        assert!(storage.has_message_from("group_1", "0xalice").await.unwrap());
        // Same group, different sender — their first outbound message is still pending.
        assert!(!storage.has_message_from("group_1", "0xbob").await.unwrap());
        assert!(!storage.has_message_from("group_2", "0xalice").await.unwrap());
    }

    #[tokio::test]
    async fn test_set_reaction_add_remove_idempotent() {
        let storage = InMemoryStorage::new();

        let first = storage
            .set_reaction("group_1", 1, "👍", "0xalice", true)
            .await
            .unwrap()
            .expect("first add changes state");
        assert_eq!(first.count, 1);
        assert_eq!(first.reactors, vec!["0xalice"]);

        // Re-adding the same reaction is a no-op.
        let dup = storage
            .set_reaction("group_1", 1, "👍", "0xalice", true)
            .await
            .unwrap();
        assert!(dup.is_none());

        let second = storage
            .set_reaction("group_1", 1, "👍", "0xbob", true)
            .await
            .unwrap()
            .expect("second reactor changes state");
        assert_eq!(second.count, 2);
        assert_eq!(second.reactors, vec!["0xalice", "0xbob"]);

        let removed = storage
            .set_reaction("group_1", 1, "👍", "0xalice", false)
            .await
            .unwrap()
            .expect("removal changes state");
        assert_eq!(removed.count, 1);
        assert_eq!(removed.reactors, vec!["0xbob"]);

        // Removing an absent reaction is a no-op.
        let absent = storage
            .set_reaction("group_1", 1, "👍", "0xalice", false)
            .await
            .unwrap();
        assert!(absent.is_none());
    }

    #[tokio::test]
    async fn test_set_reaction_supports_multi_code_point_emoji() {
        let storage = InMemoryStorage::new();

        // ZWJ sequence (family) and variation selector (red heart).
        for emoji in ["👨‍👩‍👧‍👦", "❤️", "👍🏻", "🏳️‍🌈"] {
            let entry = storage
                .set_reaction("group_1", 1, emoji, "0xalice", true)
                .await
                .unwrap()
                .expect("add changes state");
            assert_eq!(entry.emoji, emoji);
            assert_eq!(entry.count, 1);
        }

        let all = storage.list_reactions("group_1", Some(1)).await.unwrap();
        assert_eq!(all.len(), 4);
    }

    #[tokio::test]
    async fn test_list_reactions_filters_by_chain_seq() {
        let storage = InMemoryStorage::new();
        storage
            .set_reaction("group_1", 1, "👍", "0xalice", true)
            .await
            .unwrap();
        storage
            .set_reaction("group_1", 2, "😂", "0xalice", true)
            .await
            .unwrap();
        storage
            .set_reaction("group_2", 1, "👍", "0xbob", true)
            .await
            .unwrap();

        let all = storage.list_reactions("group_1", None).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].chain_seq, 1);
        assert_eq!(all[1].chain_seq, 2);

        let filtered = storage.list_reactions("group_1", Some(2)).await.unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].emoji, "😂");
        assert_eq!(filtered[0].reactors, vec!["0xalice"]);

        // Fully removed entries disappear from listings.
        storage
            .set_reaction("group_1", 2, "😂", "0xalice", false)
            .await
            .unwrap();
        let after_remove = storage.list_reactions("group_1", None).await.unwrap();
        assert_eq!(after_remove.len(), 1);
    }

    #[tokio::test]
    async fn test_create_message_rejects_duplicate_nonce() {
        let storage = InMemoryStorage::new();

        let msg1 = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1],
            unique_nonce(99),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg2 = Message::new(
            "group_1".to_string(),
            "0xdef".to_string(),
            vec![2],
            unique_nonce(99), // same nonce
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );

        storage.create_message(msg1).await.unwrap();
        let result = storage.create_message(msg2).await;

        assert!(matches!(result, Err(StorageError::DuplicateNonce)));
    }

    #[tokio::test]
    async fn test_get_message() {
        let storage = InMemoryStorage::new();
        let msg = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1],
            unique_nonce(0),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg_id = msg.id;

        storage.create_message(msg).await.unwrap();
        let fetched = storage.get_message(msg_id).await.unwrap();

        assert_eq!(fetched.id, msg_id);
    }

    #[tokio::test]
    async fn test_get_message_not_found() {
        let storage = InMemoryStorage::new();
        let result = storage.get_message(Uuid::new_v4()).await;

        assert!(matches!(result, Err(StorageError::NotFound(_))));
    }

    #[tokio::test]
    async fn test_get_messages_by_group() {
        let storage = InMemoryStorage::new();

        for i in 0..5 {
            let msg = Message::new(
                "group_1".to_string(),
                format!("0x{}", i),
                vec![i as u8],
                unique_nonce(i as u8),
                0,
                vec![],
                vec![0u8; 64],
                vec![0u8; 33],
            );
            storage.create_message(msg).await.unwrap();
        }

        for i in 0..3 {
            let msg = Message::new(
                "group_2".to_string(),
                format!("0x{}", i),
                vec![i as u8],
                unique_nonce(10 + i as u8),
                0,
                vec![],
                vec![0u8; 64],
                vec![0u8; 33],
            );
            storage.create_message(msg).await.unwrap();
        }

        let group1_messages = storage
            .get_messages_by_group("group_1", None, None, 10)
            .await
            .unwrap();
        let group2_messages = storage
            .get_messages_by_group("group_2", None, None, 10)
            .await
            .unwrap();

        assert_eq!(group1_messages.len(), 5);
        assert_eq!(group2_messages.len(), 3);
    }

    #[tokio::test]
    async fn test_get_messages_by_group_pagination_after() {
        let storage = InMemoryStorage::new();

        for i in 0..5 {
            let msg = Message::new(
                "group_1".to_string(),
                format!("0x{}", i),
                vec![i],
                unique_nonce(i),
                0,
                vec![],
                vec![0u8; 64],
                vec![0u8; 33],
            );
            storage.create_message(msg).await.unwrap();
        }

        // Get messages after order 2
        let messages = storage
            .get_messages_by_group("group_1", Some(2), None, 10)
            .await
            .unwrap();

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].order, Some(3));
        assert_eq!(messages[1].order, Some(4));
        assert_eq!(messages[2].order, Some(5));
    }

    #[tokio::test]
    async fn test_get_messages_by_group_pagination_before() {
        let storage = InMemoryStorage::new();

        for i in 0..5 {
            let msg = Message::new(
                "group_1".to_string(),
                format!("0x{}", i),
                vec![i],
                unique_nonce(i),
                0,
                vec![],
                vec![0u8; 64],
                vec![0u8; 33],
            );
            storage.create_message(msg).await.unwrap();
        }

        // Get messages before order 4
        let messages = storage
            .get_messages_by_group("group_1", None, Some(4), 10)
            .await
            .unwrap();

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].order, Some(1));
        assert_eq!(messages[1].order, Some(2));
        assert_eq!(messages[2].order, Some(3));
    }

    #[tokio::test]
    async fn test_delete_message_sets_status() {
        let storage = InMemoryStorage::new();
        let msg = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1],
            unique_nonce(0),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg_id = msg.id;

        storage.create_message(msg).await.unwrap();
        let deleted = storage.delete_message(msg_id).await.unwrap();

        assert_eq!(deleted.sync_status, SyncStatus::DeletePending);
    }

    #[tokio::test]
    async fn test_update_sync_status() {
        let storage = InMemoryStorage::new();
        let msg = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1],
            unique_nonce(0),
            0,
            vec![],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg_id = msg.id;

        storage.create_message(msg).await.unwrap();
        let updated = storage
            .update_sync_status(msg_id, SyncStatus::Synced, Some("quilt_123".to_string()))
            .await
            .unwrap();

        assert_eq!(updated.sync_status, SyncStatus::Synced);
        assert_eq!(updated.quilt_patch_id, Some("quilt_123".to_string()));
    }

    #[tokio::test]
    async fn test_get_messages_by_sync_status() {
        let storage = InMemoryStorage::new();

        // Create 3 messages (all SYNC_PENDING by default)
        for i in 0..3 {
            let msg = Message::new(
                "group_1".to_string(),
                format!("0x{}", i),
                vec![i],
                unique_nonce(i),
                0,
                vec![],
                vec![0u8; 64],
                vec![0u8; 33],
            );
            storage.create_message(msg).await.unwrap();
        }

        let pending = storage
            .get_messages_by_sync_status(SyncStatus::SyncPending, 10)
            .await
            .unwrap();

        assert_eq!(pending.len(), 3);
    }

    fn sample_attachment(id: &str) -> Attachment {
        Attachment {
            storage_id: format!("patch-{}", id),
            nonce: vec![0xaa; 12],
            encrypted_metadata: vec![0xca, 0xfe],
            metadata_nonce: vec![0xdd; 12],
        }
    }

    #[tokio::test]
    async fn test_create_message_with_attachments() {
        let storage = InMemoryStorage::new();
        let attachments = vec![sample_attachment("1"), sample_attachment("2")];

        let msg = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1, 2, 3],
            unique_nonce(50),
            0,
            attachments.clone(),
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg_id = msg.id;

        storage.create_message(msg).await.unwrap();
        let fetched = storage.get_message(msg_id).await.unwrap();

        assert_eq!(fetched.attachments.len(), 2);
        assert_eq!(fetched.attachments, attachments);
    }

    #[tokio::test]
    async fn test_update_message_replaces_attachments() {
        let storage = InMemoryStorage::new();

        let msg = Message::new(
            "group_1".to_string(),
            "0xabc".to_string(),
            vec![1],
            unique_nonce(60),
            0,
            vec![sample_attachment("original")],
            vec![0u8; 64],
            vec![0u8; 33],
        );
        let msg_id = msg.id;
        storage.create_message(msg).await.unwrap();

        let new_attachments = vec![sample_attachment("a"), sample_attachment("b")];
        let updated = storage
            .update_message(
                msg_id,
                vec![2],
                unique_nonce(61),
                1,
                new_attachments.clone(),
                vec![0u8; 64],
                vec![0u8; 33],
            )
            .await
            .unwrap();

        assert_eq!(updated.attachments, new_attachments);
        assert_eq!(updated.sync_status, SyncStatus::UpdatePending);

        // Verify via separate get
        let fetched = storage.get_message(msg_id).await.unwrap();
        assert_eq!(fetched.attachments, new_attachments);
    }
}
