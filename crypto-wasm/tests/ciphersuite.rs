//! Accepted risk RUSTSEC-2026-0387: the NIST-curve code is linked into the build, so the wrapper
//! must never use any ciphersuite but the one it ships.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use crypto_wasm::{CIPHERSUITE_ID, Client, Error, ciphersuite_id};
use openmls::prelude::tls_codec::Serialize as _;
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

const OTHER: Ciphersuite = Ciphersuite::MLS_128_DHKEMP256_AES128GCM_SHA256_P256;

struct Foreign {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

fn foreign(suite: Ciphersuite) -> Foreign {
    let provider = OpenMlsRustCrypto::default();
    let signer = SignatureKeyPair::new(suite.signature_algorithm()).unwrap();
    let credential = CredentialWithKey {
        credential: BasicCredential::new(b"mallory".to_vec()).into(),
        signature_key: signer.to_public_vec().into(),
    };
    Foreign {
        provider,
        signer,
        credential,
    }
}

fn foreign_key_package(who: &Foreign, suite: Ciphersuite) -> Vec<u8> {
    let bundle = KeyPackage::builder()
        .build(suite, &who.provider, &who.signer, who.credential.clone())
        .unwrap();
    MlsMessageOut::from(bundle.key_package().clone())
        .tls_serialize_detached()
        .unwrap()
}

#[test]
fn the_shipped_ciphersuite_is_x25519_chacha20poly1305_ed25519() {
    assert_eq!(ciphersuite_id(), 0x0003);
    assert_eq!(CIPHERSUITE_ID, 0x0003);
}

#[test]
fn a_key_package_for_another_ciphersuite_is_refused() {
    let mut alice = Client::new(b"alice").unwrap();
    let group = alice.create_group().unwrap();
    let mallory = foreign(OTHER);
    let key_package = foreign_key_package(&mallory, OTHER);
    assert_eq!(
        alice.add_member(&group, &key_package).map(|_| ()),
        Err(Error::UnsupportedCiphersuite)
    );
    assert_eq!(alice.members(&group).unwrap().len(), 1, "nothing was added");
}

#[test]
fn the_same_key_package_with_the_shipped_suite_is_accepted() {
    // Guards the test above: it must fail because of the suite, not because of the helper.
    let mut alice = Client::new(b"alice").unwrap();
    let group = alice.create_group().unwrap();
    let mallory = foreign(Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519);
    let key_package = foreign_key_package(
        &mallory,
        Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519,
    );
    assert!(alice.add_member(&group, &key_package).is_ok());
}

#[test]
fn a_welcome_for_another_ciphersuite_is_refused() {
    let mallory = foreign(OTHER);
    let config = MlsGroupCreateConfig::builder().ciphersuite(OTHER).build();
    let mut group = MlsGroup::new(
        &mallory.provider,
        &mallory.signer,
        &config,
        mallory.credential.clone(),
    )
    .unwrap();

    let mut bob = Client::new(b"bob").unwrap();
    // The key package comes from a foreign identity; the wrapper must refuse before it tries to
    // decrypt, so which private keys exist does not matter.
    let bob_foreign = foreign(OTHER);
    let bundle = KeyPackage::builder()
        .build(
            OTHER,
            &bob_foreign.provider,
            &bob_foreign.signer,
            bob_foreign.credential.clone(),
        )
        .unwrap();
    let bob_key_package = bundle.key_package().clone();
    let (_commit, welcome, _) = group
        .add_members(&mallory.provider, &mallory.signer, &[bob_key_package])
        .unwrap();
    group.merge_pending_commit(&mallory.provider).unwrap();

    let welcome = welcome.tls_serialize_detached().unwrap();
    assert_eq!(bob.join(&welcome), Err(Error::UnsupportedCiphersuite));
}

#[test]
fn a_plaintext_handshake_message_is_refused() {
    let mut alice = Client::new(b"alice").unwrap();
    let group_id = alice.create_group().unwrap();

    // Mallory builds a group with the same id that sends its commits unencrypted.
    let suite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;
    let mallory = foreign(suite);
    let config = MlsGroupCreateConfig::builder()
        .ciphersuite(suite)
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .build();
    let mut group = MlsGroup::new_with_group_id(
        &mallory.provider,
        &mallory.signer,
        &config,
        GroupId::from_slice(&group_id),
        mallory.credential.clone(),
    )
    .unwrap();
    let (commit, _, _) = group
        .self_update(
            &mallory.provider,
            &mallory.signer,
            LeafNodeParameters::default(),
        )
        .unwrap()
        .into_messages();
    let bytes = commit.tls_serialize_detached().unwrap();

    assert_eq!(alice.receive(&group_id, &bytes), Err(Error::Malformed));
}
