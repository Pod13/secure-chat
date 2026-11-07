//! Telling a Welcome from a group message, and finding a message's group, before decrypting.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crypto_wasm::{Client, Error, Route};

#[test]
fn a_welcome_is_recognised() {
    let mut alice = Client::new(b"alice").unwrap();
    let bob = Client::new(b"bob").unwrap();
    let group = alice.create_group().unwrap();
    let added = alice
        .add_member(&group, &bob.key_package().unwrap())
        .unwrap();
    assert_eq!(Client::route(&added.welcome).unwrap(), Route::Welcome);
}

#[test]
fn a_group_message_names_its_group() {
    let mut alice = Client::new(b"alice").unwrap();
    let group = alice.create_group().unwrap();
    let message = alice.encrypt(&group, b"hi").unwrap();
    assert_eq!(Client::route(&message).unwrap(), Route::Group(group));
}

#[test]
fn a_commit_names_its_group_too() {
    let mut alice = Client::new(b"alice").unwrap();
    let bob = Client::new(b"bob").unwrap();
    let group = alice.create_group().unwrap();
    let added = alice
        .add_member(&group, &bob.key_package().unwrap())
        .unwrap();
    assert_eq!(Client::route(&added.commit).unwrap(), Route::Group(group));
}

#[test]
fn anything_else_is_refused() {
    let alice = Client::new(b"alice").unwrap();
    assert_eq!(Client::route(&[]).err(), Some(Error::Malformed));
    assert_eq!(Client::route(b"junk bytes").err(), Some(Error::Malformed));
    // A key package is a valid MLS message, but not one that may arrive here.
    let key_package = alice.key_package().unwrap();
    assert_eq!(Client::route(&key_package).err(), Some(Error::Malformed));
}
