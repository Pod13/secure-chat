//! Accounts, Devices, Invites and key packages (Data Inventory rows in
//! `specs/001-secure-realtime-chat/data-inventory.md`). Nothing here stores a username, a Contact
//! or a link between an Invite and the Account created with it.

pub mod invites;
pub mod keypackages;
pub mod redeem;
pub mod signup;

use sha2::{Digest, Sha256};

pub type AccountId = [u8; 16];
pub type DeviceId = [u8; 16];
pub type Hash = [u8; 32];

/// Domain separation: the identity key signs the Device key under this label, and nothing else.
pub const DEVICE_CERT_DOMAIN: &[u8] = b"secure-chat/device-certificate/v1";

/// Calendar date (UTC) of a Unix time, as SQL. Dates, not times, are stored (Data Inventory).
pub const UTC_DATE: &str = "(to_timestamp($1::bigint) AT TIME ZONE 'UTC')::date";

#[derive(Debug, PartialEq, Eq)]
pub struct StoreError;

impl From<sqlx::Error> for StoreError {
    fn from(_: sqlx::Error) -> Self {
        Self
    }
}

pub fn sha256(bytes: &[u8]) -> Hash {
    Sha256::digest(bytes).into()
}

/// The public id of a stored secret: the first 16 bytes of its hash. It identifies the secret
/// (for revoking) without revealing it.
pub fn short_id(hash: &Hash) -> [u8; 16] {
    let mut id = [0u8; 16];
    id.copy_from_slice(&hash[..16]);
    id
}

pub fn signed(secs: u64) -> Result<i64, StoreError> {
    i64::try_from(secs).map_err(|_| StoreError)
}
