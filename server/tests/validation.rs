//! Security tests for network input (Constitution X): every schema in `contracts-schema/` must
//! reject oversized, unknown-field, missing-field, wrong-type and malformed input, and must put
//! a size limit on every string and array. Attack cases are derived from each schema itself, so a
//! new schema is covered automatically.

// Test code may unwrap: a failed setup should fail the test loudly.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use jsonschema::Validator;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

struct Case {
    name: String,
    schema: Value,
    validator: Validator,
    example: Value,
}

fn load_all() -> Vec<Case> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contracts-schema");
    let mut cases = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "json") {
            let schema: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            let validator = jsonschema::validator_for(&schema).unwrap();
            let example = schema["examples"][0].clone();
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            cases.push(Case {
                name,
                schema,
                validator,
                example,
            });
        }
    }
    cases
}

fn with(example: &Value, key: &str, value: Value) -> Value {
    let mut copy = example.clone();
    copy[key] = value;
    copy
}

fn properties(case: &Case) -> Vec<(String, Value)> {
    let props = case.schema["properties"].as_object().unwrap();
    props.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Returns an invalid replacement for the property, or none when it has no limit to break.
fn oversize(spec: &Value) -> Vec<Value> {
    let mut bad = Vec::new();
    if let Some(max) = spec["maxLength"].as_u64() {
        bad.push(json!("A".repeat(usize::try_from(max).unwrap() + 1)));
    }
    if spec["pattern"].is_string() {
        bad.push(json!("not base64url !!"));
    }
    if let Some(max) = spec["maxItems"].as_u64() {
        let item = spec["items"]["type"].clone();
        let filler = if item == "string" {
            json!("A")
        } else {
            json!({})
        };
        bad.push(Value::Array(vec![
            filler;
            usize::try_from(max).unwrap() + 1
        ]));
    }
    if let Some(max) = spec["maximum"].as_i64() {
        bad.push(json!(max + 1));
    }
    if let Some(min) = spec["minimum"].as_i64() {
        bad.push(json!(min - 1));
    }
    if spec["enum"].is_array() {
        bad.push(json!("not-an-allowed-value"));
    }
    bad
}

fn walk(value: &Value, found: &mut Vec<String>, path: &str) {
    if value["type"] == "string" && value["maxLength"].is_null() && value["enum"].is_null() {
        found.push(format!("{path}: string without maxLength"));
    }
    if value["type"] == "array" && value["maxItems"].is_null() {
        found.push(format!("{path}: array without maxItems"));
    }
    if let Some(props) = value["properties"].as_object() {
        for (key, child) in props {
            walk(child, found, &format!("{path}.{key}"));
        }
    }
    if value["items"].is_object() {
        walk(&value["items"], found, &format!("{path}[]"));
    }
}

#[test]
fn every_schema_is_found_and_accepts_its_own_example() {
    let cases = load_all();
    assert!(
        cases.len() >= 34,
        "expected at least 34 schemas, found {}",
        cases.len()
    );
    for c in &cases {
        assert!(
            c.validator.is_valid(&c.example),
            "{}: its own example is rejected",
            c.name
        );
    }
}

#[test]
fn every_string_and_array_has_a_size_limit() {
    let mut found = Vec::new();
    for c in load_all() {
        walk(&c.schema, &mut found, &c.name);
    }
    assert!(found.is_empty(), "unbounded fields: {found:#?}");
}

#[test]
fn unknown_fields_are_rejected() {
    for c in load_all() {
        let bad = with(&c.example, "zz_unknown", json!(1));
        assert!(
            !c.validator.is_valid(&bad),
            "{}: accepted an unknown field",
            c.name
        );
    }
}

#[test]
fn missing_required_fields_are_rejected() {
    for c in load_all() {
        for key in c.schema["required"].as_array().unwrap() {
            let mut bad = c.example.clone();
            bad.as_object_mut().unwrap().remove(key.as_str().unwrap());
            assert!(
                !c.validator.is_valid(&bad),
                "{}: accepted without {key}",
                c.name
            );
        }
    }
}

#[test]
fn oversized_and_malformed_values_are_rejected() {
    for c in load_all() {
        for (key, spec) in properties(&c) {
            for bad in oversize(&spec) {
                let doc = with(&c.example, &key, bad.clone());
                let shown = bad.to_string();
                assert!(
                    !c.validator.is_valid(&doc),
                    "{}.{key} accepted {:.60}",
                    c.name,
                    shown
                );
            }
        }
    }
}

#[test]
fn wrong_types_and_non_objects_are_rejected() {
    for c in load_all() {
        for (key, _) in properties(&c) {
            for bad in [json!(null), json!([]), json!({}), json!(true)] {
                let doc = with(&c.example, &key, bad);
                assert!(
                    !c.validator.is_valid(&doc),
                    "{}.{key} accepted a wrong type",
                    c.name
                );
            }
        }
        for bad in [json!(null), json!([]), json!("text"), json!(7)] {
            assert!(
                !c.validator.is_valid(&bad),
                "{}: accepted a non-object",
                c.name
            );
        }
    }
}
