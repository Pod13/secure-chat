//! Every Data Inventory lifetime is enforced, at the exact boundary, and a new table cannot be
//! added without a retention decision. Needs a disposable PostgreSQL (see docs/testing.md).

#![allow(clippy::unwrap_used)]

mod common;
mod fakes;

use common::db::{fresh_pool, insert_device};
use fakes::SharedClock;
use server::retention::{EXEMPT, OWNED_ELSEWHERE, RULES, Retention};
use sqlx::PgPool;
use std::{collections::BTreeSet, sync::Arc, time::Duration};

const NOW: i64 = 1_900_000_000;
const DAY: i64 = 86_400;

async fn exec(pool: &PgPool, sql: String) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(pool)
        .await
        .unwrap();
}

async fn count(pool: &PgPool, table: &str) -> i64 {
    let sql = format!("SELECT count(*) FROM {table}");
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn setup() -> (PgPool, Retention<SharedClock>) {
    let pool = fresh_pool().await;
    let clock = Arc::new(SharedClock::at(NOW.try_into().unwrap()));
    (pool.clone(), Retention::new(pool, clock))
}

fn ts(offset: i64) -> String {
    format!("to_timestamp({})", NOW + offset)
}

fn hex32(n: u8) -> String {
    format!("decode(repeat('{n:02x}',32),'hex')")
}

fn hex16(n: u8) -> String {
    format!("decode(repeat('{n:02x}',16),'hex')")
}

async fn deleted(retention: &Retention<SharedClock>, table: &str) -> u64 {
    let report = retention.run_once().await.unwrap();
    report.iter().find(|(t, _)| *t == table).unwrap().1
}

#[tokio::test]
async fn abuse_counters_are_kept_for_seven_days() {
    let (pool, retention) = setup().await;
    for (bucket, offset) in [("old", -7 * DAY - 1), ("edge", -7 * DAY), ("new", 0)] {
        exec(
            &pool,
            format!(
                "INSERT INTO abuse_counters VALUES ('{bucket}', {}, 1)",
                ts(offset)
            ),
        )
        .await;
    }
    assert_eq!(deleted(&retention, "abuse_counters").await, 1);
    assert_eq!(count(&pool, "abuse_counters").await, 2);
}

#[tokio::test]
async fn invites_are_kept_for_thirty_days_after_they_expire() {
    let (pool, retention) = setup().await;
    insert_device(&pool, 1).await;
    for (n, offset) in [(1u8, -30 * DAY - 1), (2, -30 * DAY), (3, DAY)] {
        let sql = format!(
            "INSERT INTO invites VALUES ({}, 'contact', {}, {}, 1, 0, false)",
            hex32(n),
            hex16(1),
            ts(offset)
        );
        exec(&pool, sql).await;
    }
    assert_eq!(deleted(&retention, "invites").await, 1);
    assert_eq!(count(&pool, "invites").await, 2);
}

#[tokio::test]
async fn single_use_key_packages_last_thirty_days_but_the_last_resort_one_stays() {
    let (pool, retention) = setup().await;
    insert_device(&pool, 1).await;
    let today = format!("(to_timestamp({NOW}) AT TIME ZONE 'UTC')::date");
    for (age, last_resort) in [(31, false), (30, false), (0, false), (400, true)] {
        let sql = format!(
            "INSERT INTO key_packages (device_id, key_package, last_resort, created_on) VALUES ({}, '\\x01', {last_resort}, {today} - {age})",
            hex16(1)
        );
        exec(&pool, sql).await;
    }
    assert_eq!(deleted(&retention, "key_packages").await, 1);
    assert_eq!(count(&pool, "key_packages").await, 3);
}

#[tokio::test]
async fn the_audit_log_is_kept_for_a_year() {
    let (pool, retention) = setup().await;
    for (n, offset) in [(1u8, -365 * DAY - 1), (2, -365 * DAY), (3, 0)] {
        let sql = format!(
            "INSERT INTO audit_log (at, action, prev_hash, entry_hash) VALUES ({}, 'x', {}, {})",
            ts(offset),
            hex32(0),
            hex32(n)
        );
        exec(&pool, sql).await;
    }
    assert_eq!(deleted(&retention, "audit_log").await, 1);
    assert_eq!(count(&pool, "audit_log").await, 2);
}

#[tokio::test]
async fn envelopes_are_deleted_when_they_expire() {
    let (pool, retention) = setup().await;
    insert_device(&pool, 1).await;
    for (n, offset) in [(1u8, -1), (2, 0), (3, 1)] {
        let sql = format!(
            "INSERT INTO envelopes (envelope_id, recipient_device_id, ciphertext, enqueued_at, expires_at) VALUES ({}, {}, '\\x01', {}, {})",
            hex16(n),
            hex16(1),
            ts(offset - 100),
            ts(offset)
        );
        exec(&pool, sql).await;
    }
    assert_eq!(deleted(&retention, "envelopes").await, 2);
    assert_eq!(count(&pool, "envelopes").await, 1);
}

#[tokio::test]
async fn link_requests_nonces_and_sessions_are_deleted_when_they_expire() {
    let (pool, retention) = setup().await;
    insert_device(&pool, 1).await;
    insert_device(&pool, 2).await;
    for (n, offset) in [(1u8, 0), (2, 1)] {
        exec(
            &pool,
            format!(
                "INSERT INTO link_requests VALUES ({}, {}, {}, {})",
                hex16(n),
                hex32(n),
                hex32(n),
                ts(offset)
            ),
        )
        .await;
        exec(
            &pool,
            format!(
                "INSERT INTO auth_nonces VALUES ({}, {}, {})",
                hex16(n),
                hex32(n),
                ts(offset)
            ),
        )
        .await;
        exec(
            &pool,
            format!(
                "INSERT INTO sessions VALUES ({}, {}, {})",
                hex32(n),
                hex16(n),
                ts(offset)
            ),
        )
        .await;
    }
    let report = retention.run_once().await.unwrap();
    for table in ["link_requests", "auth_nonces", "sessions"] {
        assert!(report.contains(&(table, 1)), "{table}: {report:?}");
    }
    assert_eq!(count(&pool, "sessions").await, 1);
}

#[tokio::test]
async fn every_table_has_a_rule_or_a_reasoned_exemption() {
    let (pool, _) = setup().await;
    let tables: Vec<String> = sqlx::query_scalar("SELECT table_name::text FROM information_schema.tables WHERE table_schema = current_schema()")
        .fetch_all(&pool)
        .await
        .unwrap();
    let known: BTreeSet<&str> = RULES
        .iter()
        .map(|r| r.table)
        .chain(EXEMPT.iter().map(|e| e.0))
        .chain(OWNED_ELSEWHERE.iter().map(|e| e.0))
        .collect();
    let actual: BTreeSet<&str> = tables.iter().map(String::as_str).collect();
    let missing: Vec<_> = actual.difference(&known).collect();
    assert!(
        missing.is_empty(),
        "tables with no retention decision: {missing:?}"
    );
    let stale: Vec<_> = known.difference(&actual).collect();
    assert!(
        stale.is_empty(),
        "retention entries for tables that do not exist: {stale:?}"
    );
    assert!(
        EXEMPT
            .iter()
            .chain(OWNED_ELSEWHERE.iter())
            .all(|(_, why)| why.len() > 10),
        "give a real reason"
    );
}

#[tokio::test]
async fn the_schedule_runs_the_rules_repeatedly_in_the_background() {
    let (pool, retention) = setup().await;
    insert_device(&pool, 1).await;
    let retention = Arc::new(retention);
    let task = tokio::spawn({
        let retention = retention.clone();
        async move { retention.run_forever(Duration::from_millis(20)).await }
    });
    exec(
        &pool,
        format!(
            "INSERT INTO sessions VALUES ({}, {}, {})",
            hex32(1),
            hex16(1),
            ts(0)
        ),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while count(&pool, "sessions").await != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the scheduled run never deleted the expired session");
    task.abort();
}

#[tokio::test]
async fn a_failing_database_is_reported_not_ignored() {
    let (pool, retention) = setup().await;
    pool.close().await;
    assert!(retention.run_once().await.is_err());
}
