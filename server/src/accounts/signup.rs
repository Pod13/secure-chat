//! Account creation. The Invite is checked and used up, and the Account created, in one
//! transaction. Nothing written ties the two together: the Account row has no Invite reference,
//! and no timestamp finer than a calendar day.

use super::{
    AccountId, DEVICE_CERT_DOMAIN, DeviceId, Hash, StoreError, UTC_DATE, invites, keypackages,
    signed,
};
use crate::ports::{Clock, Random};
use ed25519_dalek::{Signature, VerifyingKey};
use sqlx::PgPool;

pub struct NewAccount {
    pub invite_hash: Hash,
    pub identity_key: [u8; 32],
    pub device_key: [u8; 32],
    /// The identity key's signature over the Device key.
    pub certificate: [u8; 64],
    pub key_packages: Vec<Vec<u8>>,
    pub last_resort: Vec<u8>,
    pub label: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SignupError {
    /// Unknown, expired, revoked or used-up Invite.
    InvalidInvite,
    /// The certificate does not prove the identity key vouches for this Device key.
    BadCertificate,
    /// This Device key is already registered.
    Duplicate,
    TooManyKeyPackages,
    Store,
}

impl From<sqlx::Error> for SignupError {
    fn from(error: sqlx::Error) -> Self {
        match &error {
            sqlx::Error::Database(db) if db.is_unique_violation() => Self::Duplicate,
            _ => Self::Store,
        }
    }
}

impl From<StoreError> for SignupError {
    fn from(_: StoreError) -> Self {
        Self::Store
    }
}

/// True if `identity_key` signed `device_key` under the certificate label.
pub fn certificate_is_valid(
    identity_key: &[u8; 32],
    device_key: &[u8; 32],
    certificate: &[u8; 64],
) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(identity_key) else {
        return false;
    };
    let message = [DEVICE_CERT_DOMAIN, device_key.as_slice()].concat();
    key.verify_strict(&message, &Signature::from_bytes(certificate))
        .is_ok()
}

fn fresh_id(random: &impl Random) -> [u8; 16] {
    let mut id = [0u8; 16];
    random.fill(&mut id);
    id
}

pub async fn create(
    pool: &PgPool,
    clock: &impl Clock,
    random: &impl Random,
    new: NewAccount,
) -> Result<(AccountId, DeviceId), SignupError> {
    if !certificate_is_valid(&new.identity_key, &new.device_key, &new.certificate) {
        return Err(SignupError::BadCertificate);
    }
    let now = clock.now_secs();
    let (account, device) = (fresh_id(random), fresh_id(random));
    let mut tx = pool.begin().await?;
    if invites::consume(&mut tx, &new.invite_hash, &["service"], now)
        .await?
        .is_none()
    {
        return Err(SignupError::InvalidInvite);
    }
    let sql = format!(
        "INSERT INTO accounts (account_id, identity_public_key, created_on, last_connected_on) \
         VALUES ($2, $3, {UTC_DATE}, {UTC_DATE})"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(signed(now)?)
        .bind(account.as_slice())
        .bind(new.identity_key.as_slice())
        .execute(&mut *tx)
        .await?;
    let sql = format!(
        "INSERT INTO devices (device_id, account_id, device_public_key, linked_on, label_blob) \
         VALUES ($2, $3, $4, {UTC_DATE}, $5)"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(signed(now)?)
        .bind(device.as_slice())
        .bind(account.as_slice())
        .bind(new.device_key.as_slice())
        .bind(new.label.as_slice())
        .execute(&mut *tx)
        .await?;
    let added = keypackages::add(
        &mut tx,
        &device,
        &new.key_packages,
        Some(&new.last_resort),
        now,
    )
    .await;
    added.map_err(|e| match e {
        keypackages::AddError::TooMany => SignupError::TooManyKeyPackages,
        keypackages::AddError::Store => SignupError::Store,
    })?;
    tx.commit().await?;
    Ok((account, device))
}
