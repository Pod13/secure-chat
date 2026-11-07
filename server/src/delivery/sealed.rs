//! Delivery tokens (sealed sender). A token is a random secret that lets whoever holds it queue
//! one envelope for one Device, without logging in. The sender is never named: the server sees a
//! token and a ciphertext. Blocking a Contact revokes the token that Contact was given.
//! Only the token's hash is stored.

use crate::accounts::{DeviceId, Hash, StoreError, sha256, short_id};
use crate::ports::Random;
use sqlx::{PgConnection, PgPool};

/// Most live delivery tokens one Device may have handed out.
pub const MAX_PER_DEVICE: i64 = 5000;

#[derive(Debug, PartialEq, Eq)]
pub enum MintError {
    TooMany,
    Store,
}

impl From<sqlx::Error> for MintError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}

pub struct Minted {
    /// The secret. Shared only inside encrypted messages or an Invite redemption.
    pub token: [u8; 32],
    pub id: [u8; 16],
}

/// Makes a new token for the Device, inside the caller's transaction or connection.
pub async fn mint(
    conn: &mut PgConnection,
    random: &impl Random,
    device: &DeviceId,
) -> Result<Minted, MintError> {
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM delivery_tokens WHERE device_id = $1 AND NOT revoked",
    )
    .bind(device.as_slice())
    .fetch_one(&mut *conn)
    .await?;
    if live >= MAX_PER_DEVICE {
        return Err(MintError::TooMany);
    }
    let mut token = [0u8; 32];
    random.fill(&mut token);
    let hash = sha256(&token);
    sqlx::query("INSERT INTO delivery_tokens (token_hash, device_id) VALUES ($1, $2)")
        .bind(hash.as_slice())
        .bind(device.as_slice())
        .execute(conn)
        .await?;
    Ok(Minted {
        token,
        id: short_id(&hash),
    })
}

/// Revokes one of the Device's own tokens. `false` if it has no such token.
pub async fn revoke(pool: &PgPool, device: &DeviceId, id: &[u8; 16]) -> Result<bool, StoreError> {
    let done = sqlx::query(
        "UPDATE delivery_tokens SET revoked = true WHERE device_id = $1 AND substring(token_hash from 1 for 16) = $2",
    )
    .bind(device.as_slice())
    .bind(id.as_slice())
    .execute(pool)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// The Device a live token delivers to.
pub async fn recipient_of(
    pool: &PgPool,
    token_hash: &Hash,
) -> Result<Option<DeviceId>, StoreError> {
    let row: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT device_id FROM delivery_tokens WHERE token_hash = $1 AND NOT revoked",
    )
    .bind(token_hash.as_slice())
    .fetch_optional(pool)
    .await?;
    row.map(|id| id.try_into().map_err(|_| StoreError))
        .transpose()
}
