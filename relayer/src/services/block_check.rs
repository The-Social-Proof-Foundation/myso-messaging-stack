//! Block check service — queries myso-social-server for bidirectional profile blocks.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use reqwest::Client;
use tracing::{debug, warn};

use crate::config::Config;

#[derive(Debug, Clone)]
struct CacheEntry {
    blocked: bool,
    inserted_at: Instant,
}

fn canonical_pair(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Checks whether either wallet blocked the other via social-server HTTP + local LRU cache.
#[derive(Clone)]
pub struct BlockCheckService {
    enabled: bool,
    base_url: Option<String>,
    client: Client,
    cache_ttl: Duration,
    cache_max_entries: usize,
    cache: Arc<RwLock<HashMap<(String, String), CacheEntry>>>,
}

impl BlockCheckService {
    pub fn from_config(config: &Config) -> Self {
        Self {
            enabled: config.block_check_enabled,
            base_url: config.social_server_url.clone(),
            client: Client::new(),
            cache_ttl: Duration::from_secs(config.block_cache_ttl_secs),
            cache_max_entries: config.block_cache_max_entries,
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled && self.base_url.is_some()
    }

    /// Returns true if either party blocked the other.
    pub async fn check_either_blocked(&self, a: &str, b: &str) -> Result<bool, BlockCheckError> {
        if !self.is_enabled() {
            return Ok(false);
        }

        let key = canonical_pair(a, b);
        if let Some(blocked) = self.read_cache(&key) {
            debug!("block cache hit for ({}, {}) -> {}", key.0, key.1, blocked);
            return Ok(blocked);
        }

        let base = self
            .base_url
            .as_ref()
            .ok_or(BlockCheckError::NotConfigured)?;
        let url = format!(
            "{}/blocklist/check/either/{}/{}",
            base.trim_end_matches('/'),
            key.0,
            key.1,
        );

        let response = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| BlockCheckError::Http(e.to_string()))?;

        if !response.status().is_success() {
            return Err(BlockCheckError::Http(format!(
                "social server returned {}",
                response.status()
            )));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| BlockCheckError::Http(e.to_string()))?;

        let blocked = body
            .get("blocked")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| BlockCheckError::InvalidResponse("missing blocked field".into()))?;

        self.write_cache(key, blocked);
        Ok(blocked)
    }

    fn read_cache(&self, key: &(String, String)) -> Option<bool> {
        let cache = self.cache.read().ok()?;
        let entry = cache.get(key)?;
        if entry.inserted_at.elapsed() > self.cache_ttl {
            return None;
        }
        Some(entry.blocked)
    }

    fn write_cache(&self, key: (String, String), blocked: bool) {
        let Ok(mut cache) = self.cache.write() else {
            warn!("block cache lock poisoned");
            return;
        };
        if cache.len() >= self.cache_max_entries {
            cache.retain(|_, entry| entry.inserted_at.elapsed() <= self.cache_ttl);
            if cache.len() >= self.cache_max_entries {
                cache.clear();
            }
        }
        cache.insert(
            key,
            CacheEntry {
                blocked,
                inserted_at: Instant::now(),
            },
        );
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BlockCheckError {
    #[error("block check not configured")]
    NotConfigured,
    #[error("block check HTTP error: {0}")]
    Http(String),
    #[error("invalid block check response: {0}")]
    InvalidResponse(String),
}
