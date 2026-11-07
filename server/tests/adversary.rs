//! Self-tests for the server-adversary harness: it must catch leaks and stay quiet on clean
//! data. Feature tests (user stories) use `common::assert_nothing_leaked` on real dumps.

mod common;

use common::{Artifact, STD, URL, artifact, assert_nothing_leaked, base64, scan, secret};

const PLAINTEXT: &[u8] = b"meet me at the old bridge at noon";

fn leaks_as(artifacts: &[Artifact]) -> Vec<&'static str> {
    let p = [secret("message", PLAINTEXT)];
    scan(artifacts, &p)
        .into_iter()
        .map(|f| f.encoding)
        .collect()
}

#[test]
fn base64_encoder_matches_the_rfc_4648_vectors() {
    let cases: [(&[u8], &str); 4] = [
        (b"", ""),
        (b"f", "Zg=="),
        (b"fo", "Zm8="),
        (b"foobar", "Zm9vYmFy"),
    ];
    for (input, expected) in cases {
        assert_eq!(base64(input, STD, true), expected);
    }
    assert_eq!(base64(&[0xfb, 0xff], STD, true), "+/8=");
    assert_eq!(base64(&[0xfb, 0xff], URL, false), "-_8");
}

#[test]
fn clean_data_has_no_findings() {
    let clean = [
        artifact("db", b"account 42 created 2026-11-07"),
        artifact("log", b"GET /healthz 200"),
    ];
    assert_nothing_leaked(&clean, &[secret("message", PLAINTEXT)]);
}

#[test]
fn finds_raw_plaintext_and_names_the_source() {
    let a = [artifact(
        "log:requests",
        b"body=meet me at the old bridge at noon&x=1",
    )];
    let found = scan(&a, &[secret("message", PLAINTEXT)]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].source, "log:requests");
    assert_eq!(found[0].secret, "message");
}

#[test]
fn finds_hex_in_either_case() {
    let lower: String = PLAINTEXT.iter().map(|b| format!("{b:02x}")).collect();
    let upper = lower.to_uppercase();
    assert_eq!(leaks_as(&[artifact("db", lower.as_bytes())]), ["hex"]);
    assert_eq!(leaks_as(&[artifact("db", upper.as_bytes())]), ["HEX"]);
}

#[test]
fn finds_base64_at_every_alignment() {
    for lead in 0..3 {
        let mut message = vec![b'x'; lead];
        message.extend_from_slice(PLAINTEXT);
        message.extend_from_slice(b"yz");
        let std = base64(&message, STD, true);
        let url = base64(&message, URL, false);
        assert!(
            leaks_as(&[artifact("blob", std.as_bytes())]).contains(&"base64"),
            "std lead {lead}"
        );
        assert!(
            leaks_as(&[artifact("blob", url.as_bytes())]).contains(&"base64url"),
            "url lead {lead}"
        );
    }
}

#[test]
fn finds_private_key_markers() {
    let a = [artifact("config", b"key=-----BEGIN PRIVATE KEY-----\nMIIE")];
    let found = scan(&a, &[]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].secret, "-----BEGIN PRIVATE KEY-----");
}

#[test]
fn an_unrelated_secret_is_not_reported() {
    let a = [artifact("db", b"some other row entirely")];
    assert!(scan(&a, &[secret("other", b"a completely different secret")]).is_empty());
}

#[test]
#[should_panic(expected = "too short")]
fn refuses_secrets_too_short_to_scan_for() {
    scan(&[], &[secret("tiny", b"abc")]);
}

#[test]
#[should_panic(expected = "the server can see secrets")]
fn assert_nothing_leaked_fails_when_something_leaks() {
    assert_nothing_leaked(
        &[artifact("db", PLAINTEXT)],
        &[secret("message", PLAINTEXT)],
    );
}
