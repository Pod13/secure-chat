//! A pool on a fresh, migrated schema of the disposable test database.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, PgConnection, PgPool, migrate::Migrator};
use std::{path::PathBuf, str::FromStr};

pub async fn fresh_pool() -> PgPool {
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
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .unwrap();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
    Migrator::new(dir).await.unwrap().run(&pool).await.unwrap();
    pool
}

/// Inserts an account and one device (ids are `n` repeated), so queue rows have an owner.
pub async fn insert_device(pool: &PgPool, n: u8) {
    let hex = format!("{n:02x}");
    let sql = format!(
        "INSERT INTO accounts VALUES (decode(repeat('{hex}',16),'hex'), decode(repeat('{hex}',32),'hex'), CURRENT_DATE, CURRENT_DATE); \
         INSERT INTO devices (device_id, account_id, device_public_key, linked_on, label_blob) VALUES \
         (decode(repeat('{hex}',16),'hex'), decode(repeat('{hex}',16),'hex'), decode(repeat('{hex}',32),'hex'), CURRENT_DATE, '\\x01')"
    );
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(pool)
        .await
        .unwrap();
}
