//! The JavaScript-facing API: plain bytes in and out, errors reduced to stable codes.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crypto_wasm::Error;
use crypto_wasm::wasm::{KIND_GROUP_CHANGED, KIND_MESSAGE, KIND_REMOVED, WasmClient};

fn pair() -> (WasmClient, WasmClient, Vec<u8>) {
    let alice = WasmClient::new(b"alice").unwrap();
    let bob = WasmClient::new(b"bob").unwrap();
    let group = alice.create_group().unwrap();
    let added = alice
        .add_member(&group, &bob.key_package().unwrap())
        .unwrap();
    assert_eq!(bob.join(&added.welcome()).unwrap(), group);
    (alice, bob, group)
}

#[test]
fn messages_cross_the_api_as_bytes() {
    let (alice, bob, group) = pair();
    let sent = alice.encrypt(&group, b"hi").unwrap();
    let got = bob.receive(&group, &sent).unwrap();
    assert_eq!(got.kind(), KIND_MESSAGE);
    assert_eq!(got.message(), b"hi");
}

#[test]
fn kinds_are_distinct_and_stable() {
    assert_eq!((KIND_MESSAGE, KIND_GROUP_CHANGED, KIND_REMOVED), (0, 1, 2));
}

#[test]
fn membership_changes_report_their_kind_and_carry_no_message() {
    let (alice, bob, group) = pair();
    let carol = WasmClient::new(b"carol").unwrap();
    let added = alice
        .add_member(&group, &carol.key_package().unwrap())
        .unwrap();
    let seen = bob.receive(&group, &added.commit()).unwrap();
    assert_eq!(seen.kind(), KIND_GROUP_CHANGED);
    assert!(seen.message().is_empty());

    let index = (0..alice.member_count(&group).unwrap())
        .map(|i| alice.member_index(&group, i).unwrap())
        .find(|i| alice.member_identity(&group, *i).unwrap() == b"bob")
        .unwrap();
    let commit = alice.remove_member(&group, index).unwrap();
    assert_eq!(bob.receive(&group, &commit).unwrap().kind(), KIND_REMOVED);
}

#[test]
fn errors_are_only_a_code() {
    let (alice, _bob, group) = pair();
    assert_eq!(alice.encrypt(b"nope", b"x").unwrap_err(), "unknown_group");
    assert_eq!(alice.receive(&group, b"junk").err().unwrap(), "malformed");
    assert_eq!(alice.member_identity(&group, 99).unwrap_err(), "rejected");
    assert_eq!(alice.member_count(b"nope").unwrap_err(), "unknown_group");
    assert_eq!(alice.member_index(&group, 99).unwrap_err(), "rejected");
}

#[test]
fn every_error_has_its_own_code() {
    let codes = [
        Error::Malformed.code(),
        Error::UnsupportedCiphersuite.code(),
        Error::UnknownGroup.code(),
        Error::Rejected.code(),
        Error::TooLarge.code(),
    ];
    let mut unique = codes.to_vec();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), 5);
    assert_eq!(Error::TooLarge.code(), "too_large");
}

#[test]
fn state_and_last_resort_packages_cross_the_api_as_bytes() {
    let (alice, bob, group) = pair();
    let restored = WasmClient::restore(&alice.export_state().unwrap()).unwrap();
    let sent = restored.encrypt(&group, b"still here").unwrap();
    assert_eq!(bob.receive(&group, &sent).unwrap().message(), b"still here");
    assert_ne!(
        alice.last_resort_key_package().unwrap(),
        alice.key_package().unwrap()
    );
    assert_eq!(WasmClient::restore(b"junk").err().unwrap(), "malformed");
}
