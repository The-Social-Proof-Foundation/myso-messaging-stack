//! MLS end-to-end test server: the production router (`server::build_router`) over in-memory
//! storage, with group membership seeded from the environment instead of the chain. Used by the
//! SDK's real-relayer MLS integration test (`test/integration/mls-relayer.test.ts`). Not for
//! deployment: membership is whatever the test says it is.
//!
//! Env:
//! - `MLS_E2E_PORT` (default 0 = pick a free port)
//! - `MLS_E2E_MEMBERS`: `group=addr,addr;group2=addr` (sender + reader permissions)
//!
//! Prints `MLS_E2E_READY <port>` on stdout once listening. Membership can be changed at runtime
//! with `POST /__test/members` `{ "group": "0x…", "add": ["0x…"], "remove": ["0x…"] }`.

use std::sync::Arc;

use axum::{routing::post, Json, Router};
use messaging_relayer::{
    auth::{AuthState, InMemoryMembershipStore, MembershipStore, MessagingPermission},
    config::Config,
    server::build_router,
    services::{block_check::BlockCheckService, push::PushService},
    state::AppState,
    storage::{create_storage, StorageType},
};
use serde::Deserialize;

#[derive(Deserialize)]
struct MemberChange {
    group: String,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

fn permissions() -> Vec<MessagingPermission> {
    vec![MessagingPermission::MessagingSender, MessagingPermission::MessagingReader]
}

#[tokio::main]
async fn main() {
    let membership = Arc::new(InMemoryMembershipStore::new());
    for spec in std::env::var("MLS_E2E_MEMBERS").unwrap_or_default().split(';').filter(|s| !s.is_empty()) {
        let (group, members) = spec.split_once('=').expect("group=addr,addr");
        for m in members.split(',').filter(|s| !s.is_empty()) {
            membership.add_member(&group.to_lowercase(), &m.to_lowercase(), permissions());
        }
    }
    let store = membership.clone() as Arc<dyn MembershipStore>;
    let config = Config::default();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let state = AppState::new_for_tests(
        create_storage(StorageType::InMemory),
        tx,
        store.clone(),
        BlockCheckService::from_config(&config),
        PushService::from_config(&config),
    );
    let auth = AuthState { membership_store: store, config: config.clone() };

    let control = {
        let membership = membership.clone();
        Router::new().route(
            "/__test/members",
            post(move |Json(change): Json<MemberChange>| {
                let membership = membership.clone();
                async move {
                    let group = change.group.to_lowercase();
                    for m in change.add {
                        membership.add_member(&group, &m.to_lowercase(), permissions());
                    }
                    for m in change.remove {
                        membership.remove_member(&group, &m.to_lowercase());
                    }
                    Json(serde_json::json!({ "ok": true }))
                }
            }),
        )
    };
    let app = build_router(state, auth, &config).merge(control);

    let port: u16 = std::env::var("MLS_E2E_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    println!("MLS_E2E_READY {}", listener.local_addr().unwrap().port());
    axum::serve(listener, app.into_make_service()).await.unwrap();
}
