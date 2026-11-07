//! Single-use MLS key packages, plus one reusable "last resort" package per Device so a Device
//! that has run out can still be reached.

use super::{DeviceId, StoreError, UTC_DATE, signed};
use sqlx::PgConnection;

/// Most single-use packages a Device may have waiting.
pub const MAX_STORED: i64 = 100;

#[derive(Debug, PartialEq, Eq)]
pub enum AddError {
    /// Adding these would pass the limit.
    TooMany,
    Store,
}

impl From<sqlx::Error> for AddError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}

async fn stored(conn: &mut PgConnection, device: &DeviceId) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT count(*) FROM key_packages WHERE device_id = $1 AND NOT last_resort")
        .bind(device.as_slice())
        .fetch_one(conn)
        .await
}

async fn insert(
    conn: &mut PgConnection,
    device: &DeviceId,
    package: &[u8],
    last_resort: bool,
    now: i64,
) -> Result<(), sqlx::Error> {
    let sql = format!(
        "INSERT INTO key_packages (device_id, key_package, last_resort, created_on) VALUES ($2, $3, $4, {UTC_DATE})"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(now)
        .bind(device.as_slice())
        .bind(package)
        .bind(last_resort)
        .execute(conn)
        .await
        .map(|_| ())
}

/// Stores single-use packages, and replaces the last-resort package if one is given.
pub async fn add(
    conn: &mut PgConnection,
    device: &DeviceId,
    packages: &[Vec<u8>],
    last_resort: Option<&[u8]>,
    now_secs: u64,
) -> Result<(), AddError> {
    let now = signed(now_secs).map_err(|_| AddError::Store)?;
    let waiting = stored(conn, device).await?;
    let adding = i64::try_from(packages.len()).map_err(|_| AddError::TooMany)?;
    if waiting + adding > MAX_STORED {
        return Err(AddError::TooMany);
    }
    for package in packages {
        insert(conn, device, package, false, now).await?;
    }
    if let Some(package) = last_resort {
        sqlx::query("DELETE FROM key_packages WHERE device_id = $1 AND last_resort")
            .bind(device.as_slice())
            .execute(&mut *conn)
            .await?;
        insert(conn, device, package, true, now).await?;
    }
    Ok(())
}

/// Hands out one package: the oldest single-use one (which is deleted), else the last-resort one.
pub async fn take_one(
    conn: &mut PgConnection,
    device: &DeviceId,
) -> Result<Option<Vec<u8>>, StoreError> {
    let single: Option<Vec<u8>> = sqlx::query_scalar(
        "DELETE FROM key_packages WHERE id = (SELECT id FROM key_packages \
         WHERE device_id = $1 AND NOT last_resort ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) \
         RETURNING key_package",
    )
    .bind(device.as_slice())
    .fetch_optional(&mut *conn)
    .await?;
    if single.is_some() {
        return Ok(single);
    }
    let reusable = sqlx::query_scalar(
        "SELECT key_package FROM key_packages WHERE device_id = $1 AND last_resort",
    )
    .bind(device.as_slice())
    .fetch_optional(conn)
    .await?;
    Ok(reusable)
}
