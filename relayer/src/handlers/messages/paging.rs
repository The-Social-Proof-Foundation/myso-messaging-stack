//! Message-list paging that counts only timeline rows toward `limit`.
//!
//! Content-envelope-v2 `event` rows (encrypted reactions, edits, deletes, pins, votes) share the
//! message log. If they counted toward `limit`, a burst of reactions could fill a page and hide
//! every message. Instead a page holds up to `limit` non-event rows plus every event row inside
//! the same order window, so clients can fold each page's events without extra requests.

use crate::models::Message;
use crate::storage::{StorageAdapter, StorageResult};

/// Hard cap on event rows returned alongside one page.
pub const MAX_EVENT_ROWS_PER_PAGE: usize = 500;

fn is_event(m: &Message) -> bool {
    m.kind.is_control()
}

fn order_of(m: &Message) -> i64 {
    m.order.unwrap_or(0)
}

/// Returns rows in ascending order plus `has_next`.
///
/// - `after_order` set: the oldest `limit` timeline rows newer than it (bounded by `before_order`).
/// - otherwise: the newest `limit` timeline rows older than `before_order` (or the tip), including
///   any events newer than the newest of them.
pub async fn fetch_page(
    storage: &dyn StorageAdapter,
    group_id: &str,
    after_order: Option<i64>,
    before_order: Option<i64>,
    limit: usize,
) -> StorageResult<(Vec<Message>, bool)> {
    let limit = limit.max(1);
    let batch = (limit + 1).max(50);
    let max_rows = limit + 1 + MAX_EVENT_ROWS_PER_PAGE;

    if let Some(after) = after_order {
        let mut rows: Vec<Message> = Vec::new();
        let mut cursor = after;
        let mut timeline = 0usize;
        let mut exhausted;
        'outer: loop {
            let chunk = storage
                .get_messages_by_group(group_id, Some(cursor), before_order, batch)
                .await?;
            exhausted = chunk.len() < batch;
            for m in chunk {
                cursor = order_of(&m);
                if !is_event(&m) {
                    timeline += 1;
                    if timeline > limit {
                        // The first row of the next page: stop before it.
                        return Ok((rows, true));
                    }
                }
                rows.push(m);
                if rows.len() >= max_rows {
                    break 'outer;
                }
            }
            if exhausted {
                break;
            }
        }
        let capped = rows.len() >= max_rows && !exhausted;
        return Ok((rows, capped));
    }

    // Backward: walk from the tip (or `before_order`) toward older rows.
    let mut newest_first: Vec<Message> = Vec::new();
    let mut cursor = before_order;
    let mut timeline = 0usize;
    let mut exhausted;
    'outer: loop {
        let chunk = storage
            .get_messages_by_group(group_id, None, cursor, batch)
            .await?;
        exhausted = chunk.len() < batch;
        for m in chunk.into_iter().rev() {
            cursor = Some(order_of(&m));
            if !is_event(&m) {
                timeline += 1;
                if timeline > limit {
                    newest_first.reverse();
                    return Ok((newest_first, true));
                }
            }
            newest_first.push(m);
            if newest_first.len() >= max_rows {
                break 'outer;
            }
        }
        if exhausted {
            break;
        }
    }
    // Reached only at the start of history (exhausted) or at the event cap.
    let capped = newest_first.len() >= max_rows && !exhausted;
    newest_first.reverse();
    Ok((newest_first, capped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MessageKind;
    use crate::storage::memory::InMemoryStorage;

    async fn seed(storage: &InMemoryStorage, kinds: &[MessageKind]) {
        for (i, kind) in kinds.iter().enumerate() {
            let mut nonce = vec![0u8; 12];
            nonce[0] = i as u8;
            let mut m = Message::new(
                "0xgroup".to_string(),
                "0xsender".to_string(),
                vec![1],
                nonce,
                0,
                vec![],
                vec![0; 64],
                vec![0; 33],
            );
            m.kind = *kind;
            storage.create_message(m).await.unwrap();
        }
    }

    fn kinds(rows: &[Message]) -> Vec<(i64, bool)> {
        rows.iter().map(|m| (order_of(m), is_event(m))).collect()
    }

    #[tokio::test]
    async fn events_do_not_consume_the_page_limit() {
        let storage = InMemoryStorage::new();
        use MessageKind::{Event as E, Message as M};
        // orders 1..=8: M M E E E M E E
        seed(&storage, &[M, M, E, E, E, M, E, E]).await;

        let (page, has_next) = fetch_page(&storage, "0xgroup", None, None, 2).await.unwrap();
        // Newest two messages (2, 6) plus every event newer than message 2.
        assert_eq!(
            kinds(&page),
            vec![(2, false), (3, true), (4, true), (5, true), (6, false), (7, true), (8, true)]
        );
        assert!(has_next);

        let (older, has_next) = fetch_page(&storage, "0xgroup", None, Some(2), 2).await.unwrap();
        assert_eq!(kinds(&older), vec![(1, false)]);
        assert!(!has_next);
    }

    #[tokio::test]
    async fn forward_paging_stops_before_the_next_timeline_row() {
        let storage = InMemoryStorage::new();
        use MessageKind::{Event as E, Message as M};
        seed(&storage, &[M, E, M, E, M]).await;
        let (page, has_next) = fetch_page(&storage, "0xgroup", Some(0), None, 2).await.unwrap();
        assert_eq!(kinds(&page), vec![(1, false), (2, true), (3, false), (4, true)]);
        assert!(has_next);
    }
}
