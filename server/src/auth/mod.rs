//! Device authentication (Constitution: Authentication & sessions).
//!
//! A Device proves it holds its private key by signing a one-time challenge; there are no
//! passwords. The server then issues a short-lived random token, stores only its hash, and ties
//! it to the Device. Every failure looks the same to the caller so nothing can be probed.
//! All I/O (clock, randomness, storage) is injected so every branch can be tested.

pub mod pg;

use crate::ports::{Clock, Random};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};
use std::future::Future;

pub type DeviceId = [u8; 16];
pub type Hash = [u8; 32];

/// How long a login challenge stays valid.
pub const NONCE_TTL_SECS: u64 = 300;

/// Domain separation: a signature made for login can never be valid for anything else.
pub const LOGIN_DOMAIN: &[u8] = b"secure-chat/login/v1";

#[derive(Debug, PartialEq, Eq)]
pub struct StoreError;

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// Wrong, expired, replayed or unknown. Deliberately one answer for all of them.
    Unauthorized,
    Store,
}

impl From<StoreError> for AuthError {
    fn from(_: StoreError) -> Self {
        Self::Store
    }
}

pub struct Session {
    /// The secret the Device presents. Only its hash is stored.
    pub token: [u8; 32],
    pub expires_in: u64,
}

pub trait AuthStore {
    fn device_key(
        &self,
        device: &DeviceId,
    ) -> impl Future<Output = Result<Option<Hash>, StoreError>> + Send;
    fn put_nonce(
        &self,
        device: &DeviceId,
        nonce: Hash,
        expires_at: u64,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    /// Returns and removes the nonce, so a challenge can only be answered once.
    fn take_nonce(
        &self,
        device: &DeviceId,
    ) -> impl Future<Output = Result<Option<(Hash, u64)>, StoreError>> + Send;
    fn put_session(
        &self,
        token_hash: Hash,
        device: DeviceId,
        expires_at: u64,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
    fn session(
        &self,
        token_hash: &Hash,
    ) -> impl Future<Output = Result<Option<(DeviceId, u64)>, StoreError>> + Send;
    /// Removes every session and any pending challenge of a Device (unlinking).
    fn delete_device_sessions(
        &self,
        device: &DeviceId,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;
}

pub fn login_message(device: &DeviceId, nonce: &Hash) -> Vec<u8> {
    [LOGIN_DOMAIN, device, nonce].concat()
}

fn hash_token(token: &[u8; 32]) -> Hash {
    Sha256::digest(token).into()
}

fn random32(random: &impl Random) -> [u8; 32] {
    let mut out = [0u8; 32];
    random.fill(&mut out);
    out
}

/// Step one: hand out a challenge. An unknown Device gets one too (it is simply not stored), so
/// the answer does not reveal which Devices exist.
pub async fn start_login(
    store: &impl AuthStore,
    clock: &impl Clock,
    random: &impl Random,
    device: &DeviceId,
) -> Result<Hash, AuthError> {
    let nonce = random32(random);
    if store.device_key(device).await?.is_some() {
        store
            .put_nonce(device, nonce, clock.now_secs() + NONCE_TTL_SECS)
            .await?;
    }
    Ok(nonce)
}

fn signature_is_valid(key: &Hash, device: &DeviceId, nonce: &Hash, signature: &[u8; 64]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(key) else {
        return false;
    };
    let signature = Signature::from_bytes(signature);
    key.verify_strict(&login_message(device, nonce), &signature)
        .is_ok()
}

/// Step two: check the signed challenge and issue a session.
pub async fn finish_login(
    store: &impl AuthStore,
    clock: &impl Clock,
    random: &impl Random,
    session_ttl_secs: u64,
    device: &DeviceId,
    signature: &[u8; 64],
) -> Result<Session, AuthError> {
    let now = clock.now_secs();
    let (nonce, expires_at) = store
        .take_nonce(device)
        .await?
        .ok_or(AuthError::Unauthorized)?;
    let key = store
        .device_key(device)
        .await?
        .ok_or(AuthError::Unauthorized)?;
    if now >= expires_at || !signature_is_valid(&key, device, &nonce, signature) {
        return Err(AuthError::Unauthorized);
    }
    let token = random32(random);
    store
        .put_session(hash_token(&token), *device, now + session_ttl_secs)
        .await?;
    Ok(Session {
        token,
        expires_in: session_ttl_secs,
    })
}

/// Checks a presented token and names the Device it belongs to.
pub async fn authenticate(
    store: &impl AuthStore,
    clock: &impl Clock,
    token: &[u8; 32],
) -> Result<DeviceId, AuthError> {
    let (device, expires_at) = store
        .session(&hash_token(token))
        .await?
        .ok_or(AuthError::Unauthorized)?;
    if clock.now_secs() >= expires_at {
        return Err(AuthError::Unauthorized);
    }
    Ok(device)
}

/// Ends every session of a Device at once (used when a Device is unlinked).
pub async fn revoke_device(store: &impl AuthStore, device: &DeviceId) -> Result<(), AuthError> {
    Ok(store.delete_device_sessions(device).await?)
}
