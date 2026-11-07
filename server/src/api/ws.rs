//! The real-time channel (`contracts/realtime-frames.md`). A Device connects once, authenticated
//! before the upgrade, receives its queued envelopes, and acknowledges them.
//!
//! Browsers cannot set an Authorization header on a WebSocket, so the session token travels in
//! the `Sec-WebSocket-Protocol` header (`chat.v1, auth.<token>`), never in the URL where logs
//! would keep it. Frames are text JSON, size-limited, schema-validated, and rate-limited per
//! connection. Content never appears here: envelopes carry ciphertext only.

use super::validate::validate;
use crate::auth::{AuthError, AuthStore, DeviceId, authenticate};
use crate::ports::Clock;
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header::SEC_WEBSOCKET_PROTOCOL},
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{future::Future, sync::Arc, time::Duration, time::Instant};

pub const PROTOCOL: &str = "chat.v1";
/// A connection with no frames for this long is closed; clients ping about every 30 seconds.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// Client frames are tiny (an ack of 100 ids is about 2.5 KB).
pub const MAX_FRAME_BYTES: usize = 8 * 1024;
const PAGE: usize = 50;
const MAX_FRAMES: u32 = 100;
const FRAME_WINDOW: Duration = Duration::from_secs(10);

pub type EnvelopeId = [u8; 16];

pub struct Envelope {
    pub id: EnvelopeId,
    pub ciphertext: Vec<u8>,
    pub enqueued_at: u64,
    /// Arrival order within the queue. Internal; never sent to a client.
    pub seq: u64,
}

/// Where to continue reading a Device's queue, so nothing is sent twice on one connection.
#[derive(Default, Clone, PartialEq, Eq, Debug)]
pub struct Cursor {
    pub seq: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct OutboxError;

pub trait Outbox {
    /// Envelopes for the Device after the cursor, oldest first.
    fn pending(
        &self,
        device: &DeviceId,
        after: &Cursor,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<Envelope>, OutboxError>> + Send;
    /// Deletes the Device's own envelopes with these ids. Ids belonging to others are ignored.
    fn ack(
        &self,
        device: &DeviceId,
        ids: &[EnvelopeId],
    ) -> impl Future<Output = Result<(), OutboxError>> + Send;
    /// Completes when something new may be waiting for the Device.
    fn changed(&self, device: &DeviceId) -> impl Future<Output = ()> + Send;
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64<const N: usize>(text: &str) -> Option<[u8; N]> {
    URL_SAFE_NO_PAD.decode(text).ok()?.try_into().ok()
}

#[derive(Debug, PartialEq, Eq)]
pub enum Incoming {
    Ack(Vec<EnvelopeId>),
    Ping,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    Invalid,
    TooLarge,
}

impl FrameError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid_request",
            Self::TooLarge => "too_large",
        }
    }
}

/// Parses a client frame. Only `ack` and `ping` may come from a Device.
pub fn parse_incoming(text: &str) -> Result<Incoming, FrameError> {
    if text.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    let value: Value = serde_json::from_str(text).map_err(|_| FrameError::Invalid)?;
    let kind = match value["type"].as_str() {
        Some(k @ ("ack" | "ping")) => k,
        _ => return Err(FrameError::Invalid),
    };
    validate(&format!("ws-{kind}"), text.as_bytes()).map_err(|_| FrameError::Invalid)?;
    if kind == "ping" {
        return Ok(Incoming::Ping);
    }
    let ids = value["envelope_ids"]
        .as_array()
        .ok_or(FrameError::Invalid)?;
    let decoded: Option<Vec<EnvelopeId>> = ids
        .iter()
        .map(|id| id.as_str().and_then(unb64::<16>))
        .collect();
    decoded.map(Incoming::Ack).ok_or(FrameError::Invalid)
}

pub fn envelope_frame(e: &Envelope) -> String {
    json!({"type": "envelope", "envelope_id": b64(&e.id), "ciphertext": b64(&e.ciphertext), "enqueued_at": e.enqueued_at}).to_string()
}

pub fn queue_empty_frame() -> String {
    json!({"type": "queue-empty"}).to_string()
}

pub fn error_frame(code: &str) -> String {
    json!({"type": "error", "code": code}).to_string()
}

pub fn unlinked_frame(recovered: bool) -> String {
    let reason = if recovered { "recovered" } else { "unlinked" };
    json!({"type": "device-unlinked", "reason": reason}).to_string()
}

/// Reads everything after the cursor, a page at a time, and advances the cursor.
pub async fn flush(
    outbox: &impl Outbox,
    device: &DeviceId,
    cursor: &mut Cursor,
) -> Result<Vec<String>, OutboxError> {
    let mut frames = Vec::new();
    loop {
        let batch = outbox.pending(device, cursor, PAGE).await?;
        for envelope in &batch {
            frames.push(envelope_frame(envelope));
            *cursor = Cursor { seq: envelope.seq };
        }
        if batch.len() < PAGE {
            return Ok(frames);
        }
    }
}

/// Handles one client frame. An error means the connection must be closed with that code.
pub async fn handle_frame(
    outbox: &impl Outbox,
    device: &DeviceId,
    text: &str,
) -> Result<(), &'static str> {
    match parse_incoming(text).map_err(|e| e.code())? {
        Incoming::Ping => Ok(()),
        Incoming::Ack(ids) => outbox
            .ack(device, &ids)
            .await
            .map_err(|_| "invalid_request"),
    }
}

/// At most `MAX_FRAMES` frames per window; the rest of a flood closes the connection.
pub struct FrameBudget {
    started: Instant,
    count: u32,
}

impl FrameBudget {
    pub fn new(now: Instant) -> Self {
        Self {
            started: now,
            count: 0,
        }
    }

    pub fn allow(&mut self, now: Instant) -> bool {
        if now.duration_since(self.started) >= FRAME_WINDOW {
            *self = Self::new(now);
        }
        self.count += 1;
        self.count <= MAX_FRAMES
    }
}

/// Finds the session token in the `Sec-WebSocket-Protocol` offer: `chat.v1, auth.<token>`.
pub fn token_from_protocols(header: &str) -> Option<[u8; 32]> {
    let parts: Vec<&str> = header.split(',').map(str::trim).collect();
    let mut tokens = parts.iter().filter_map(|p| p.strip_prefix("auth."));
    let token = tokens.next()?;
    if tokens.next().is_some() || !parts.contains(&PROTOCOL) {
        return None;
    }
    unb64::<32>(token)
}

pub struct WsState<A, O, C> {
    pub auth: Arc<A>,
    pub outbox: Arc<O>,
    pub clock: Arc<C>,
    pub idle_timeout: Duration,
}

impl<A, O, C> Clone for WsState<A, O, C> {
    fn clone(&self) -> Self {
        Self {
            auth: self.auth.clone(),
            outbox: self.outbox.clone(),
            clock: self.clock.clone(),
            idle_timeout: self.idle_timeout,
        }
    }
}

pub fn router<A, O, C>(state: WsState<A, O, C>) -> Router
where
    A: AuthStore + Send + Sync + 'static,
    O: Outbox + Send + Sync + 'static,
    C: Clock + Send + Sync + 'static,
{
    Router::new()
        .route("/v1/ws", get(upgrade::<A, O, C>))
        .with_state(state)
}

async fn upgrade<A, O, C>(
    State(state): State<WsState<A, O, C>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response
where
    A: AuthStore + Send + Sync + 'static,
    O: Outbox + Send + Sync + 'static,
    C: Clock + Send + Sync + 'static,
{
    let offer = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok());
    let Some(token) = offer.and_then(token_from_protocols) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let device = match authenticate(&*state.auth, &*state.clock, &token).await {
        Ok(device) => device,
        Err(AuthError::Unauthorized) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(AuthError::Store) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    ws.protocols([PROTOCOL])
        .max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| run(socket, state.outbox, state.idle_timeout, device))
}

async fn send(socket: &mut WebSocket, text: String) -> bool {
    socket.send(Message::Text(text.into())).await.is_ok()
}

async fn send_all(socket: &mut WebSocket, frames: Vec<String>) -> bool {
    for frame in frames {
        if !send(socket, frame).await {
            return false;
        }
    }
    true
}

async fn fail(socket: &mut WebSocket, code: &str) {
    let _ = send(socket, error_frame(code)).await;
    let _ = socket.send(Message::Close(None)).await;
}

async fn run<O: Outbox + Send + Sync + 'static>(
    mut socket: WebSocket,
    outbox: Arc<O>,
    idle: Duration,
    device: DeviceId,
) {
    let mut cursor = Cursor::default();
    if greet(&mut socket, &*outbox, &device, &mut cursor).await {
        session(&mut socket, &outbox, idle, &device, &mut cursor).await;
    }
}

/// Sends the backlog, then `queue-empty`. Returns false if the connection is gone or unusable.
async fn greet(
    socket: &mut WebSocket,
    outbox: &impl Outbox,
    device: &DeviceId,
    cursor: &mut Cursor,
) -> bool {
    let Ok(backlog) = flush(outbox, device, cursor).await else {
        fail(socket, "invalid_request").await;
        return false;
    };
    send_all(socket, backlog).await && send(socket, queue_empty_frame()).await
}

/// Sends anything that arrived since the cursor. Returns false if the connection should end.
async fn forward_new(
    socket: &mut WebSocket,
    outbox: &impl Outbox,
    device: &DeviceId,
    cursor: &mut Cursor,
) -> bool {
    match flush(outbox, device, cursor).await {
        Ok(frames) => send_all(socket, frames).await,
        Err(_) => false,
    }
}

async fn session<O: Outbox + Send + Sync + 'static>(
    socket: &mut WebSocket,
    outbox: &Arc<O>,
    idle: Duration,
    device: &DeviceId,
    cursor: &mut Cursor,
) {
    let mut budget = FrameBudget::new(Instant::now());
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { return };
                if let Err(code) = on_message(outbox, device, message, &mut budget).await {
                    return fail(socket, code).await;
                }
            }
            () = outbox.changed(device) => {
                if !forward_new(socket, &**outbox, device, cursor).await {
                    return;
                }
            }
            () = tokio::time::sleep(idle) => return,
        }
    }
}

async fn on_message<O: Outbox>(
    outbox: &Arc<O>,
    device: &DeviceId,
    message: Message,
    budget: &mut FrameBudget,
) -> Result<(), &'static str> {
    if !budget.allow(Instant::now()) {
        return Err("rate_limited");
    }
    match message {
        Message::Text(text) => handle_frame(&**outbox, device, text.as_str()).await,
        Message::Ping(_) | Message::Pong(_) => Ok(()),
        _ => Err("invalid_request"),
    }
}
