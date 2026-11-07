//! Scheduled deletion (Constitution V, IV): every kind of stored data has a lifetime in the
//! Data Inventory, and this module enforces each one. A test checks that no table can be added
//! without either a rule here or an explicit, reasoned exemption.

use crate::ports::Clock;
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};

/// One deletion rule. `$1` is the current time in seconds since the epoch.
pub struct Rule {
    pub table: &'static str,
    pub sql: &'static str,
}

pub const RULES: [Rule; 8] = [
    Rule {
        table: "abuse_counters",
        sql: "DELETE FROM abuse_counters WHERE window_start < to_timestamp($1::bigint) - interval '7 days'",
    },
    Rule {
        table: "invites",
        sql: "DELETE FROM invites WHERE expires_at < to_timestamp($1::bigint) - interval '30 days'",
    },
    Rule {
        table: "key_packages",
        sql: "DELETE FROM key_packages WHERE NOT last_resort AND created_on < (to_timestamp($1::bigint) AT TIME ZONE 'UTC')::date - 30",
    },
    Rule {
        table: "audit_log",
        sql: "DELETE FROM audit_log WHERE at < to_timestamp($1::bigint) - interval '365 days'",
    },
    Rule {
        table: "envelopes",
        sql: "DELETE FROM envelopes WHERE expires_at <= to_timestamp($1::bigint)",
    },
    Rule {
        table: "link_requests",
        sql: "DELETE FROM link_requests WHERE expires_at <= to_timestamp($1::bigint)",
    },
    Rule {
        table: "auth_nonces",
        sql: "DELETE FROM auth_nonces WHERE expires_at <= to_timestamp($1::bigint)",
    },
    Rule {
        table: "sessions",
        sql: "DELETE FROM sessions WHERE expires_at <= to_timestamp($1::bigint)",
    },
];

/// Tables that have no time-based rule, and why. Anything not here and not in `RULES` fails the
/// completeness test.
pub const EXEMPT: [(&str, &str); 5] = [
    ("_sqlx_migrations", "schema history, holds no user data"),
    ("accounts", "kept until the account is deleted"),
    (
        "devices",
        "kept until the Device is unlinked; deleting a Device cascades to its data",
    ),
    (
        "delivery_tokens",
        "kept until revoked or the Device is unlinked (cascade)",
    ),
    (
        "backups",
        "kept until replaced or the account is deleted (cascade)",
    ),
];

/// Tables whose rows point at stored objects. Their expiry belongs to the module that owns the
/// objects, which must delete the object before the row.
pub const OWNED_ELSEWHERE: [(&str, &str); 1] = [(
    "blobs",
    "the blob module deletes the stored object first (task T122)",
)];

#[derive(Debug, PartialEq, Eq)]
pub struct RetentionError;

pub struct Retention<C: Clock> {
    pool: PgPool,
    clock: Arc<C>,
}

impl<C: Clock + Send + Sync + 'static> Retention<C> {
    pub fn new(pool: PgPool, clock: Arc<C>) -> Self {
        Self { pool, clock }
    }

    /// Applies every rule once. Returns how many rows each rule deleted.
    pub async fn run_once(&self) -> Result<Vec<(&'static str, u64)>, RetentionError> {
        let now = i64::try_from(self.clock.now_secs()).map_err(|_| RetentionError)?;
        let mut report = Vec::new();
        for rule in &RULES {
            let done = sqlx::query(rule.sql)
                .bind(now)
                .execute(&self.pool)
                .await
                .map_err(|_| RetentionError)?;
            report.push((rule.table, done.rows_affected()));
        }
        Ok(report)
    }

    /// Runs the rules every `period` until the task is dropped. A failed run is retried next time.
    pub async fn run_forever(&self, period: Duration) {
        let mut ticker = tokio::time::interval(period);
        loop {
            ticker.tick().await;
            let _ = self.run_once().await;
        }
    }
}
