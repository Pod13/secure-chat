//! The MLS wrapper: groups, messages, membership changes and the one-ciphersuite rule.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crypto_wasm::{Client, Error, Received};

/// Alice creates a group and adds Bob; returns both clients and the group id.
fn pair() -> (Client, Client, Vec<u8>) {
    let mut alice = Client::new(b"alice").unwrap();
    let mut bob = Client::new(b"bob").unwrap();
    let group = alice.create_group().unwrap();
    let added = alice
        .add_member(&group, &bob.key_package().unwrap())
        .unwrap();
    assert_eq!(bob.join(&added.welcome).unwrap(), group);
    (alice, bob, group)
}

fn message(received: Received) -> Vec<u8> {
    match received {
        Received::Message(text) => text,
        other => panic!("expected a message, got {other:?}"),
    }
}

#[test]
fn members_read_each_others_messages() {
    let (mut alice, mut bob, group) = pair();
    let to_bob = alice.encrypt(&group, b"hello bob").unwrap();
    assert_eq!(message(bob.receive(&group, &to_bob).unwrap()), b"hello bob");
    let to_alice = bob.encrypt(&group, b"hello alice").unwrap();
    assert_eq!(
        message(alice.receive(&group, &to_alice).unwrap()),
        b"hello alice"
    );
}

#[test]
fn ciphertext_hides_the_text_and_its_length() {
    let (mut alice, _bob, group) = pair();
    let secret = b"correct horse battery staple";
    let short = alice.encrypt(&group, secret).unwrap();
    let longer = alice.encrypt(&group, &[b'x'; 200]).unwrap();
    assert!(!short.windows(secret.len()).any(|w| w == secret));
    assert_eq!(short.len(), longer.len(), "same bucket, same size");
    let big = alice.encrypt(&group, &[b'x'; 2000]).unwrap();
    assert!(
        big.len() > short.len(),
        "a bigger bucket is a bigger message"
    );
}

#[test]
fn a_message_cannot_be_read_twice() {
    let (mut alice, mut bob, group) = pair();
    let sent = alice.encrypt(&group, b"once").unwrap();
    bob.receive(&group, &sent).unwrap();
    assert!(bob.receive(&group, &sent).is_err());
}

#[test]
fn a_third_member_can_join_and_everyone_keeps_up() {
    let (mut alice, mut bob, group) = pair();
    let mut carol = Client::new(b"carol").unwrap();
    let added = alice
        .add_member(&group, &carol.key_package().unwrap())
        .unwrap();
    assert_eq!(
        bob.receive(&group, &added.commit).unwrap(),
        Received::GroupChanged
    );
    assert_eq!(carol.join(&added.welcome).unwrap(), group);

    let sent = carol.encrypt(&group, b"hi all").unwrap();
    assert_eq!(message(alice.receive(&group, &sent).unwrap()), b"hi all");
    assert_eq!(message(bob.receive(&group, &sent).unwrap()), b"hi all");
}

#[test]
fn the_member_list_names_everyone() {
    let (alice, _bob, group) = pair();
    let mut names: Vec<Vec<u8>> = alice
        .members(&group)
        .unwrap()
        .into_iter()
        .map(|m| m.identity)
        .collect();
    names.sort();
    assert_eq!(names, vec![b"alice".to_vec(), b"bob".to_vec()]);
}

#[test]
fn a_removed_member_is_told_and_cannot_read_new_messages() {
    let (mut alice, mut bob, group) = pair();
    let bob_index = alice
        .members(&group)
        .unwrap()
        .into_iter()
        .find(|m| m.identity == b"bob")
        .unwrap()
        .index;

    let commit = alice.remove_member(&group, bob_index).unwrap();
    assert_eq!(bob.receive(&group, &commit).unwrap(), Received::Removed);

    let later = alice.encrypt(&group, b"secret after removal").unwrap();
    assert!(bob.receive(&group, &later).is_err());
    assert!(bob.encrypt(&group, b"still here?").is_err());
}

#[test]
fn remaining_members_follow_a_removal() {
    let (mut alice, mut bob, group) = pair();
    let mut carol = Client::new(b"carol").unwrap();
    let added = alice
        .add_member(&group, &carol.key_package().unwrap())
        .unwrap();
    bob.receive(&group, &added.commit).unwrap();
    carol.join(&added.welcome).unwrap();

    let carol_index = alice
        .members(&group)
        .unwrap()
        .into_iter()
        .find(|m| m.identity == b"carol")
        .unwrap()
        .index;
    let commit = alice.remove_member(&group, carol_index).unwrap();
    assert_eq!(
        bob.receive(&group, &commit).unwrap(),
        Received::GroupChanged
    );

    let sent = bob.encrypt(&group, b"just us").unwrap();
    assert_eq!(message(alice.receive(&group, &sent).unwrap()), b"just us");
}

#[test]
fn removing_nobody_is_an_error() {
    let (mut alice, _bob, group) = pair();
    assert!(alice.remove_member(&group, 99).is_err());
}

#[test]
fn unknown_groups_are_refused() {
    let mut alice = Client::new(b"alice").unwrap();
    assert_eq!(alice.encrypt(b"nope", b"x"), Err(Error::UnknownGroup));
    assert_eq!(alice.receive(b"nope", b"x"), Err(Error::UnknownGroup));
    assert_eq!(alice.members(b"nope").map(|_| ()), Err(Error::UnknownGroup));
}

#[test]
fn garbage_is_refused_without_panicking() {
    let (mut alice, mut bob, group) = pair();
    for junk in [&b""[..], b"\x00", b"not mls at all", &[0xff; 300]] {
        assert_eq!(
            alice.add_member(&group, junk).map(|_| ()),
            Err(Error::Malformed)
        );
        assert_eq!(bob.join(junk), Err(Error::Malformed));
        assert_eq!(bob.receive(&group, junk), Err(Error::Malformed));
    }
}

#[test]
fn messages_are_not_valid_where_a_key_package_is_expected() {
    let (mut alice, _bob, group) = pair();
    let ciphertext = alice.encrypt(&group, b"hi").unwrap();
    assert_eq!(
        alice.add_member(&group, &ciphertext).map(|_| ()),
        Err(Error::Malformed)
    );
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn handshake_messages_hide_who_was_added() {
    // Creator's commit, then a joined member's commit: both must be encrypted.
    let (mut alice, mut bob, group) = pair();
    let carol = Client::new(b"carol").unwrap();
    let by_alice = alice
        .add_member(&group, &carol.key_package().unwrap())
        .unwrap();
    assert!(
        !contains(&by_alice.commit, b"carol"),
        "creator's commit shows the new member"
    );
    bob.receive(&group, &by_alice.commit).unwrap();

    let mut dave = Client::new(b"dave").unwrap();
    let by_bob = bob
        .add_member(&group, &dave.key_package().unwrap())
        .unwrap();
    assert!(
        !contains(&by_bob.commit, b"dave"),
        "joiner's commit shows the new member"
    );
    // A member who joined by welcome can bring in another: the welcome carries the group tree.
    assert_eq!(dave.join(&by_bob.welcome).unwrap(), group);
}
