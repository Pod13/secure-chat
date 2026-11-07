use openmls::group::{MlsGroup, MlsGroupCreateConfig, PURE_PLAINTEXT_WIRE_FORMAT_POLICY, StagedWelcome};
use openmls::prelude::tls_codec::{Deserialize as _, Serialize as _};
use openmls::prelude::{
    BasicCredential, CredentialWithKey, KeyPackage, LeafNodeIndex, MlsMessageBodyIn, MlsMessageIn,
    MlsMessageOut, ProcessedMessageContent, ProtocolMessage, Welcome,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{OpenMlsProvider as _, types::Ciphersuite};
use wasm_bindgen::prelude::wasm_bindgen;
use web_time::Instant;

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

fn identity(name: &str) -> (OpenMlsRustCrypto, SignatureKeyPair, CredentialWithKey) {
    let provider = OpenMlsRustCrypto::default();
    let signer = SignatureKeyPair::new(SUITE.signature_algorithm()).unwrap();
    let credential = BasicCredential::new(name.as_bytes().to_vec());
    let cwk = CredentialWithKey {
        credential: credential.into(),
        signature_key: signer.to_public_vec().into(),
    };
    (provider, signer, cwk)
}

/// Sends a message across a simulated network hop: serialize, then parse.
fn over_the_wire(m: &MlsMessageOut) -> MlsMessageBodyIn {
    let bytes = m.tls_serialize_detached().unwrap();
    MlsMessageIn::tls_deserialize_exact(&bytes).unwrap().extract()
}

fn into_welcome(m: &MlsMessageOut) -> Welcome {
    match over_the_wire(m) {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => panic!("expected a welcome"),
    }
}

fn into_protocol(m: &MlsMessageOut) -> ProtocolMessage {
    match over_the_wire(m) {
        MlsMessageBodyIn::PublicMessage(p) => p.into(),
        MlsMessageBodyIn::PrivateMessage(p) => p.into(),
        _ => panic!("expected a handshake message"),
    }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// Builds an `n`-member group, removes one member, and times each phase in milliseconds.
pub fn run(n: usize) -> String {
    let config = MlsGroupCreateConfig::builder()
        .wire_format_policy(PURE_PLAINTEXT_WIRE_FORMAT_POLICY)
        .ciphersuite(SUITE)
        .build();
    let (cp, cs, ccwk) = identity("creator");
    let mut creator = MlsGroup::new(&cp, &cs, &config, ccwk).unwrap();

    let t = Instant::now();
    let others: Vec<_> = (1..n)
        .map(|i| {
            let (p, s, cwk) = identity(&format!("m{i}"));
            let kp = KeyPackage::builder().build(SUITE, &p, &s, cwk).unwrap();
            (p, kp)
        })
        .collect();
    let keygen = ms(t);

    let kps: Vec<KeyPackage> = others.iter().map(|(_, kp)| kp.key_package().clone()).collect();
    let t = Instant::now();
    let (_commit, welcome, _) = creator.add_members(&cp, &cs, &kps).unwrap();
    creator.merge_pending_commit(&cp).unwrap();
    let add_commit = ms(t);

    let welcome = into_welcome(&welcome);
    let (m1_provider, _) = &others[0];
    let t = Instant::now();
    let mut m1 = StagedWelcome::new_from_welcome(
        m1_provider,
        config.join_config(),
        welcome,
        Some(creator.export_ratchet_tree().into()),
    )
    .unwrap()
    .into_group(m1_provider)
    .unwrap();
    let join = ms(t);

    // The re-key event: remove the last member, then another member processes the commit.
    let t = Instant::now();
    let (commit, _, _) = creator
        .remove_members(&cp, &cs, &[LeafNodeIndex::new((n - 1) as u32)])
        .unwrap();
    creator.merge_pending_commit(&cp).unwrap();
    let remove_commit = ms(t);

    let t = Instant::now();
    let processed = m1
        .process_message(m1_provider, into_protocol(&commit))
        .unwrap();
    if let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() {
        m1.merge_staged_commit(m1_provider, *staged).unwrap();
    } else {
        panic!("expected a commit");
    }
    let process_commit = ms(t);

    let _ = m1_provider.storage();
    format!(
        "{{\"members\":{n},\"keygen_ms\":{keygen:.1},\"add_commit_ms\":{add_commit:.1},\"join_ms\":{join:.1},\"remove_commit_ms\":{remove_commit:.1},\"process_commit_ms\":{process_commit:.1},\"rekey_total_ms\":{:.1}}}",
        remove_commit + process_commit
    )
}

#[wasm_bindgen]
pub fn run_rekey(n: u32) -> String {
    run(n as usize)
}

#[cfg(test)]
mod tests {
    #[test]
    fn small_group_rekeys() {
        let out = super::run(8);
        assert!(out.contains("rekey_total_ms"), "{out}");
    }
}

#[cfg(test)]
mod baseline {
    #[test]
    fn native_256() {
        println!("NATIVE {}", super::run(256));
    }
}
