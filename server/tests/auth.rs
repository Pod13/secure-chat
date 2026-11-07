#![allow(clippy::unwrap_used)]

mod common;
mod fakes;

use common::{artifact, assert_nothing_leaked, secret};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use fakes::{CountingRandom, FakeClock, MemoryAuthStore};
use server::auth::{
    AuthError, DeviceId, NONCE_TTL_SECS, Session, authenticate, finish_login, revoke_device,
    start_login,
};

const DEVICE: DeviceId = [1; 16];
const OTHER: DeviceId = [2; 16];
const TTL: u64 = 900;

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

fn store() -> MemoryAuthStore {
    MemoryAuthStore::with_device(DEVICE, key().verifying_key().to_bytes())
}

fn sign(key: &SigningKey, device: &DeviceId, nonce: &[u8; 32]) -> [u8; 64] {
    let message = [b"secure-chat/login/v1".as_slice(), device, nonce].concat();
    key.sign(&message).to_bytes()
}

async fn login_at(s: &MemoryAuthStore, clock: &FakeClock) -> Result<Session, AuthError> {
    let random = CountingRandom::default();
    let nonce = start_login(s, clock, &random, &DEVICE).await?;
    finish_login(
        s,
        clock,
        &random,
        TTL,
        &DEVICE,
        &sign(&key(), &DEVICE, &nonce),
    )
    .await
}

#[tokio::test]
async fn a_device_that_signs_the_challenge_gets_a_session_it_can_use() {
    let (s, clock) = (store(), FakeClock::at(1_000));
    let session = login_at(&s, &clock).await.unwrap();
    assert_eq!(session.expires_in, TTL);
    assert_eq!(authenticate(&s, &clock, &session.token).await, Ok(DEVICE));
}

#[tokio::test]
async fn a_challenge_can_only_be_answered_once() {
    let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
    let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
    let signature = sign(&key(), &DEVICE, &nonce);
    assert!(
        finish_login(&s, &clock, &random, TTL, &DEVICE, &signature)
            .await
            .is_ok()
    );
    let replay = finish_login(&s, &clock, &random, TTL, &DEVICE, &signature).await;
    assert_eq!(replay.err(), Some(AuthError::Unauthorized));
}

#[tokio::test]
async fn a_challenge_expires_exactly_at_its_lifetime() {
    for (wait, ok) in [(NONCE_TTL_SECS - 1, true), (NONCE_TTL_SECS, false)] {
        let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
        let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
        clock.advance(wait);
        let signature = sign(&key(), &DEVICE, &nonce);
        let result = finish_login(&s, &clock, &random, TTL, &DEVICE, &signature).await;
        assert_eq!(result.is_ok(), ok, "waited {wait}s");
    }
}

#[tokio::test]
async fn signatures_that_do_not_match_this_challenge_are_refused() {
    let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
    let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
    let stranger = SigningKey::from_bytes(&[9; 32]);
    let wrong_nonce = [0xAA; 32];
    let bad = [
        sign(&stranger, &DEVICE, &nonce),
        sign(&key(), &DEVICE, &wrong_nonce),
        sign(&key(), &OTHER, &nonce),
        [0u8; 64],
    ];
    for signature in bad {
        s.nonces.lock().unwrap().insert(DEVICE, (nonce, 2_000));
        let result = finish_login(&s, &clock, &random, TTL, &DEVICE, &signature).await;
        assert_eq!(result.err(), Some(AuthError::Unauthorized));
    }
}

#[tokio::test]
async fn a_signature_for_another_purpose_is_not_a_login() {
    let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
    let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
    let no_domain = key().sign(&[DEVICE.as_slice(), &nonce].concat()).to_bytes();
    let result = finish_login(&s, &clock, &random, TTL, &DEVICE, &no_domain).await;
    assert_eq!(result.err(), Some(AuthError::Unauthorized));
}

#[tokio::test]
async fn an_unknown_device_is_indistinguishable_until_it_fails_to_log_in() {
    let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
    let nonce = start_login(&s, &clock, &random, &OTHER).await.unwrap();
    assert_eq!(nonce.len(), 32);
    assert!(
        s.nonces.lock().unwrap().is_empty(),
        "nothing is stored for an unknown device"
    );
    let result = finish_login(
        &s,
        &clock,
        &random,
        TTL,
        &OTHER,
        &sign(&key(), &OTHER, &nonce),
    )
    .await;
    assert_eq!(result.err(), Some(AuthError::Unauthorized));
}

#[tokio::test]
async fn a_device_removed_mid_login_is_refused() {
    let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
    let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
    s.keys.lock().unwrap().clear();
    let result = finish_login(
        &s,
        &clock,
        &random,
        TTL,
        &DEVICE,
        &sign(&key(), &DEVICE, &nonce),
    )
    .await;
    assert_eq!(result.err(), Some(AuthError::Unauthorized));
}

#[tokio::test]
async fn a_stored_key_that_is_not_a_valid_point_never_authenticates() {
    let invalid = (0..=255u8)
        .map(|b| [b; 32])
        .find(|k| VerifyingKey::from_bytes(k).is_err());
    let invalid = invalid.expect("some 32-byte value is not a valid public key");
    let s = MemoryAuthStore::with_device(DEVICE, invalid);
    let (clock, random) = (FakeClock::at(1_000), CountingRandom::default());
    let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
    let result = finish_login(
        &s,
        &clock,
        &random,
        TTL,
        &DEVICE,
        &sign(&key(), &DEVICE, &nonce),
    )
    .await;
    assert_eq!(result.err(), Some(AuthError::Unauthorized));
}

#[tokio::test]
async fn a_session_ends_exactly_at_its_lifetime() {
    let (s, clock) = (store(), FakeClock::at(1_000));
    let session = login_at(&s, &clock).await.unwrap();
    clock.advance(TTL - 1);
    assert_eq!(authenticate(&s, &clock, &session.token).await, Ok(DEVICE));
    clock.advance(1);
    assert_eq!(
        authenticate(&s, &clock, &session.token).await,
        Err(AuthError::Unauthorized)
    );
}

#[tokio::test]
async fn an_unknown_token_is_refused() {
    let (s, clock) = (store(), FakeClock::at(1_000));
    assert_eq!(
        authenticate(&s, &clock, &[5; 32]).await,
        Err(AuthError::Unauthorized)
    );
}

#[tokio::test]
async fn unlinking_ends_every_session_at_once_and_only_that_device() {
    let (s, clock) = (store(), FakeClock::at(1_000));
    let session = login_at(&s, &clock).await.unwrap();
    s.sessions.lock().unwrap().insert([9; 32], (OTHER, 5_000));
    revoke_device(&s, &DEVICE).await.unwrap();
    assert_eq!(
        authenticate(&s, &clock, &session.token).await,
        Err(AuthError::Unauthorized)
    );
    assert_eq!(
        s.sessions.lock().unwrap().len(),
        1,
        "another device's session is untouched"
    );
}

#[tokio::test]
async fn the_server_stores_only_a_hash_of_the_token() {
    let (s, clock) = (store(), FakeClock::at(1_000));
    let session = login_at(&s, &clock).await.unwrap();
    let mut dump = Vec::new();
    for (hash, (device, expiry)) in s.sessions.lock().unwrap().iter() {
        dump.extend([hash.as_slice(), device, &expiry.to_be_bytes()].concat());
    }
    for (device, (nonce, expiry)) in s.nonces.lock().unwrap().iter() {
        dump.extend([device.as_slice(), nonce, &expiry.to_be_bytes()].concat());
    }
    assert!(!dump.is_empty());
    assert_nothing_leaked(
        &[artifact("auth store", &dump)],
        &[secret("session token", &session.token)],
    );
}

#[tokio::test]
async fn every_login_gets_a_different_token() {
    let (s, clock, random) = (store(), FakeClock::at(1_000), CountingRandom::default());
    let mut tokens = Vec::new();
    for _ in 0..2 {
        let nonce = start_login(&s, &clock, &random, &DEVICE).await.unwrap();
        let signature = sign(&key(), &DEVICE, &nonce);
        tokens.push(
            finish_login(&s, &clock, &random, TTL, &DEVICE, &signature)
                .await
                .unwrap()
                .token,
        );
    }
    assert_ne!(tokens[0], tokens[1]);
}

#[tokio::test]
async fn storage_failures_are_reported_never_treated_as_success() {
    let total_calls = 5;
    for ok_calls in 0..total_calls {
        let (s, clock) = (store(), FakeClock::at(1_000));
        s.fail_after(ok_calls);
        assert_eq!(
            login_at(&s, &clock).await.err(),
            Some(AuthError::Store),
            "{ok_calls}"
        );
    }
    let (s, clock) = (store(), FakeClock::at(1_000));
    s.fail_after(total_calls);
    assert!(login_at(&s, &clock).await.is_ok());
}

#[tokio::test]
async fn storage_failures_while_checking_or_revoking_are_reported() {
    let (s, clock) = (store(), FakeClock::at(1_000));
    let session = login_at(&s, &clock).await.unwrap();
    s.fail_after(0);
    assert_eq!(
        authenticate(&s, &clock, &session.token).await,
        Err(AuthError::Store)
    );
    assert_eq!(revoke_device(&s, &DEVICE).await, Err(AuthError::Store));
}

#[tokio::test]
async fn sessions_are_stored_under_the_sha256_of_the_token_and_do_not_collide() {
    use sha2::{Digest, Sha256};
    let s = store();
    let other_key = SigningKey::from_bytes(&[8; 32]);
    s.keys
        .lock()
        .unwrap()
        .insert(OTHER, other_key.verifying_key().to_bytes());
    let (clock, random) = (FakeClock::at(1_000), CountingRandom::default());
    let mut tokens = Vec::new();
    for (device, signer) in [(DEVICE, key()), (OTHER, other_key)] {
        let nonce = start_login(&s, &clock, &random, &device).await.unwrap();
        let signature = sign(&signer, &device, &nonce);
        let session = finish_login(&s, &clock, &random, TTL, &device, &signature)
            .await
            .unwrap();
        tokens.push((device, session.token));
    }
    for (device, token) in tokens {
        let expected: [u8; 32] = Sha256::digest(token).into();
        assert_eq!(
            s.sessions.lock().unwrap().get(&expected).map(|v| v.0),
            Some(device)
        );
        assert_eq!(authenticate(&s, &clock, &token).await, Ok(device));
    }
    assert_eq!(s.sessions.lock().unwrap().len(), 2);
}
