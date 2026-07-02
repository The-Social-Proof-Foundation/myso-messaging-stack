//! WebSocket subscription for realtime encrypted message delivery.

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

use crate::auth::ws_auth::{authenticate_ws_upgrade, WsAuthQuery};
use crate::services::realtime::RealtimeEvent;
use crate::state::AppState;

pub async fn ws_handler(
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

    let auth = authenticate_ws_upgrade(
        &headers,
        &query,
        state.membership_store.as_ref(),
        state.request_ttl_seconds,
    )?;

    let group_id = auth
        .authorized_group
        .clone()
        .expect("ws auth sets authorized_group");
    let after_order = query.after_order.unwrap_or(0);
    let sender = auth.sender_address.clone();
    let ping_interval = Duration::from_secs(state.ws_ping_interval_secs);

    Ok(ws.on_upgrade(move |socket| handle_socket(
        socket,
        state,
        group_id,
        sender,
        after_order,
        ping_interval,
    )))
}

async fn handle_socket(
    socket: WebSocket,
    state: AppState,
    group_id: String,
    sender: String,
    mut after_order: i64,
    ping_interval: Duration,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut hub_rx = state.realtime_hub.subscribe(&group_id);
    let mut ping_tick = tokio::time::interval(ping_interval);

    if let Err(err) = state.storage.update_presence(&sender).await {
        warn!("ws presence update failed for {}: {}", sender, err);
    }

    loop {
        tokio::select! {
            event = hub_rx.recv() => {
                match event {
                    Ok(event) => {
                        // Messages are deduplicated by order; reaction events carry
                        // absolute state and are forwarded as-is.
                        if let RealtimeEvent::MessageCreated(ref wire) = event {
                            if wire.message.order <= after_order {
                                continue;
                            }
                            after_order = wire.message.order;
                        }
                        match serde_json::to_string(&event) {
                            Ok(json) => {
                                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(err) => warn!("ws serialize failed: {}", err),
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        debug!("ws client lagged, skipped {} events", skipped);
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
                                let _ = state.storage.update_presence(&sender).await;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = ws_tx.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(err)) => {
                        debug!("ws read error: {}", err);
                        break;
                    }
                    _ => {}
                }
            }
            _ = ping_tick.tick() => {
                let _ = state.storage.update_presence(&sender).await;
            }
        }
    }

    debug!("ws disconnected for {} in group {}", sender, group_id);
}
