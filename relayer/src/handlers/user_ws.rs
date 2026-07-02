//! Wallet-scoped user feed — `GET /v1/users/ws`.
//!
//! One socket per wallet carries all user-scoped synchronization events:
//! `group.activity` (a message landed in one of your groups),
//! `read_state.updated` (your read-state blob changed on another device), and
//! `group.discovered` / `group.hidden` (a conversation appeared or left).
//! Frames are metadata only — clients re-fetch canonical state over REST.
//!
//! Events are broadcast on a single global hub channel and filtered per
//! connection via [`UserFeedEvent::matches_wallet`].

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tracing::{debug, warn};

use crate::auth::ws_auth::{authenticate_user_ws_upgrade, WsAuthQuery};
use crate::services::presence_sync;
use crate::state::AppState;

pub async fn user_ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsAuthQuery>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, axum::response::Response> {
    if !state.realtime_enabled {
        return Err((
            axum::http::StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "error": "Realtime disabled" })),
        )
            .into_response());
    }

    let auth = authenticate_user_ws_upgrade(&headers, &query, state.request_ttl_seconds)?;
    let wallet = auth.sender_address.clone();
    let ping_interval = Duration::from_secs(state.ws_ping_interval_secs);

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state, wallet, ping_interval)))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    wallet: String,
    ping_interval: Duration,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut feed_rx = state.realtime_hub.subscribe_user_feed();
    let mut ping_tick = tokio::time::interval(ping_interval);

    if let Err(err) = state.storage.update_presence(&wallet).await {
        warn!("user ws presence update failed for {}: {}", wallet, err);
    }
    presence_sync::note_connect(&state, &wallet).await;

    loop {
        tokio::select! {
            event = feed_rx.recv() => {
                match event {
                    Ok(event) => {
                        if !event.matches_wallet(&wallet, state.membership_store.as_ref()) {
                            continue;
                        }
                        match serde_json::to_string(&event.wire_frame()) {
                            Ok(json) => {
                                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(err) => warn!("user ws serialize failed: {}", err),
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        debug!("user ws client lagged, skipped {} events", skipped);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if value.get("type").and_then(|v| v.as_str()) == Some("ping") {
                                let _ = ws_tx.send(Message::Text(
                                    r#"{"type":"pong"}"#.into(),
                                )).await;
                                let _ = state.storage.update_presence(&wallet).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => {
                        debug!("user ws read error: {}", err);
                        break;
                    }
                    _ => {}
                }
            }
            _ = ping_tick.tick() => {
                let _ = state.storage.update_presence(&wallet).await;
            }
        }
    }

    debug!("user ws disconnected for {}", wallet);
    presence_sync::note_disconnect(state, wallet);
}
