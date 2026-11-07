//! Rate limiting that never looks at message content (Constitution: Authentication & sessions).
//!
//! Hits are counted in fixed windows per bucket. A bucket is named by a truncated IP address or
//! by a token hash prefix, never by a full address or an account. A fixed window can allow up
//! to twice the limit across a window boundary; that is accepted for its simplicity. If storage
//! fails the request is refused (fail closed).

use crate::logging::TruncatedIp;
use crate::ports::Clock;
use std::future::Future;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub max_hits: u32,
    pub window_secs: u64,
}

/// What is being limited. Each kind has its own rule and its own counters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Signup,
    Login,
    InviteCreate,
    DeliverToken,
    DeliverRecipient,
    KeyPackageFetch,
    InviteRedeem,
    BlobUpload,
    Recovery,
}

impl Kind {
    pub fn rule(self) -> Rule {
        let (max_hits, window_secs) = match self {
            Self::Signup => (5, 3600),
            Self::Login => (20, 60),
            Self::InviteCreate => (30, 3600),
            Self::DeliverToken => (60, 60),
            Self::DeliverRecipient => (600, 60),
            Self::KeyPackageFetch => (20, 3600),
            Self::InviteRedeem => (30, 3600),
            Self::BlobUpload => (20, 3600),
            Self::Recovery => (5, 3600),
        };
        Rule {
            max_hits,
            window_secs,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Signup => "signup",
            Self::Login => "login",
            Self::InviteCreate => "invite",
            Self::DeliverToken => "dtoken",
            Self::DeliverRecipient => "drecip",
            Self::KeyPackageFetch => "kpfetch",
            Self::InviteRedeem => "redeem",
            Self::BlobUpload => "blob",
            Self::Recovery => "recover",
        }
    }
}

/// A counter name. Built only from a truncated IP or a hash prefix, and at most 64 characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bucket(String);

impl Bucket {
    pub fn for_ip(kind: Kind, ip: &TruncatedIp) -> Self {
        Self(format!("{}:ip:{}", kind.label(), ip.as_str()))
    }

    /// `hash` is a token or recipient hash; only its first 16 bytes name the bucket.
    pub fn for_hash(kind: Kind, hash: &[u8; 32]) -> Self {
        let hex: String = hash[..16].iter().map(|b| format!("{b:02x}")).collect();
        Self(format!("{}:h:{hex}", kind.label()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct StoreError;

pub trait LimitStore {
    /// Adds one hit to the bucket's window and returns the new total, atomically.
    fn hit(
        &self,
        bucket: &Bucket,
        window_start: u64,
    ) -> impl Future<Output = Result<u32, StoreError>> + Send;
    /// Deletes counters from windows that started before `before`.
    fn purge_before(&self, before: u64) -> impl Future<Output = Result<u64, StoreError>> + Send;
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Over the limit; try again after this many seconds.
    TooMany { retry_after: u64 },
    /// Storage failed; refuse rather than allow unlimited requests.
    Unavailable,
}

/// Counts one request against the bucket and says whether it may go ahead.
pub async fn check(
    store: &impl LimitStore,
    clock: &impl Clock,
    kind: Kind,
    bucket: &Bucket,
) -> Result<(), Refused> {
    let rule = kind.rule();
    let now = clock.now_secs();
    let window_start = now - now % rule.window_secs;
    let hits = store
        .hit(bucket, window_start)
        .await
        .map_err(|_| Refused::Unavailable)?;
    if hits > rule.max_hits {
        return Err(Refused::TooMany {
            retry_after: window_start + rule.window_secs - now,
        });
    }
    Ok(())
}
