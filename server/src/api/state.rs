//! Shared state for the HTTP handlers, and the small helpers every handler uses.

use super::error::ApiError;
use super::tls::Peer;
use super::validate::read_validated;
use crate::abuse::limits::{Bucket, Kind, Refused, check};
use crate::abuse::pg::PgLimitStore;
use crate::accounts::Hash;
use crate::auth::{AuthError, DeviceId, authenticate, pg::PgAuthStore};
use crate::delivery::queue::PgQueue;
use crate::logging::TruncatedIp;
use crate::ports::{DynClock, DynRandom};
use axum::extract::{ConnectInfo, Request};
use axum::http::{header::AUTHORIZATION, request::Parts};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use sqlx::PgPool;
use std::{
    net::{IpAddr, Ipv4Addr},
    sync::Arc,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub clock: DynClock,
    pub random: DynRandom,
    pub queue: Arc<PgQueue<DynClock>>,
    pub session_ttl_secs: u64,
}

impl AppState {
    pub fn new(pool: PgPool, clock: DynClock, random: DynRandom, session_ttl_secs: u64) -> Self {
        let queue = Arc::new(PgQueue::new(pool.clone(), Arc::new(clock.clone())));
        Self {
            pool,
            clock,
            random,
            queue,
            session_ttl_secs,
        }
    }

    pub fn auth_store(&self) -> PgAuthStore {
        PgAuthStore::new(self.pool.clone())
    }

    /// Counts a request against a limit; refuses with 429 (or 500 if counting itself fails).
    pub async fn limit(&self, kind: Kind, bucket: &Bucket) -> Result<(), ApiError> {
        check(
            &PgLimitStore::new(self.pool.clone()),
            &self.clock,
            kind,
            bucket,
        )
        .await
        .map_err(|refused| match refused {
            Refused::TooMany { retry_after } => ApiError::TooMany(retry_after),
            Refused::Unavailable => ApiError::Internal,
        })
    }

    pub async fn limit_ip(&self, kind: Kind, parts: &Parts) -> Result<(), ApiError> {
        self.limit(kind, &Bucket::for_ip(kind, &client_ip(parts)))
            .await
    }

    /// Checks the bearer token and names the Device it belongs to.
    pub async fn device(&self, parts: &Parts) -> Result<DeviceId, ApiError> {
        let token = bearer(parts).ok_or(ApiError::Unauthorized)?;
        authenticate(&self.auth_store(), &self.clock, &token)
            .await
            .map_err(|e| match e {
                AuthError::Unauthorized => ApiError::Unauthorized,
                AuthError::Store => ApiError::Internal,
            })
    }
}

/// The caller's address with the host part removed. Without connection info (tests), one shared
/// bucket is used.
pub fn client_ip(parts: &Parts) -> TruncatedIp {
    let ip = parts
        .extensions
        .get::<ConnectInfo<Peer>>()
        .map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), |info| info.0.0.ip());
    TruncatedIp::new(ip)
}

fn bearer(parts: &Parts) -> Option<[u8; 32]> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    decode_fixed(value.strip_prefix("Bearer ")?)
}

/// Decodes unpadded base64url that must be exactly `N` bytes.
pub fn decode_fixed<const N: usize>(text: &str) -> Option<[u8; N]> {
    URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()
}

pub fn decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Reads and validates a JSON body against the named schema.
pub async fn read_json(req: Request, schema: &str) -> Result<(Parts, Value), ApiError> {
    let (parts, body) = req.into_parts();
    let value = read_validated(body, schema).await?;
    Ok((parts, value))
}

/// A string field already checked by the schema, decoded to exactly `N` bytes.
pub fn field<const N: usize>(value: &Value, name: &str) -> Result<[u8; N], ApiError> {
    value[name]
        .as_str()
        .and_then(decode_fixed)
        .ok_or(ApiError::Invalid)
}

/// A string field decoded to bytes, at most `max` long.
pub fn field_bytes(value: &Value, name: &str, max: usize) -> Result<Vec<u8>, ApiError> {
    let bytes = value[name]
        .as_str()
        .and_then(decode)
        .ok_or(ApiError::Invalid)?;
    if bytes.is_empty() || bytes.len() > max {
        Err(ApiError::Invalid)
    } else {
        Ok(bytes)
    }
}

pub fn field_list(value: &Value, name: &str, max: usize) -> Result<Vec<Vec<u8>>, ApiError> {
    let items = value[name].as_array().ok_or(ApiError::Invalid)?;
    items
        .iter()
        .map(|item| {
            let bytes = item.as_str().and_then(decode).ok_or(ApiError::Invalid)?;
            if bytes.is_empty() || bytes.len() > max {
                Err(ApiError::Invalid)
            } else {
                Ok(bytes)
            }
        })
        .collect()
}

pub fn hash_of(bytes: &[u8]) -> Hash {
    crate::accounts::sha256(bytes)
}
