//! Saving and restoring a Device's MLS state, and the last-resort key package.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crypto_wasm::{Client, Error, Received};
use openmls::prelude::tls_codec::Deserialize as _;
use openmls::prelude::{MlsMessageBodyIn, MlsMessageIn, ProtocolVersion};
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider as _;

fn pair() -> (Client, Client, Vec<u8>) {
    let mut alice = Client::new(b"alice").unwrap();
    let mut bob = Client::new(b"bob").unwrap();
    let group = alice.create_group().unwrap();
    let added = alice
        .add_member(&group, &bob.key_package().unwrap())
        .unwrap();
    bob.join(&added.welcome).unwrap();
    (alice, bob, group)
}

fn text(received: Received) -> Vec<u8> {
    match received {
        Received::Message(text) => text,
        other => panic!("expected a message, got {other:?}"),
    }
}

#[test]
fn a_restored_device_keeps_talking_in_its_groups() {
    let (mut alice, mut bob, group) = pair();
    let first = alice.encrypt(&group, b"before").unwrap();
    assert_eq!(text(bob.receive(&group, &first).unwrap()), b"before");

    let mut alice = Client::restore(&alice.export_state().unwrap()).unwrap();
    let mut bob = Client::restore(&bob.export_state().unwrap()).unwrap();

    let second = alice.encrypt(&group, b"after").unwrap();
    assert_eq!(text(bob.receive(&group, &second).unwrap()), b"after");
    let reply = bob.encrypt(&group, b"reply").unwrap();
    assert_eq!(text(alice.receive(&group, &reply).unwrap()), b"reply");
}

#[test]
fn a_restored_device_keeps_its_identity_and_can_be_added() {
    let (alice, _bob, group) = pair();
    let carol = Client::new(b"carol").unwrap();
    let mut carol = Client::restore(&carol.export_state().unwrap()).unwrap();
    let mut alice = Client::restore(&alice.export_state().unwrap()).unwrap();
    let added = alice
        .add_member(&group, &carol.key_package().unwrap())
        .unwrap();
    assert_eq!(carol.join(&added.welcome).unwrap(), group);
    let identities: Vec<_> = alice
        .members(&group)
        .unwrap()
        .into_iter()
        .map(|m| m.identity)
        .collect();
    assert!(identities.contains(&b"alice".to_vec()));
    assert!(identities.contains(&b"carol".to_vec()));
}

#[test]
fn a_key_package_made_before_saving_still_works_after_restoring() {
    let mut alice = Client::new(b"alice").unwrap();
    let bob = Client::new(b"bob").unwrap();
    let published = bob.key_package().unwrap();
    let mut bob = Client::restore(&bob.export_state().unwrap()).unwrap();
    let group = alice.create_group().unwrap();
    let added = alice.add_member(&group, &published).unwrap();
    assert_eq!(bob.join(&added.welcome).unwrap(), group);
}

#[test]
fn saved_state_does_not_contain_message_text() {
    let (mut alice, _bob, group) = pair();
    alice
        .encrypt(&group, b"a secret sentence nobody should find")
        .unwrap();
    let state = alice.export_state().unwrap();
    assert!(
        !state
            .windows(b"a secret sentence".len())
            .any(|w| w == b"a secret sentence")
    );
}

#[test]
fn damaged_state_is_refused() {
    let state = Client::new(b"alice").unwrap().export_state().unwrap();
    assert_eq!(Client::restore(&[]).err(), Some(Error::Malformed));
    let mut wrong_version = state.clone();
    wrong_version[0] = 99;
    assert_eq!(
        Client::restore(&wrong_version).err(),
        Some(Error::Malformed)
    );
    for cut in [1, 5, state.len() / 2, state.len() - 1] {
        assert_eq!(
            Client::restore(&state[..cut]).err(),
            Some(Error::Malformed),
            "cut at {cut}"
        );
    }
    let mut extra = state.clone();
    extra.push(0);
    assert_eq!(Client::restore(&extra).err(), Some(Error::Malformed));
}

/// Rewrites a saved state with its stored values removed, keeping the header that names groups.
fn without_values(state: &[u8]) -> Vec<u8> {
    let mut at = 1;
    let mut take = |count: usize| {
        let start = at;
        at += count;
        start..at
    };
    let read_u32 = |bytes: &[u8]| u32::from_be_bytes(bytes.try_into().unwrap()) as usize;
    for _ in 0..2 {
        let len = read_u32(&state[take(4)]);
        take(len);
    }
    let groups = read_u32(&state[take(4)]);
    for _ in 0..groups {
        let len = read_u32(&state[take(4)]);
        take(len);
    }
    let mut out = state[..at].to_vec();
    out.extend(0u32.to_be_bytes());
    out
}

#[test]
fn state_naming_a_group_it_does_not_hold_is_refused() {
    let (alice, _bob, _group) = pair();
    let state = without_values(&alice.export_state().unwrap());
    assert_eq!(Client::restore(&state).err(), Some(Error::Malformed));
}

#[test]
fn the_last_resort_key_package_is_marked_and_usable() {
    let mut alice = Client::new(b"alice").unwrap();
    let bob = Client::new(b"bob").unwrap();
    let last_resort = bob.last_resort_key_package().unwrap();
    assert_ne!(last_resort, bob.key_package().unwrap());

    let MlsMessageBodyIn::KeyPackage(parsed) =
        MlsMessageIn::tls_deserialize_exact(last_resort.as_slice())
            .unwrap()
            .extract()
    else {
        panic!("not a key package");
    };
    let provider = OpenMlsRustCrypto::default();
    let valid = parsed
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .unwrap();
    assert!(valid.last_resort());

    let group = alice.create_group().unwrap();
    assert!(alice.add_member(&group, &last_resort).is_ok());
}
