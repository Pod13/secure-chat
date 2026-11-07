//! Redeeming a Contact or Group Invite. The redeemer needs no account: they present the Invite
//! token and receive, for each of the creator's Devices, a fresh delivery token and a key
//! package, enough to send an encrypted join request. Who redeems is never recorded.

use super::{DeviceId, Hash, StoreError, invites, keypackages};
use crate::delivery::sealed::{self, MintError};
use crate::ports::{Clock, Random};
use sqlx::PgPool;

/// Most Devices of the creator that one redemption reaches.
pub const MAX_DEVICES: i64 = 50;

pub struct ReachableDevice {
    pub delivery_token: [u8; 32],
    pub key_package: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RedeemError {
    /// Unknown, expired, revoked, used up, or not a Contact or Group Invite.
    InvalidInvite,
    Store,
}

impl From<sqlx::Error> for RedeemError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}

impl From<StoreError> for RedeemError {
    fn from(_: StoreError) -> Self {
        Self::Store
    }
}

impl From<MintError> for RedeemError {
    fn from(_: MintError) -> Self {
        Self::Store
    }
}

pub async fn redeem(
    pool: &PgPool,
    clock: &impl Clock,
    random: &impl Random,
    invite_hash: &Hash,
) -> Result<Vec<ReachableDevice>, RedeemError> {
    let mut tx = pool.begin().await?;
    let owner = invites::consume(
        &mut tx,
        invite_hash,
        &["contact", "group"],
        clock.now_secs(),
    )
    .await?
    .flatten()
    .ok_or(RedeemError::InvalidInvite)?;
    let devices: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT device_id FROM devices WHERE account_id = $1 ORDER BY device_id LIMIT $2",
    )
    .bind(owner.as_slice())
    .bind(MAX_DEVICES)
    .fetch_all(&mut *tx)
    .await?;
    let mut reachable = Vec::new();
    for device in devices {
        let device: DeviceId = device.try_into().map_err(|_| RedeemError::Store)?;
        if let Some(key_package) = keypackages::take_one(&mut tx, &device).await? {
            let minted = sealed::mint(&mut tx, random, &device).await?;
            reachable.push(ReachableDevice {
                delivery_token: minted.token,
                key_package,
            });
        }
    }
    if reachable.is_empty() {
        return Err(RedeemError::InvalidInvite);
    }
    tx.commit().await?;
    Ok(reachable)
}
