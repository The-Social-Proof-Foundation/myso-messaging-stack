//! In-memory storage implementation for in-memory storage of messages and attachments.

use async_trait::async_trait;
use chrono::Utc;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::RwLock;
use uuid::Uuid;

use crate::models::{
    Attachment, EncryptedBlobRecord, Message, PushTokenRecord, ReactionEntry, ReceiptStateResponse,
    SyncStatus,
};

use super::adapter::{StorageAdapter, StorageError, StorageResult};

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
        record: EncryptedBlobRecord,
    ) -> StorageResult<()> {
        let mut states = self
            .user_read_states
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        states.insert(wallet.to_string(), record);
        Ok(())
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

    async fn update_presence(&self, wallet: &str) -> StorageResult<()> {
        let mut presence = self
            .presence
            .write()
            .map_err(|e| StorageError::OperationFailed(format!("Lock poisoned: {}", e)))?;
        presence.insert(wallet.to_string(), Utc::now());
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
