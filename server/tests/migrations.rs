//! Schema security tests (Constitution IV, V): the database holds exactly what the Data
//! Inventory lists, enforces sizes itself, and deletes everything when an account is deleted.
//! Needs a PostgreSQL server; set DATABASE_URL (see docs/testing.md).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use sqlx::postgres::PgConnectOptions;
use sqlx::{Connection, PgConnection, migrate::Migrator};
use std::{path::PathBuf, str::FromStr};

const TABLES: [&str; 14] = [
    "_sqlx_migrations",
    "abuse_counters",
    "accounts",
    "audit_log",
    "auth_nonces",
    "backups",
    "blobs",
    "delivery_tokens",
    "devices",
    "envelopes",
    "invites",
    "key_packages",
    "link_requests",
    "sessions",
];

/// Column names that would mean content, names or social-graph data are being stored.
const FORBIDDEN: [&str; 12] = [
    "username",
    "email",
    "phone",
    "plaintext",
    "message",
    "content",
    "contact",
    "sender",
    "private",
    "redeem",
    "used_by",
    "display",
];

async fn fresh() -> PgConnection {
    let url = std::env::var("DATABASE_URL")
        .expect("DATABASE_URL must point at a disposable PostgreSQL server (see docs/testing.md)");
    let mut random = [0u8; 6];
    getrandom::fill(&mut random).unwrap();
    let schema = format!(
        "t_{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let mut admin = PgConnection::connect(&url).await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}")))
        .execute(&mut admin)
        .await
        .unwrap();
    let options = PgConnectOptions::from_str(&url)
        .unwrap()
        .options([("search_path", &schema)]);
    let mut conn = PgConnection::connect_with(&options).await.unwrap();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    Migrator::new(dir)
        .await
        .unwrap()
        .run(&mut conn)
        .await
        .unwrap();
    conn
}

async fn strings(conn: &mut PgConnection, sql: &'static str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(sql)
        .fetch_all(conn)
        .await
        .unwrap()
}

async fn fails(conn: &mut PgConnection, sql: &'static str) -> bool {
    sqlx::query(sql).execute(conn).await.is_err()
}

const SCHEMA_TABLES: &str = "SELECT table_name::text FROM information_schema.tables \
    WHERE table_schema = current_schema() ORDER BY 1";
const SCHEMA_COLUMNS: &str = "SELECT (table_name || '.' || column_name)::text \
    FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY 1";

#[tokio::test]
async fn the_database_holds_exactly_the_inventoried_tables() {
    let mut conn = fresh().await;
    assert_eq!(strings(&mut conn, SCHEMA_TABLES).await, TABLES);
}

#[tokio::test]
async fn no_column_stores_content_names_or_social_graph_data() {
    let mut conn = fresh().await;
    for column in strings(&mut conn, SCHEMA_COLUMNS).await {
        for word in FORBIDDEN {
            assert!(
                !column.contains(word),
                "column {column} looks like it stores '{word}'"
            );
        }
    }
}

#[tokio::test]
async fn an_invite_records_its_owner_but_never_who_redeemed_it() {
    let mut conn = fresh().await;
    let columns = strings(&mut conn, SCHEMA_COLUMNS).await;
    let invite_columns: Vec<_> = columns
        .iter()
        .filter(|c| c.starts_with("invites."))
        .collect();
    assert!(
        invite_columns
            .iter()
            .any(|c| *c == "invites.owner_account_id")
    );
    let elsewhere = columns
        .iter()
        .filter(|c| !c.starts_with("invites.") && c.contains("invite"));
    assert_eq!(
        elsewhere.count(),
        0,
        "only the invites table may mention invites"
    );
}

#[tokio::test]
async fn the_database_enforces_sizes_and_limits_itself() {
    let mut conn = fresh().await;
    let bad_account =
        "INSERT INTO accounts VALUES ('\\x00'::bytea, '\\x00'::bytea, CURRENT_DATE, CURRENT_DATE)";
    assert!(
        fails(&mut conn, bad_account).await,
        "short account id accepted"
    );
    insert_account(&mut conn, 1).await;
    insert_device(&mut conn, 1, 1).await;
    let long_lived = "INSERT INTO envelopes VALUES (decode(repeat('01',16),'hex'), decode(repeat('01',16),'hex'), \
        '\\x01', now(), now() + interval '31 days')";
    assert!(
        fails(&mut conn, long_lived).await,
        "envelope kept for over 30 days"
    );
    let over_used = "INSERT INTO invites VALUES (decode(repeat('02',32),'hex'), 'contact', \
        decode(repeat('01',16),'hex'), now(), 1, 2, false)";
    assert!(
        fails(&mut conn, over_used).await,
        "invite used more than its limit"
    );
    let orphan = "INSERT INTO invites VALUES (decode(repeat('03',32),'hex'), 'service', \
        decode(repeat('09',16),'hex'), now(), 1, 0, false)";
    assert!(
        fails(&mut conn, orphan).await,
        "invite with an unknown owner accepted"
    );
}

async fn insert_account(conn: &mut PgConnection, n: u8) {
    let sql = format!(
        "INSERT INTO accounts VALUES (decode(repeat('{n:02x}',16),'hex'), decode(repeat('{n:02x}',32),'hex'), CURRENT_DATE, CURRENT_DATE)"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(conn)
        .await
        .unwrap();
}

async fn insert_device(conn: &mut PgConnection, account: u8, n: u8) {
    let sql = format!(
        "INSERT INTO devices (device_id, account_id, device_public_key, linked_on, label_blob) VALUES \
         (decode(repeat('{n:02x}',16),'hex'), decode(repeat('{account:02x}',16),'hex'), decode(repeat('{n:02x}',32),'hex'), CURRENT_DATE, '\\x01')"
    );
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(conn)
        .await
        .unwrap();
}

#[tokio::test]
async fn deleting_an_account_removes_everything_tied_to_it() {
    let mut conn = fresh().await;
    insert_account(&mut conn, 1).await;
    insert_device(&mut conn, 1, 1).await;
    let rows = [
        "INSERT INTO delivery_tokens VALUES (decode(repeat('05',32),'hex'), decode(repeat('01',16),'hex'), false)",
        "INSERT INTO envelopes VALUES (decode(repeat('06',16),'hex'), decode(repeat('01',16),'hex'), '\\x01', now(), now())",
        "INSERT INTO sessions VALUES (decode(repeat('07',32),'hex'), decode(repeat('01',16),'hex'), now())",
        "INSERT INTO invites VALUES (decode(repeat('08',32),'hex'), 'contact', decode(repeat('01',16),'hex'), now(), 1, 0, false)",
        "INSERT INTO backups VALUES (decode(repeat('01',16),'hex'), decode(repeat('0a',16),'hex'), decode(repeat('0b',32),'hex'), 10)",
    ];
    for sql in rows {
        sqlx::query(sql).execute(&mut conn).await.unwrap();
    }
    sqlx::query("DELETE FROM accounts")
        .execute(&mut conn)
        .await
        .unwrap();
    for table in [
        "devices",
        "delivery_tokens",
        "envelopes",
        "sessions",
        "invites",
        "backups",
    ] {
        let left: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            left, 0,
            "{table} still has rows after the account was deleted"
        );
    }
}
