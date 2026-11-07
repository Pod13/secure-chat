//! Invites: possession of an unexpired, unrevoked Invite token with uses left is the only way in
//! (registration is invite-only). Only the token's hash is stored. The server records who made
//! an Invite (so they can revoke it) but never who used it.

use super::{AccountId, Hash, StoreError, sha256, short_id, signed};
use crate::ports::{Clock, Random};
use sqlx::PgPool;

/// The longest an Invite may live.
pub const MAX_LIFETIME_SECS: u64 = 90 * 24 * 60 * 60;
/// Most live Invites one Account may have, so Invites cannot be used to flood the system.
pub const MAX_ACTIVE_PER_OWNER: i64 = 100;
pub const MAX_USES: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Service,
    Contact,
    Group,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Service => "service",
            Self::Contact => "contact",
            Self::Group => "group",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "service" => Some(Self::Service),
            "contact" => Some(Self::Contact),
            "group" => Some(Self::Group),
            _ => None,
        }
    }
}

pub struct NewInvite {
    /// `None` for operator seed Invites, which may only be of kind `Service`.
    pub owner: Option<AccountId>,
    pub kind: Kind,
    pub expires_at: u64,
    pub max_uses: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CreateError {
    /// Bad lifetime, use count, owner/kind combination, or too many live Invites.
    Invalid,
    Store,
}

impl From<sqlx::Error> for CreateError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}

pub struct Created {
    /// The secret to share. Shown once; only its hash is kept.
    pub token: [u8; 32],
    pub id: [u8; 16],
}

fn acceptable(new: &NewInvite, now: u64) -> bool {
    let owner_ok = new.owner.is_some() || new.kind == Kind::Service;
    let lifetime_ok = new.expires_at > now && new.expires_at <= now + MAX_LIFETIME_SECS;
    owner_ok && lifetime_ok && (1..=MAX_USES).contains(&new.max_uses)
}

async fn live_count(pool: &PgPool, owner: &AccountId, now: i64) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT count(*) FROM invites WHERE owner_account_id = $1 AND NOT revoked \
         AND uses < max_uses AND expires_at > to_timestamp($2::bigint)",
    )
    .bind(owner.as_slice())
    .bind(now)
    .fetch_one(pool)
    .await
}

pub async fn create(
    pool: &PgPool,
    clock: &impl Clock,
    random: &impl Random,
    new: NewInvite,
) -> Result<Created, CreateError> {
    let now = clock.now_secs();
    if !acceptable(&new, now) {
        return Err(CreateError::Invalid);
    }
    let now_i = signed(now).map_err(|_| CreateError::Store)?;
    if let Some(owner) = &new.owner
        && live_count(pool, owner, now_i).await? >= MAX_ACTIVE_PER_OWNER
    {
        return Err(CreateError::Invalid);
    }
    let mut token = [0u8; 32];
    random.fill(&mut token);
    let hash = sha256(&token);
    sqlx::query(
        "INSERT INTO invites (token_hash, kind, owner_account_id, expires_at, max_uses) \
         VALUES ($1, $2, $3, to_timestamp($4::bigint), $5)",
    )
    .bind(hash.as_slice())
    .bind(new.kind.as_str())
    .bind(new.owner.as_ref().map(|o| o.as_slice()))
    .bind(signed(new.expires_at).map_err(|_| CreateError::Store)?)
    .bind(i32::try_from(new.max_uses).map_err(|_| CreateError::Invalid)?)
    .execute(pool)
    .await?;
    Ok(Created {
        token,
        id: short_id(&hash),
    })
}

/// Revokes one of the owner's Invites. `false` if there is no such Invite of theirs.
pub async fn revoke(pool: &PgPool, owner: &AccountId, id: &[u8; 16]) -> Result<bool, StoreError> {
    let done = sqlx::query(
        "UPDATE invites SET revoked = true WHERE owner_account_id = $1 AND substring(token_hash from 1 for 16) = $2",
    )
    .bind(owner.as_slice())
    .bind(id.as_slice())
    .execute(pool)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// Uses one slot of a live Invite of the given kinds, inside the caller's transaction. Returns
/// the owner (if any) or `None` when the Invite is unknown, expired, revoked, used up or of the
/// wrong kind: the caller cannot tell which, and neither can anyone probing.
pub async fn consume(
    conn: &mut sqlx::PgConnection,
    token_hash: &Hash,
    kinds: &[&str],
    now: u64,
) -> Result<Option<Option<AccountId>>, StoreError> {
    let kinds: Vec<String> = kinds.iter().map(|k| (*k).to_string()).collect();
    let row: Option<(Option<Vec<u8>>,)> = sqlx::query_as(
        "UPDATE invites SET uses = uses + 1 WHERE token_hash = $1 AND kind = ANY($2) AND NOT revoked \
         AND uses < max_uses AND expires_at > to_timestamp($3::bigint) RETURNING owner_account_id",
    )
    .bind(token_hash.as_slice())
    .bind(&kinds)
    .bind(signed(now)?)
    .fetch_optional(conn)
    .await?;
    row.map(|(owner,)| {
        owner
            .map(|o| o.try_into().map_err(|_| StoreError))
            .transpose()
    })
    .transpose()
}
