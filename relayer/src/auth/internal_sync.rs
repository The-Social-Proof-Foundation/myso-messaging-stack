//! Service-secret middleware for internal ingest routes.

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};

use crate::config::Config;

const INTERNAL_SYNC_HEADER: &str = "x-internal-sync-secret";

#[derive(Clone)]
pub struct InternalSyncState {
    pub config: Config,
}

pub async fn internal_sync_middleware(
    State(state): State<InternalSyncState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let Some(expected) = state.config.internal_sync_secret.as_deref() else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let provided = headers
        .get(INTERNAL_SYNC_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != expected {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}
