//! The HTTP endpoints of `contracts/http-api.md` for accounts, login, Invites, delivery tokens,
//! sealed-sender delivery and key packages. Handlers only translate between HTTP and the modules
//! that hold the rules. Anonymous endpoints (deliver, key-packages/fetch, invites/redeem) take no
//! account credentials and record nothing about the caller.

use super::error::ApiError;
use super::state::{AppState, decode_fixed, encode, field, field_bytes, field_list, hash_of};
use crate::abuse::limits::{Bucket, Kind};
use crate::accounts::{
    AccountId, DeviceId,
    invites::{self, CreateError, NewInvite},
    keypackages::{self, AddError},
    redeem::{self, RedeemError},
    signup::{self, NewAccount, SignupError},
};
use crate::auth::{AuthError, finish_login, start_login};
use crate::delivery::sealed::{self, MintError};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

const MAX_KEY_PACKAGE: usize = 4096;
const MAX_LABEL: usize = 1024;
/// Largest ciphertext a sender may queue (matches the `envelopes` table).
pub const MAX_CIPHERTEXT: usize = 131_072;

type Reply = Result<Response, ApiError>;

fn json_reply(status: StatusCode, body: &Value) -> Response {
    let mut response = (status, body.to_string()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

impl AppState {
    /// Splits the request, applies the optional per-IP limit first, then validates the body.
    async fn read(
        &self,
        req: Request,
        schema: &str,
        limit: Option<Kind>,
    ) -> Result<(axum::http::request::Parts, Value), ApiError> {
        let (parts, body) = req.into_parts();
        if let Some(kind) = limit {
            self.limit_ip(kind, &parts).await?;
        }
        let value = super::validate::read_validated(body, schema).await?;
        Ok((parts, value))
    }

    async fn account_of(&self, device: &DeviceId) -> Result<AccountId, ApiError> {
        let row: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT account_id FROM devices WHERE device_id = $1")
                .bind(device.as_slice())
                .fetch_optional(&self.pool)
                .await
                .map_err(|_| ApiError::Internal)?;
        row.and_then(|id| id.try_into().ok())
            .ok_or(ApiError::Unauthorized)
    }
}

pub async fn create_account(State(s): State<AppState>, req: Request) -> Reply {
    let (_, v) = s
        .read(req, "account-create-request", Some(Kind::Signup))
        .await?;
    let invite: [u8; 32] = field(&v, "invite_token")?;
    let new = NewAccount {
        invite_hash: hash_of(&invite),
        identity_key: field(&v, "identity_public_key")?,
        device_key: field(&v, "device_public_key")?,
        certificate: field(&v, "device_certificate")?,
        key_packages: field_list(&v, "key_packages", MAX_KEY_PACKAGE)?,
        last_resort: field_bytes(&v, "last_resort_key_package", MAX_KEY_PACKAGE)?,
        label: field_bytes(&v, "label_blob", MAX_LABEL)?,
    };
    match signup::create(&s.pool, &s.clock, &s.random, new).await {
        Ok((account, device)) => Ok(json_reply(
            StatusCode::CREATED,
            &json!({"account_id": encode(&account), "device_id": encode(&device)}),
        )),
        Err(SignupError::InvalidInvite) => Err(ApiError::Unauthorized),
        Err(SignupError::BadCertificate | SignupError::TooManyKeyPackages) => {
            Err(ApiError::Invalid)
        }
        Err(SignupError::Duplicate) => Err(ApiError::Conflict),
        Err(SignupError::Store) => Err(ApiError::Internal),
    }
}

pub async fn auth_challenge(State(s): State<AppState>, req: Request) -> Reply {
    let (_, v) = s
        .read(req, "auth-challenge-request", Some(Kind::Login))
        .await?;
    let device: DeviceId = field(&v, "device_id")?;
    let nonce = start_login(&s.auth_store(), &s.clock, &s.random, &device)
        .await
        .map_err(|_| ApiError::Internal)?;
    Ok(json_reply(
        StatusCode::OK,
        &json!({"nonce": encode(&nonce)}),
    ))
}

pub async fn auth_token(State(s): State<AppState>, req: Request) -> Reply {
    let (_, v) = s.read(req, "auth-token-request", Some(Kind::Login)).await?;
    let device: DeviceId = field(&v, "device_id")?;
    let signature: [u8; 64] = field(&v, "signature")?;
    let session = finish_login(
        &s.auth_store(),
        &s.clock,
        &s.random,
        s.session_ttl_secs,
        &device,
        &signature,
    )
    .await
    .map_err(|e| match e {
        AuthError::Unauthorized => ApiError::Unauthorized,
        AuthError::Store => ApiError::Internal,
    })?;
    touch_last_connected(&s, &device).await?;
    Ok(json_reply(
        StatusCode::OK,
        &json!({"token": encode(&session.token), "expires_in": session.expires_in}),
    ))
}

/// Records the day (not the time) of the Account's last connection (Data Inventory).
async fn touch_last_connected(s: &AppState, device: &DeviceId) -> Result<(), ApiError> {
    let now =
        i64::try_from(crate::ports::Clock::now_secs(&s.clock)).map_err(|_| ApiError::Internal)?;
    sqlx::query(
        "UPDATE accounts SET last_connected_on = (to_timestamp($1::bigint) AT TIME ZONE 'UTC')::date \
         WHERE account_id = (SELECT account_id FROM devices WHERE device_id = $2)",
    )
    .bind(now)
    .bind(device.as_slice())
    .execute(&s.pool)
    .await
    .map(|_| ())
    .map_err(|_| ApiError::Internal)
}

pub async fn create_invite(State(s): State<AppState>, req: Request) -> Reply {
    let (parts, body) = req.into_parts();
    s.limit_ip(Kind::InviteCreate, &parts).await?;
    let device = s.device(&parts).await?;
    let v = super::validate::read_validated(body, "invite-create-request").await?;
    let kind = v["kind"]
        .as_str()
        .and_then(invites::Kind::parse)
        .ok_or(ApiError::Invalid)?;
    let new = NewInvite {
        owner: Some(s.account_of(&device).await?),
        kind,
        expires_at: v["expires_at"].as_u64().ok_or(ApiError::Invalid)?,
        max_uses: v["max_uses"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(ApiError::Invalid)?,
    };
    match invites::create(&s.pool, &s.clock, &s.random, new).await {
        Ok(made) => Ok(json_reply(
            StatusCode::CREATED,
            &json!({"invite_token": encode(&made.token), "invite_id": encode(&made.id)}),
        )),
        Err(CreateError::Invalid) => Err(ApiError::Invalid),
        Err(CreateError::Store) => Err(ApiError::Internal),
    }
}

pub async fn revoke_invite(
    State(s): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Reply {
    let (parts, _) = req.into_parts();
    let device = s.device(&parts).await?;
    let id: [u8; 16] = decode_fixed(&id).ok_or(ApiError::Invalid)?;
    let owner = s.account_of(&device).await?;
    match invites::revoke(&s.pool, &owner, &id).await {
        Ok(true) => Ok(no_content()),
        Ok(false) => Err(ApiError::NotFound),
        Err(_) => Err(ApiError::Internal),
    }
}

pub async fn create_delivery_token(State(s): State<AppState>, req: Request) -> Reply {
    let (parts, _) = req.into_parts();
    let device = s.device(&parts).await?;
    let mut conn = s.pool.acquire().await.map_err(|_| ApiError::Internal)?;
    match sealed::mint(&mut conn, &s.random, &device).await {
        Ok(minted) => Ok(json_reply(
            StatusCode::CREATED,
            &json!({"token": encode(&minted.token), "token_id": encode(&minted.id)}),
        )),
        Err(MintError::TooMany) => Err(ApiError::Conflict),
        Err(MintError::Store) => Err(ApiError::Internal),
    }
}

pub async fn revoke_delivery_token(
    State(s): State<AppState>,
    Path(id): Path<String>,
    req: Request,
) -> Reply {
    let (parts, _) = req.into_parts();
    let device = s.device(&parts).await?;
    let id: [u8; 16] = decode_fixed(&id).ok_or(ApiError::Invalid)?;
    match sealed::revoke(&s.pool, &device, &id).await {
        Ok(true) => Ok(no_content()),
        Ok(false) => Err(ApiError::NotFound),
        Err(_) => Err(ApiError::Internal),
    }
}

pub async fn deliver(State(s): State<AppState>, req: Request) -> Reply {
    let (_, v) = s.read(req, "deliver-request", None).await?;
    let token: [u8; 32] = field(&v, "token")?;
    let ciphertext = field_bytes(&v, "ciphertext", MAX_CIPHERTEXT)?;
    let token_hash = hash_of(&token);
    s.limit(
        Kind::DeliverToken,
        &Bucket::for_hash(Kind::DeliverToken, &token_hash),
    )
    .await?;
    let device = sealed::recipient_of(&s.pool, &token_hash)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Unauthorized)?;
    s.limit(
        Kind::DeliverRecipient,
        &Bucket::for_hash(Kind::DeliverRecipient, &hash_of(&device)),
    )
    .await?;
    let mut id = [0u8; 16];
    crate::ports::Random::fill(&s.random, &mut id);
    s.queue
        .enqueue(&device, &id, &ciphertext)
        .await
        .map_err(|e| match e {
            crate::delivery::queue::QueueError::Full => ApiError::TooMany(60),
            _ => ApiError::Internal,
        })?;
    Ok(json_reply(
        StatusCode::CREATED,
        &json!({"envelope_id": encode(&id)}),
    ))
}

pub async fn put_key_packages(State(s): State<AppState>, req: Request) -> Reply {
    let (parts, body) = req.into_parts();
    let device = s.device(&parts).await?;
    let v = super::validate::read_validated(body, "key-packages-put-request").await?;
    let packages = field_list(&v, "key_packages", MAX_KEY_PACKAGE)?;
    let last_resort = match v.get("last_resort_key_package") {
        Some(_) => Some(field_bytes(&v, "last_resort_key_package", MAX_KEY_PACKAGE)?),
        None => None,
    };
    let now = crate::ports::Clock::now_secs(&s.clock);
    let mut conn = s.pool.acquire().await.map_err(|_| ApiError::Internal)?;
    match keypackages::add(&mut conn, &device, &packages, last_resort.as_deref(), now).await {
        Ok(()) => Ok(no_content()),
        Err(AddError::TooMany) => Err(ApiError::Conflict),
        Err(AddError::Store) => Err(ApiError::Internal),
    }
}

pub async fn fetch_key_packages(State(s): State<AppState>, req: Request) -> Reply {
    let (_, v) = s.read(req, "key-packages-fetch-request", None).await?;
    let token: [u8; 32] = field(&v, "token")?;
    let token_hash = hash_of(&token);
    s.limit(
        Kind::KeyPackageFetch,
        &Bucket::for_hash(Kind::KeyPackageFetch, &token_hash),
    )
    .await?;
    let device = sealed::recipient_of(&s.pool, &token_hash)
        .await
        .map_err(|_| ApiError::Internal)?
        .ok_or(ApiError::Unauthorized)?;
    let mut conn = s.pool.acquire().await.map_err(|_| ApiError::Internal)?;
    let package = keypackages::take_one(&mut conn, &device)
        .await
        .map_err(|_| ApiError::Internal)?;
    let package = package.ok_or(ApiError::NotFound)?;
    Ok(json_reply(
        StatusCode::OK,
        &json!({"key_packages": [encode(&package)]}),
    ))
}

pub async fn redeem_invite(State(s): State<AppState>, req: Request) -> Reply {
    let (_, v) = s
        .read(req, "invite-redeem-request", Some(Kind::InviteRedeem))
        .await?;
    let token: [u8; 32] = field(&v, "invite_token")?;
    match redeem::redeem(&s.pool, &s.clock, &s.random, &hash_of(&token)).await {
        Ok(devices) => {
            let devices: Vec<Value> = devices
                .iter()
                .map(|d| json!({"delivery_token": encode(&d.delivery_token), "key_packages": [encode(&d.key_package)]}))
                .collect();
            Ok(json_reply(StatusCode::OK, &json!({"devices": devices})))
        }
        Err(RedeemError::InvalidInvite) => Err(ApiError::Unauthorized),
        Err(RedeemError::Store) => Err(ApiError::Internal),
    }
}
