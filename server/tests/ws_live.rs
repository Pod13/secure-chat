#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod fakes;

use fakes::{MemoryAuthStore, MemoryOutbox, SharedClock};
use futures_util::{SinkExt, StreamExt};
use server::api::ws::{WsState, b64, router};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{net::TcpStream, time::timeout};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Error, Message, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const DEVICE: [u8; 16] = [1; 16];
const OTHER: [u8; 16] = [2; 16];
const TOKEN: [u8; 32] = [5; 32];

struct Harness {
    addr: SocketAddr,
    auth: Arc<MemoryAuthStore>,
    outbox: Arc<MemoryOutbox>,
    clock: Arc<SharedClock>,
}

async fn start(idle: Duration) -> Harness {
    let auth = Arc::new(MemoryAuthStore::default());
    let session = (DEVICE, 2_000);
    auth.sessions
        .lock()
        .unwrap()
        .insert(Sha256::digest(TOKEN).into(), session);
    let outbox = Arc::new(MemoryOutbox::default());
    let clock = Arc::new(SharedClock::at(1_000));
    let state = WsState {
        auth: auth.clone(),
        outbox: outbox.clone(),
        clock: clock.clone(),
        idle_timeout: idle,
    };
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(tcp, router(state)).await });
    Harness {
        addr,
        auth,
        outbox,
        clock,
    }
}

fn offer(token: &[u8; 32]) -> String {
    format!("chat.v1, auth.{}", b64(token))
}

async fn connect(h: &Harness, offer: &str) -> Result<(Socket, String), Error> {
    let mut request = format!("ws://{}/v1/ws", h.addr)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", offer.parse().unwrap());
    let (socket, response) = connect_async(request).await?;
    let chosen = response
        .headers()
        .get("sec-websocket-protocol")
        .map(|v| v.to_str().unwrap().to_string());
    Ok((socket, chosen.unwrap_or_default()))
}

async fn open(h: &Harness) -> Socket {
    connect(h, &offer(&TOKEN)).await.unwrap().0
}

async fn next_json(ws: &mut Socket) -> serde_json::Value {
    let message = timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("timed out")
        .unwrap()
        .unwrap();
    match message {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

async fn expect_closed(ws: &mut Socket) {
    loop {
        match timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("connection stayed open")
        {
            None | Some(Err(_) | Ok(Message::Close(_))) => return,
            Some(Ok(_)) => {}
        }
    }
}

async fn send_text(ws: &mut Socket, text: impl Into<String>) {
    ws.send(Message::Text(text.into().into())).await.unwrap();
}

fn status_of(result: Result<(Socket, String), Error>) -> u16 {
    match result {
        Err(Error::Http(response)) => response.status().as_u16(),
        Err(other) => panic!("expected an HTTP refusal, got {other:?}"),
        Ok(_) => panic!("the connection was accepted"),
    }
}

#[tokio::test]
async fn the_backlog_arrives_in_order_then_queue_empty_and_acks_delete_only_that_devices_items() {
    let h = start(Duration::from_secs(30)).await;
    for i in 1..=3u8 {
        h.outbox.add(DEVICE, i, u64::from(i));
    }
    h.outbox.add(OTHER, 9, 1);
    let mut ws = open(&h).await;
    for i in 1..=3u8 {
        let frame = next_json(&mut ws).await;
        assert_eq!(frame["type"], "envelope");
        assert_eq!(frame["envelope_id"], b64(&[i; 16]));
    }
    assert_eq!(next_json(&mut ws).await["type"], "queue-empty");
    send_text(
        &mut ws,
        format!(
            r#"{{"type":"ack","envelope_ids":["{}","{}"]}}"#,
            b64(&[1; 16]),
            b64(&[9; 16])
        ),
    )
    .await;
    timeout(Duration::from_secs(3), async {
        while h.outbox.ids_for(DEVICE).len() != 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(h.outbox.ids_for(DEVICE), vec![2, 3]);
    assert_eq!(
        h.outbox.ids_for(OTHER),
        vec![9],
        "acking another device's id changes nothing"
    );
}

#[tokio::test]
async fn unacknowledged_envelopes_come_again_on_the_next_connection() {
    let h = start(Duration::from_secs(30)).await;
    h.outbox.add(DEVICE, 1, 1);
    let mut first = open(&h).await;
    assert_eq!(next_json(&mut first).await["type"], "envelope");
    drop(first);
    let mut second = open(&h).await;
    assert_eq!(next_json(&mut second).await["envelope_id"], b64(&[1; 16]));
}

#[tokio::test]
async fn a_message_arriving_while_connected_is_pushed() {
    let h = start(Duration::from_secs(30)).await;
    let mut ws = open(&h).await;
    assert_eq!(next_json(&mut ws).await["type"], "queue-empty");
    h.outbox.add(DEVICE, 7, 50);
    h.outbox.notify.notify_one();
    assert_eq!(next_json(&mut ws).await["envelope_id"], b64(&[7; 16]));
}

#[tokio::test]
async fn only_the_chat_protocol_is_selected_and_the_token_is_never_echoed() {
    let h = start(Duration::from_secs(30)).await;
    let (_ws, chosen) = connect(&h, &offer(&TOKEN)).await.unwrap();
    assert_eq!(chosen, "chat.v1");
}

#[tokio::test]
async fn connections_without_a_valid_session_are_refused_before_the_upgrade() {
    let h = start(Duration::from_secs(30)).await;
    let plain = format!("ws://{}/v1/ws", h.addr)
        .into_client_request()
        .unwrap();
    assert!(matches!(connect_async(plain).await, Err(Error::Http(r)) if r.status() == 401));
    for bad in [
        "chat.v1".to_string(),
        offer(&[6; 32]),
        format!("auth.{}", b64(&TOKEN)),
        "chat.v1, auth.zz".to_string(),
    ] {
        assert_eq!(status_of(connect(&h, &bad).await), 401, "{bad}");
    }
}

#[tokio::test]
async fn an_expired_session_is_refused_and_a_broken_store_is_a_503() {
    let h = start(Duration::from_secs(30)).await;
    h.clock.set(2_000);
    assert_eq!(status_of(connect(&h, &offer(&TOKEN)).await), 401);
    h.clock.set(1_000);
    h.auth.fail_after(0);
    assert_eq!(status_of(connect(&h, &offer(&TOKEN)).await), 503);
}

#[tokio::test]
async fn a_bad_frame_gets_an_error_and_the_connection_closes() {
    let h = start(Duration::from_secs(30)).await;
    for bad in [
        "not json",
        r#"{"type":"ack","envelope_ids":["x"]}"#,
        r#"{"type":"queue-empty"}"#,
    ] {
        let mut ws = open(&h).await;
        assert_eq!(next_json(&mut ws).await["type"], "queue-empty");
        send_text(&mut ws, bad).await;
        let error = next_json(&mut ws).await;
        assert_eq!(
            (error["type"].as_str(), error["code"].as_str()),
            (Some("error"), Some("invalid_request")),
            "{bad}"
        );
        expect_closed(&mut ws).await;
    }
}

#[tokio::test]
async fn binary_frames_are_refused() {
    let h = start(Duration::from_secs(30)).await;
    let mut ws = open(&h).await;
    next_json(&mut ws).await;
    ws.send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(next_json(&mut ws).await["code"], "invalid_request");
    expect_closed(&mut ws).await;
}

#[tokio::test]
async fn an_oversized_frame_closes_the_connection() {
    let h = start(Duration::from_secs(30)).await;
    let mut ws = open(&h).await;
    next_json(&mut ws).await;
    send_text(
        &mut ws,
        format!(r#"{{"type":"ping","pad":"{}"}}"#, "x".repeat(9_000)),
    )
    .await;
    expect_closed(&mut ws).await;
}

#[tokio::test]
async fn a_flood_of_frames_is_cut_off() {
    let h = start(Duration::from_secs(30)).await;
    let mut ws = open(&h).await;
    next_json(&mut ws).await;
    for _ in 0..105 {
        send_text(&mut ws, r#"{"type":"ping"}"#).await;
    }
    assert_eq!(next_json(&mut ws).await["code"], "rate_limited");
    expect_closed(&mut ws).await;
}

#[tokio::test]
async fn a_silent_connection_is_closed_but_a_pinging_one_is_not() {
    let h = start(Duration::from_millis(300)).await;
    let mut quiet = open(&h).await;
    let mut chatty = open(&h).await;
    next_json(&mut quiet).await;
    next_json(&mut chatty).await;
    for _ in 0..6 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        send_text(&mut chatty, r#"{"type":"ping"}"#).await;
    }
    expect_closed(&mut quiet).await;
    send_text(&mut chatty, r#"{"type":"ping"}"#).await;
}

#[tokio::test]
async fn a_failing_queue_at_connect_ends_the_connection_with_an_error() {
    let h = start(Duration::from_secs(30)).await;
    *h.outbox.broken.lock().unwrap() = true;
    let mut ws = open(&h).await;
    assert_eq!(next_json(&mut ws).await["code"], "invalid_request");
    expect_closed(&mut ws).await;
}

#[tokio::test]
async fn websocket_level_pings_are_accepted_as_keepalives() {
    let h = start(Duration::from_secs(30)).await;
    let mut ws = open(&h).await;
    next_json(&mut ws).await;
    ws.send(Message::Ping(vec![1].into())).await.unwrap();
    // The automatic pong proves the server has read the ping, so what it does next is observable.
    let reply = timeout(Duration::from_secs(3), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(reply, Message::Pong(_)), "{reply:?}");
    h.outbox.add(DEVICE, 1, 1);
    h.outbox.notify.notify_one();
    assert_eq!(
        next_json(&mut ws).await["type"],
        "envelope",
        "the connection survived the ping"
    );
}
