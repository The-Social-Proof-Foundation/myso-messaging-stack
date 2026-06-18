//! Integration tests for Postgres schema migrations.
//! Run with: DATABASE_URL=postgres://... cargo test --test migrations_postgres_test -- --ignored

use messaging_relayer::storage::{create_postgres_storage, migrations};
use sqlx::postgres::PgPoolOptions;

#[tokio::test]
#[ignore = "requires DATABASE_URL pointing at a test Postgres database"]
async fn postgres_migrations_apply_all_versions() {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL required");

    let _storage = create_postgres_storage(&database_url).await.unwrap();

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .unwrap();

    migrations::run_migrations(&pool).await.unwrap();

    let versions: Vec<i32> =
        sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(versions, vec![1, 2, 3, 4]);

    let messages_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'messages'
        )",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(messages_exists);

    let membership_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'membership_permissions'
        )",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(membership_exists);
}
