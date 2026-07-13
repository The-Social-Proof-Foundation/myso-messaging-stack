//! HTTP server bootstrap and route wiring.

use std::sync::Arc;

use axum::{
    middleware,
    routing::{delete, get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::auth::{
    auth_middleware, create_membership_store_async, internal_sync_middleware, wallet_auth_middleware,
    AuthState, InternalSyncState,
};
use crate::config::Config;
use crate::file_storage::FileStorageClient;
use crate::handlers::agent_groups;
use crate::handlers::dm_gate;
use crate::handlers::group_features;
use crate::handlers::health::health_check;
use crate::handlers::messages::{create_message, delete_message, get_messages, update_message};
use crate::handlers::presence::post_presence;
use crate::handlers::push_devices::{delete_push_token, post_push_token};
use crate::handlers::unread_counts::post_unread_counts;
use crate::handlers::user_read_state::{get_read_state, put_read_state};
use crate::handlers::user_ws::user_ws_handler;
use crate::handlers::workflow::{
    ack_workflow_item, dismiss_workflow_item, ingest_workflow_item_internal, list_workflow_items,
    workflow_badge,
};
use crate::handlers::ws::ws_handler;
use crate::services::{
    AttributionVerifyService, BlockCheckService, FileStorageSyncService, MembershipSyncService,
    MessageGateService, PgListenerService, PushService, RealtimeHub,
    bootstrap_messaging_config_cache, fallback_messaging_config_cache,
};
use crate::state::AppState;
use crate::storage::{create_agent_group_store_async, create_storage_async, create_workflow_store_async};

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt::init();

    let config = Config::from_env();

    let storage = create_storage_async(config.storage_type.clone()).await;

    let file_storage_client = Arc::new(FileStorageClient::new(
        &config.file_storage_publisher_url,
        &config.file_storage_aggregator_url,
    ));

    let (sync_tx, sync_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let database_url = std::env::var("DATABASE_URL").ok();
    let membership_store =
        create_membership_store_async(config.membership_store_type.clone(), database_url.as_deref())
            .await;
    let agent_group_store = create_agent_group_store_async(
        config.membership_store_type.clone(),
        database_url.as_deref(),
    )
    .await;
    let workflow_store = create_workflow_store_async(
        config.membership_store_type.clone(),
        database_url.as_deref(),
        config.workflow_enabled,
    )
    .await;
    let block_check = BlockCheckService::from_config(&config);
    let message_gate = MessageGateService::from_config(&config);
    let messaging_config = match bootstrap_messaging_config_cache(&config).await {
        Ok(cache) => cache,
        Err(e) => {
            tracing::warn!("Failed to bootstrap MessagingConfig: {e}; using defaults");
            fallback_messaging_config_cache()
        }
    };
    let push_service = PushService::from_config(&config);
    let realtime_hub = Arc::new(RealtimeHub::from_config(&config));

    let app_state = AppState::new(
        storage.clone(),
        sync_tx,
        membership_store.clone(),
        agent_group_store.clone(),
        workflow_store.clone(),
        config.workflow_enabled,
        AttributionVerifyService::from_config(&config),
        block_check,
        message_gate.clone(),
        messaging_config.clone(),
        push_service,
        realtime_hub.clone(),
        config.realtime_enabled,
        config.inline_realtime_publish(),
        config.ws_ping_interval_secs,
        config.request_ttl_seconds,
    );

    if config.realtime_enabled && config.uses_postgres_storage() {
        if let Some(database_url) = config.postgres_database_url() {
            let listener = PgListenerService::new(
                database_url,
                storage.clone(),
                realtime_hub.clone(),
                membership_store.clone(),
            );
            tokio::spawn(async move {
                listener.run().await;
            });
        }
    }

    let sync_push_service = PushService::from_config(&config);
    let mut sync_service = MembershipSyncService::new(
        &config,
        membership_store.clone(),
        agent_group_store.clone(),
        workflow_store.clone(),
        config.workflow_enabled,
        storage.clone(),
        message_gate,
        messaging_config,
        realtime_hub,
        sync_push_service,
    );
    tokio::spawn(async move {
        sync_service.run().await;
    });

    let mut file_storage_sync_service =
        FileStorageSyncService::new(&config, storage, file_storage_client, sync_rx);
    tokio::spawn(async move {
        file_storage_sync_service.run().await;
    });

    if config.workflow_enabled {
        let sweep_store = workflow_store.clone();
        let sweep_interval_secs = config.workflow_expiry_sweep_interval_secs;
        let sweep_max = config.workflow_expiry_sweep_max_rows;
        tokio::spawn(async move {
            crate::services::workflow_expiry::run_expiry_sweep(
                sweep_store,
                sweep_interval_secs,
                sweep_max,
            )
            .await;
        });
    }

    let auth_state = AuthState {
        membership_store,
        config: config.clone(),
    };

    let message_routes = Router::new()
        .route(
            "/messages",
            get(get_messages).post(create_message).put(update_message),
        )
        .route("/messages/:message_id", delete(delete_message));

    let v1_group_routes = Router::new()
        .route(
            "/groups/:group_id/reactions",
            get(group_features::list_reactions).post(group_features::post_reaction),
        )
        .route(
            "/groups/:group_id/pins",
            get(group_features::list_pins).post(group_features::set_pin),
        )
        .route(
            "/groups/:group_id/receipts",
            get(group_features::get_receipts).post(group_features::post_receipts),
        )
        .route(
            "/groups/:group_id/typing",
            post(group_features::post_typing),
        )
        .route(
            "/groups/:group_id/presence",
            get(group_features::get_group_presence),
        );

    let v1_wallet_routes = Router::new()
        .route("/users/read-state", get(get_read_state).put(put_read_state))
        .route("/users/unread-counts", post(post_unread_counts))
        .route("/devices/push-tokens", post(post_push_token))
        .route("/devices/push-tokens/:token", delete(delete_push_token))
        .route("/devices/presence", post(post_presence))
        .route("/messaging/dm-gate", get(dm_gate::get_dm_gate))
        .route(
            "/agent-conversations",
            get(agent_groups::list_agent_conversations),
        )
        .route(
            "/agent-conversations/by-agent/:derived_address",
            get(agent_groups::list_groups_for_agent),
        )
        .route("/workflow/items", get(list_workflow_items))
        .route("/workflow/items/:id/ack", post(ack_workflow_item))
        .route("/workflow/items/:id/dismiss", post(dismiss_workflow_item))
        .route("/workflow/badge", get(workflow_badge));

    let realtime_routes = Router::new()
        .route("/ws", get(ws_handler))
        .route("/users/ws", get(user_ws_handler))
        .with_state(app_state.clone());

    let wallet_auth_state = auth_state.clone();
    let wallet_authenticated_routes = Router::new()
        .nest("/v1", v1_wallet_routes)
        .layer(middleware::from_fn_with_state(
            wallet_auth_state,
            wallet_auth_middleware,
        ))
        .with_state(app_state.clone());

    let group_authenticated_routes = Router::new()
        .merge(message_routes.clone())
        .nest("/v1", message_routes.clone().merge(v1_group_routes))
        .layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth_middleware,
        ))
        .with_state(app_state.clone());

    let authenticated_routes = group_authenticated_routes
        .merge(wallet_authenticated_routes)
        .nest("/v1", realtime_routes);

    let public_routes = Router::new()
        .route("/health_check", get(health_check))
        .with_state(app_state.clone());

    let internal_routes = Router::new()
        .route("/internal/workflow/items", post(ingest_workflow_item_internal))
        .layer(middleware::from_fn_with_state(
            InternalSyncState {
                config: config.clone(),
            },
            internal_sync_middleware,
        ))
        .with_state(app_state.clone());

    // WARNING: This permissive CORS configuration is for development/demo purposes only.
    // In production, restrict allow_origin to specific trusted domains.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(public_routes)
        .merge(internal_routes)
        .merge(authenticated_routes)
        .layer(cors);

    let addr = format!("0.0.0.0:{}", config.port);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind to {}: {}", addr, e))?;

    info!(
        "Messaging Relayer listening on {}",
        listener.local_addr()?
    );

    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}
