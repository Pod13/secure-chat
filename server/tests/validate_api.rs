#![allow(clippy::unwrap_used)]

use axum::body::Body;
use server::api::schemas::SCHEMAS;
use server::api::validate::{ValidationError, read_validated, validate};
use std::{collections::BTreeSet, fs, path::PathBuf};

fn example(name: &str) -> String {
    let text = SCHEMAS.iter().find(|(n, _)| *n == name).unwrap().1;
    let schema: serde_json::Value = serde_json::from_str(text).unwrap();
    schema["examples"][0].to_string()
}

#[test]
fn the_embedded_list_matches_the_schema_directory() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contracts-schema");
    let on_disk: BTreeSet<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| {
            e.unwrap()
                .path()
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
        })
        .collect();
    let embedded: BTreeSet<String> = SCHEMAS.iter().map(|(n, _)| (*n).to_string()).collect();
    assert_eq!(on_disk, embedded, "regenerate server/src/api/schemas.rs");
}

#[test]
fn every_schema_accepts_its_own_example() {
    for (name, _) in SCHEMAS {
        assert!(validate(name, example(name).as_bytes()).is_ok(), "{name}");
    }
}

#[test]
fn a_body_over_the_cap_is_refused_before_parsing() {
    let big = vec![b'x'; 256 * 1024 + 1];
    assert_eq!(
        validate("deliver-request", &big),
        Err(ValidationError::TooLarge)
    );
}

#[test]
fn a_backup_may_be_larger_than_other_bodies() {
    let big = vec![b'x'; 300 * 1024];
    assert_eq!(
        validate("backup-put-request", &big),
        Err(ValidationError::NotJson)
    );
}

#[test]
fn garbage_and_deeply_nested_json_are_refused() {
    assert_eq!(
        validate("deliver-request", b"not json"),
        Err(ValidationError::NotJson)
    );
    assert_eq!(
        validate("deliver-request", &[0xff, 0xfe]),
        Err(ValidationError::NotJson)
    );
    let deep = format!("{}{}", "[".repeat(5_000), "]".repeat(5_000));
    assert_eq!(
        validate("deliver-request", deep.as_bytes()),
        Err(ValidationError::NotJson)
    );
}

#[test]
fn a_well_formed_body_with_the_wrong_shape_is_invalid() {
    let wrong = example("deliver-request").replace("ciphertext", "ciphertexts");
    assert_eq!(
        validate("deliver-request", wrong.as_bytes()),
        Err(ValidationError::Invalid)
    );
}

#[test]
fn an_unknown_schema_name_is_refused() {
    assert_eq!(
        validate("no-such-schema", b"{}"),
        Err(ValidationError::UnknownSchema)
    );
}

#[test]
fn errors_never_repeat_what_the_client_sent() {
    let secret = "SUPER-SECRET-MARKER";
    let body = format!(r#"{{"token":"{secret}","ciphertext":"A","extra":"{secret}"}}"#);
    let err = validate("deliver-request", body.as_bytes()).unwrap_err();
    assert!(!err.to_string().contains(secret) && !format!("{err:?}").contains(secret));
}

#[test]
fn errors_map_to_the_published_error_codes() {
    assert_eq!(ValidationError::TooLarge.code(), "too_large");
    for e in [
        ValidationError::NotJson,
        ValidationError::Invalid,
        ValidationError::UnknownSchema,
    ] {
        assert_eq!(e.code(), "invalid_request");
    }
    assert_eq!(
        ValidationError::Internal.to_string(),
        "validation is unavailable"
    );
}

#[tokio::test]
async fn reading_a_body_stops_at_the_cap() {
    let big = Body::from(vec![b'x'; 256 * 1024 + 1]);
    assert_eq!(
        read_validated(big, "deliver-request").await,
        Err(ValidationError::TooLarge)
    );
    let ok = Body::from(example("deliver-request"));
    assert!(read_validated(ok, "deliver-request").await.is_ok());
}
