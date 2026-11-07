//! Every request body is hostile until it passes here (Constitution X): a size cap before
//! parsing, a JSON depth limit, then the strict schema from `contracts-schema/`. Errors never
//! repeat what the client sent.

use super::schemas::SCHEMAS;
use axum::body::{Body, to_bytes};
use jsonschema::Validator;
use serde_json::Value;
use std::{collections::HashMap, fmt, sync::OnceLock};

/// Default cap for a JSON request body.
const MAX_BODY_BYTES: usize = 256 * 1024;
/// A Backup can be 8 MiB; base64 makes it about a third larger.
const MAX_BACKUP_BODY_BYTES: usize = 12 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum ValidationError {
    TooLarge,
    NotJson,
    Invalid,
    UnknownSchema,
    Internal,
}

impl ValidationError {
    /// The `code` to return in an `error-response`.
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooLarge => "too_large",
            _ => "invalid_request",
        }
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "request body is too large",
            Self::NotJson => "request body is not valid JSON",
            Self::Invalid => "request body does not match the schema",
            Self::UnknownSchema => "unknown schema",
            Self::Internal => "validation is unavailable",
        })
    }
}

type Registry = HashMap<&'static str, Validator>;

fn registry() -> Option<&'static Registry> {
    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(build_registry).as_ref()
}

fn build_registry() -> Option<Registry> {
    let mut all = HashMap::new();
    for (name, text) in SCHEMAS {
        let schema: Value = serde_json::from_str(text).ok()?;
        all.insert(*name, jsonschema::validator_for(&schema).ok()?);
    }
    Some(all)
}

fn limit_for(name: &str) -> usize {
    if name == "backup-put-request" {
        MAX_BACKUP_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    }
}

/// Validates raw bytes against the named schema and returns the parsed value.
pub fn validate(name: &str, bytes: &[u8]) -> Result<Value, ValidationError> {
    if bytes.len() > limit_for(name) {
        return Err(ValidationError::TooLarge);
    }
    let registry = registry().ok_or(ValidationError::Internal)?;
    let validator = registry.get(name).ok_or(ValidationError::UnknownSchema)?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ValidationError::NotJson)?;
    if validator.is_valid(&value) {
        Ok(value)
    } else {
        Err(ValidationError::Invalid)
    }
}

/// Reads a request body without ever holding more than the cap, then validates it.
pub async fn read_validated(body: Body, name: &str) -> Result<Value, ValidationError> {
    let limit = limit_for(name);
    let bytes = to_bytes(body, limit)
        .await
        .map_err(|_| ValidationError::TooLarge)?;
    validate(name, &bytes)
}
