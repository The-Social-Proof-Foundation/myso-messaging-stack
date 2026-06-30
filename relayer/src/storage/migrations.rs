//! Versioned SQL migrations applied at Postgres connect time.

use sqlx::PgPool;
use tracing::info;

use super::adapter::{StorageError, StorageResult};

const MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("../../migrations/001_initial.sql")),
    (2, include_str!("../../migrations/002_membership.sql")),
    (3, include_str!("../../migrations/003_group_features.sql")),
    (4, include_str!("../../migrations/004_message_nonce_index.sql")),
    (5, include_str!("../../migrations/005_message_attribution.sql")),
    (6, include_str!("../../migrations/006_agent_messaging_groups.sql")),
];

/// Strip line comments, then split into individual SQL statements.
///
/// Prepared statements only accept one command per execute. Comment lines must
/// be removed before splitting on `;` so semicolons inside comments do not
/// fragment statements (e.g. migration v3 header comment).
fn split_sql_statements(sql: &str) -> Vec<String> {
    let without_comments = sql
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join("\n");

    without_comments
        .split(';')
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .map(str::to_string)
        .collect()
}

/// Applies pending migrations tracked in `schema_migrations`.
pub async fn run_migrations(pool: &PgPool) -> StorageResult<()> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS schema_migrations (
            version INT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"#,
    )
    .execute(pool)
    .await
    .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

    for (version, sql) in MIGRATIONS {
        let applied: Option<i32> = sqlx::query_scalar(
            "SELECT version FROM schema_migrations WHERE version = $1",
        )
        .bind(version)
        .fetch_optional(pool)
        .await
        .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        if applied.is_some() {
            continue;
        }

        info!("Applying database migration v{}", version);

        let mut tx = pool
            .begin()
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        for statement in split_sql_statements(sql) {
            sqlx::query(&statement)
                .execute(&mut *tx)
                .await
                .map_err(|e| {
                    StorageError::OperationFailed(format!("migration v{}: {}", version, e))
                })?;
        }

        sqlx::query("INSERT INTO schema_migrations (version) VALUES ($1)")
            .bind(version)
            .execute(&mut *tx)
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;

        tx.commit()
            .await
            .map_err(|e| StorageError::OperationFailed(e.to_string()))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::split_sql_statements;

    #[test]
    fn split_initial_migration_into_five_statements() {
        let statements = split_sql_statements(include_str!("../../migrations/001_initial.sql"));
        assert_eq!(statements.len(), 5);
        assert!(statements[0].starts_with("CREATE TABLE IF NOT EXISTS messages"));
        assert!(statements[1].contains("idx_messages_group_order"));
    }
}
