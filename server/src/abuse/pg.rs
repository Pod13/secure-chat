//! PostgreSQL storage for rate-limit counters (the `abuse_counters` table).

use super::limits::{Bucket, LimitStore, StoreError};
use sqlx::PgPool;

pub struct PgLimitStore {
    pool: PgPool,
}

impl PgLimitStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

impl LimitStore for PgLimitStore {
    async fn hit(&self, bucket: &Bucket, window_start: u64) -> Result<u32, StoreError> {
        let start = i64::try_from(window_start).map_err(|_| StoreError)?;
        let hits: i32 = sqlx::query_scalar(
            "INSERT INTO abuse_counters (bucket, window_start, hits) \
             VALUES ($1, to_timestamp($2::bigint), 1) \
             ON CONFLICT (bucket, window_start) DO UPDATE SET hits = abuse_counters.hits + 1 \
             RETURNING hits",
        )
        .bind(bucket.as_str())
        .bind(start)
        .fetch_one(&self.pool)
        .await
        .map_err(|_| StoreError)?;
        u32::try_from(hits).map_err(|_| StoreError)
    }

    async fn purge_before(&self, before: u64) -> Result<u64, StoreError> {
        let before = i64::try_from(before).map_err(|_| StoreError)?;
        sqlx::query("DELETE FROM abuse_counters WHERE window_start < to_timestamp($1::bigint)")
            .bind(before)
            .execute(&self.pool)
            .await
            .map(|done| done.rows_affected())
            .map_err(|_| StoreError)
    }
}
