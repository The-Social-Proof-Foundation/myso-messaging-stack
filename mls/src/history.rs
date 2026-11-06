//! History bundles (E2EE M5): how one device hands chat history to another over MLS.
//!
//! A bundle is opaque bytes (clients define the row format; see E2EE-Protocol-MLS.md). It is split
//! into chunks that each fit one MLS application message, sent in the sender's self-group (own
//! devices) or, for "share recent history", in the chat group. Chunks carry a random bundle id, so
//! receivers reassemble regardless of order and ignore duplicates.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Max payload bytes per chunk (well under MLS / relayer message limits).
pub const CHUNK_BYTES: usize = 48 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryChunk {
    /// Marks the application message as a history chunk.
    pub t: String,
    pub bundle: String,
    pub index: u32,
    pub total: u32,
    /// Hex payload slice.
    pub data: String,
}

pub const CHUNK_TYPE: &str = "myso-history-v1";

pub fn split(bundle_id: &str, payload: &[u8]) -> Vec<Vec<u8>> {
    let parts: Vec<&[u8]> = if payload.is_empty() { vec![&[][..]] } else { payload.chunks(CHUNK_BYTES).collect() };
    let total = parts.len() as u32;
    parts
        .into_iter()
        .enumerate()
        .map(|(i, part)| {
            serde_json::to_vec(&HistoryChunk {
                t: CHUNK_TYPE.into(),
                bundle: bundle_id.into(),
                index: i as u32,
                total,
                data: hex::encode(part),
            })
            .expect("chunk serializes")
        })
        .collect()
}

pub fn parse_chunk(bytes: &[u8]) -> Option<HistoryChunk> {
    let chunk: HistoryChunk = serde_json::from_slice(bytes).ok()?;
    (chunk.t == CHUNK_TYPE && chunk.index < chunk.total && chunk.total > 0).then_some(chunk)
}

/// Collects chunks; yields each bundle once complete.
#[derive(Default)]
pub struct Reassembler {
    pending: BTreeMap<String, (u32, BTreeMap<u32, Vec<u8>>)>,
}

impl Reassembler {
    pub fn push(&mut self, chunk: HistoryChunk) -> Option<(String, Vec<u8>)> {
        let data = hex::decode(&chunk.data).ok()?;
        let entry = self.pending.entry(chunk.bundle.clone()).or_insert((chunk.total, BTreeMap::new()));
        if entry.0 != chunk.total {
            return None;
        }
        entry.1.insert(chunk.index, data);
        if entry.1.len() as u32 != entry.0 {
            return None;
        }
        let (_, parts) = self.pending.remove(&chunk.bundle)?;
        Some((chunk.bundle, parts.into_values().flatten().collect()))
    }
}
