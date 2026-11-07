//! The handler on top of the real queue: what production runs.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;
mod fakes;

use common::db::{fresh_pool, insert_device};
use fakes::{MemoryAuthStore, SharedClock};
use futures_util::{SinkExt, StreamExt};
use server::api::ws::{WsState, b64, router};
use server::delivery::queue::PgQueue;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_json(ws: &mut Socket) -> serde_json::Value {
    let message = timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let Message::Text(text) = message else {
        panic!("expected text")
    };
    serde_json::from_str(text.as_str()).unwrap()
}

const DEVICE: [u8; 16] = [1; 16];
const TOKEN: [u8; 32] = [5; 32];

#[tokio::test]
async fn a_queued_message_reaches_the_device_and_acknowledging_deletes_it() {
    let pool = fresh_pool().await;
    insert_device(&pool, 1).await;
    let clock = Arc::new(SharedClock::at(1_000));
    let queue = Arc::new(PgQueue::new(pool.clone(), clock.clone()));
    let auth = Arc::new(MemoryAuthStore::default());
    auth.sessions
        .lock()
        .unwrap()
        .insert(Sha256::digest(TOKEN).into(), (DEVICE, 5_000));
    let state = WsState {
        auth,
        outbox: queue.clone(),
        clock,
        idle_timeout: Duration::from_secs(30),
    };
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(tcp, router(state)).await });

    let mut request = format!("ws://{addr}/v1/ws").into_client_request().unwrap();
    let offer = format!("chat.v1, auth.{}", b64(&TOKEN));
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", offer.parse().unwrap());
    let (mut ws, _) = connect_async(request).await.unwrap();

    assert_eq!(next_json(&mut ws).await["type"], "queue-empty");
    queue
        .enqueue(&DEVICE, &[7; 16], b"sealed bytes")
        .await
        .unwrap();
    let frame = next_json(&mut ws).await;
    assert_eq!(frame["type"], "envelope");
    assert_eq!(frame["ciphertext"], b64(b"sealed bytes"));

    let ack = format!(r#"{{"type":"ack","envelope_ids":["{}"]}}"#, b64(&[7; 16]));
    ws.send(Message::Text(ack.into())).await.unwrap();
    timeout(Duration::from_secs(3), async {
        loop {
            let left: i64 = sqlx::query_scalar("SELECT count(*) FROM envelopes")
                .fetch_one(&pool)
                .await
                .unwrap();
            if left == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the acknowledged envelope was not deleted");
}
