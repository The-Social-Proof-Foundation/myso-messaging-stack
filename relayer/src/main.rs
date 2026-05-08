mod auth;
mod config;
mod handlers;
mod models;
mod services;
mod state;
mod storage;
mod file_storage;

use std::sync::Arc;

use axum::{
    middleware,
    routing::{delete, get},
    Router,
};
use config::Config;
use handlers::group_features;
use handlers::health::health_check;
use handlers::messages::{create_message, delete_message, get_messages, update_message};
use state::AppState;
use storage::create_storage;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

// Import auth middleware components
use auth::{auth_middleware, create_membership_store, AuthState};

// Import background services
use services::{MembershipSyncService, FileStorageSyncService};

// Import File Storage client
use file_storage::FileStorageClient;

#[tokio::main]
async fn main() {
    // Load .env file if it exists (before reading config)
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt::init();

    // Load configuration from environment
    let config = Config::from_env();

    // Initialize storage backend based on STORAGE_TYPE env var
    let storage = create_storage(config.storage_type.clone());

    // Create the shared File Storage HTTP client from config URLs
    let file_storage_client = Arc::new(FileStorageClient::new(
        &config.file_storage_publisher_url,
        &config.file_storage_aggregator_url,
    ));

    let (sync_tx, sync_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    let app_state = AppState::new(storage.clone(), config.clone(), sync_tx);

    // Initialize membership store (shared between auth middleware and sync service)
    let membership_store = create_membership_store(config.membership_store_type.clone());

    // Start the membership sync service (runs in background, updates cache from MySo events)
    let mut sync_service = MembershipSyncService::new(&config, membership_store.clone());
    tokio::spawn(async move {
        sync_service.run().await;
    });

    // Start the File Storage sync service (runs in background, uploads pending messages)
    let mut file_storage_sync_service = FileStorageSyncService::new(&config, storage, file_storage_client, sync_rx);
    tokio::spawn(async move {
        file_storage_sync_service.run().await;
    });

    // Create auth state for middleware
    let auth_state = AuthState {
        membership_store,
        config: config.clone(),
    };

    // Routes that require authentication (GET, POST, PUT, DELETE)
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
        );

    let authenticated_routes = Router::new()
        .merge(message_routes.clone())
        .nest("/v1", message_routes.clone().merge(v1_group_routes))
        .layer(middleware::from_fn_with_state(auth_state, auth_middleware))
        .with_state(app_state.clone());

    // Routes that don't require authentication (health check only)
    let public_routes = Router::new()
        .route("/health_check", get(health_check))
        .with_state(app_state);

    // WARNING: This permissive CORS configuration is for development/demo purposes only.
    // In production, restrict allow_origin to specific trusted domains.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Combine all routes
    let app = Router::new()
        .merge(public_routes)
        .merge(authenticated_routes)
        .layer(cors);

    let addr = format!("0.0.0.0:{}", config.port);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|_| panic!("Failed to bind to {}", addr));

    info!(
        "Messaging Relayer listening on {}",
        listener.local_addr().unwrap()
    );

    axum::serve(listener, app.into_make_service())
        .await
        .expect("Server error");
}
