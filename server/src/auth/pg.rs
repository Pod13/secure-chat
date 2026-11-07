//! PostgreSQL storage for Device authentication (`devices`, `auth_nonces`, `sessions`).

use super::{AuthStore, DeviceId, Hash, StoreError};
use sqlx::PgPool;

pub struct PgAuthStore {
    pool: PgPool,
}

impl PgAuthStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn to_hash(bytes: Vec<u8>) -> Result<Hash, StoreError> {
    bytes.try_into().map_err(|_| StoreError)
}

fn to_secs(seconds: f64) -> u64 {
    // Whole seconds are enough; rounding up never lets an expired value look valid.
    seconds.ceil().max(0.0) as u64
}

fn signed(secs: u64) -> Result<i64, StoreError> {
    i64::try_from(secs).map_err(|_| StoreError)
}

impl AuthStore for PgAuthStore {
    async fn device_key(&self, device: &DeviceId) -> Result<Option<Hash>, StoreError> {
        let row: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT device_public_key FROM devices WHERE device_id = $1")
                .bind(device.as_slice())
                .fetch_optional(&self.pool)
                .await
                .map_err(|_| StoreError)?;
        row.map(to_hash).transpose()
    }

    async fn put_nonce(
        &self,
        device: &DeviceId,
        nonce: Hash,
        expires_at: u64,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO auth_nonces (device_id, nonce, expires_at) VALUES ($1, $2, to_timestamp($3::bigint)) \
             ON CONFLICT (device_id) DO UPDATE SET nonce = $2, expires_at = to_timestamp($3::bigint)",
        )
        .bind(device.as_slice())
        .bind(nonce.as_slice())
        .bind(signed(expires_at)?)
        .execute(&self.pool)
        .await
        .map(|_| ())
        .map_err(|_| StoreError)
    }

    async fn take_nonce(&self, device: &DeviceId) -> Result<Option<(Hash, u64)>, StoreError> {
        let row: Option<(Vec<u8>, f64)> = sqlx::query_as(
            "DELETE FROM auth_nonces WHERE device_id = $1 RETURNING nonce, extract(epoch from expires_at)::float8",
        )
        .bind(device.as_slice())
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError)?;
        row.map(|(nonce, expires)| Ok((to_hash(nonce)?, to_secs(expires))))
            .transpose()
    }

    async fn put_session(
        &self,
        token_hash: Hash,
        device: DeviceId,
        expires_at: u64,
    ) -> Result<(), StoreError> {
        sqlx::query("INSERT INTO sessions (token_hash, device_id, expires_at) VALUES ($1, $2, to_timestamp($3::bigint))")
            .bind(token_hash.as_slice())
            .bind(device.as_slice())
            .bind(signed(expires_at)?)
            .execute(&self.pool)
            .await
            .map(|_| ())
            .map_err(|_| StoreError)
    }

    async fn session(&self, token_hash: &Hash) -> Result<Option<(DeviceId, u64)>, StoreError> {
        let row: Option<(Vec<u8>, f64)> = sqlx::query_as(
            "SELECT device_id, extract(epoch from expires_at)::float8 FROM sessions WHERE token_hash = $1",
        )
        .bind(token_hash.as_slice())
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError)?;
        row.map(|(device, expires)| {
            Ok((device.try_into().map_err(|_| StoreError)?, to_secs(expires)))
        })
        .transpose()
    }

    async fn delete_device_sessions(&self, device: &DeviceId) -> Result<(), StoreError> {
        for statement in [
            "DELETE FROM sessions WHERE device_id = $1",
            "DELETE FROM auth_nonces WHERE device_id = $1",
        ] {
            sqlx::query(statement)
                .bind(device.as_slice())
                .execute(&self.pool)
                .await
                .map_err(|_| StoreError)?;
        }
        Ok(())
    }
}
