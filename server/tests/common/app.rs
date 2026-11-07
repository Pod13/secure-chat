//! A running API on a real socket, backed by a fresh database schema, plus helpers that play the
//! part of a client (sign up, log in, call endpoints). Test code only.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use server::accounts::{
    DEVICE_CERT_DOMAIN,
    invites::{self, Kind, NewInvite},
};
use server::api::state::AppState;
use server::auth::login_message;
use server::ports::{Clock, DynClock, DynRandom, OsRandom};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const START: u64 = 1_900_000_000;

pub struct TestClock(AtomicU64);

impl TestClock {
    pub fn advance(&self, secs: u64) {
        self.0.fetch_add(secs, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_secs(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub raw: String,
}

pub struct TestApp {
    pub addr: std::net::SocketAddr,
    pub pool: PgPool,
    pub clock: Arc<TestClock>,
    pub state: AppState,
}

pub async fn start() -> TestApp {
    let pool = super::db::fresh_pool().await;
    let clock = Arc::new(TestClock(AtomicU64::new(START)));
    let dyn_clock: DynClock = clock.clone();
    let random: DynRandom = Arc::new(OsRandom);
    let state = AppState::new(pool.clone(), dyn_clock, random, 900);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = server::app_router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<server::api::tls::Peer>(),
        )
        .await
    });
    TestApp {
        addr,
        pool,
        clock,
        state,
    }
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(text: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD.decode(text).unwrap()
}

fn random_key() -> SigningKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    SigningKey::from_bytes(&seed)
}

impl TestApp {
    /// Sends one HTTP/1.1 request and reads the whole response.
    pub async fn call(
        &self,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<&Value>,
    ) -> Reply {
        self.call_raw(method, path, bearer, body.map(Value::to_string).as_deref())
            .await
    }

    pub async fn call_raw(
        &self,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<&str>,
    ) -> Reply {
        let mut stream = TcpStream::connect(self.addr).await.unwrap();
        let body = body.unwrap_or("");
        let auth = bearer.map_or(String::new(), |t| format!("Authorization: Bearer {t}\r\n"));
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: test\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).await.unwrap();
        let status = raw.split_whitespace().nth(1).unwrap().parse().unwrap();
        let text = raw.split("\r\n\r\n").nth(1).unwrap_or("");
        Reply {
            status,
            body: serde_json::from_str(text).unwrap_or(Value::Null),
            raw,
        }
    }

    /// An operator seed Invite for sign-up.
    pub async fn seed_invite(&self, uses: u32) -> String {
        let new = NewInvite {
            owner: None,
            kind: Kind::Service,
            expires_at: START + 86_400,
            max_uses: uses,
        };
        let made = invites::create(&self.pool, &*self.clock, &OsRandom, new)
            .await
            .unwrap();
        b64(&made.token)
    }
}

/// A client with its keys. It can sign up and log in the way the real client will.
pub struct Person {
    pub identity: SigningKey,
    pub device: SigningKey,
    pub account_id: String,
    pub device_id: String,
    pub token: String,
}

pub fn sign_up_body(identity: &SigningKey, device: &SigningKey, invite: &str, tag: u8) -> Value {
    let certificate =
        identity.sign(&[DEVICE_CERT_DOMAIN, device.verifying_key().as_bytes()].concat());
    json!({
        "invite_token": invite,
        "identity_public_key": b64(identity.verifying_key().as_bytes()),
        "device_public_key": b64(device.verifying_key().as_bytes()),
        "device_certificate": b64(&certificate.to_bytes()),
        "key_packages": [b64(&[tag; 64]), b64(&[tag.wrapping_add(1); 64])],
        "last_resort_key_package": b64(&[tag.wrapping_add(2); 64]),
        "label_blob": b64(&[tag; 16]),
    })
}

impl TestApp {
    pub async fn sign_up(&self, invite: &str, tag: u8) -> Person {
        let (identity, device) = (random_key(), random_key());
        let reply = self
            .call(
                "POST",
                "/v1/accounts",
                None,
                Some(&sign_up_body(&identity, &device, invite, tag)),
            )
            .await;
        assert_eq!(reply.status, 201, "{}", reply.raw);
        let mut person = Person {
            identity,
            device,
            account_id: reply.body["account_id"].as_str().unwrap().to_string(),
            device_id: reply.body["device_id"].as_str().unwrap().to_string(),
            token: String::new(),
        };
        person.token = self.log_in(&person).await;
        person
    }

    pub async fn log_in(&self, person: &Person) -> String {
        let challenge = self
            .call(
                "POST",
                "/v1/auth/challenge",
                None,
                Some(&json!({"device_id": person.device_id})),
            )
            .await;
        assert_eq!(challenge.status, 200, "{}", challenge.raw);
        let nonce: [u8; 32] = unb64(challenge.body["nonce"].as_str().unwrap())
            .try_into()
            .unwrap();
        let device_id: [u8; 16] = unb64(&person.device_id).try_into().unwrap();
        let signature = person.device.sign(&login_message(&device_id, &nonce));
        let reply = self
            .call(
                "POST",
                "/v1/auth/token",
                None,
                Some(&json!({"device_id": person.device_id, "signature": b64(&signature.to_bytes())})),
            )
            .await;
        assert_eq!(reply.status, 200, "{}", reply.raw);
        reply.body["token"].as_str().unwrap().to_string()
    }
}

impl TestApp {
    /// Everything stored, as a server operator (or thief of a backup) would see it: one text
    /// artifact per table, one JSON row per line. Binary columns appear as lowercase hex.
    pub async fn dump(&self) -> Vec<super::Artifact> {
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT table_name::text FROM information_schema.tables \
             WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_sqlx_migrations' \
             ORDER BY table_name",
        )
        .fetch_all(&self.pool)
        .await
        .unwrap();
        let mut out = Vec::new();
        for table in tables {
            let sql = format!("SELECT row_to_json(t)::text FROM {table} t");
            let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
                .fetch_all(&self.pool)
                .await
                .unwrap();
            out.push(super::artifact(
                &format!("table {table}"),
                rows.join("\n").as_bytes(),
            ));
        }
        out
    }

    /// The columns of a table, in order.
    pub async fn columns(&self, table: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT column_name::text FROM information_schema.columns \
             WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}
