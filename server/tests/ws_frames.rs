#![allow(clippy::unwrap_used)]

mod fakes;

use fakes::MemoryOutbox;
use server::api::validate::validate;
use server::api::ws::{
    Cursor, Envelope, FrameBudget, FrameError, Incoming, b64, envelope_frame, error_frame, flush,
    handle_frame, parse_incoming, queue_empty_frame, token_from_protocols, unlinked_frame,
};
use std::time::{Duration, Instant};

const DEVICE: [u8; 16] = [1; 16];

fn ack(ids: &[u8]) -> String {
    let ids: Vec<String> = ids.iter().map(|i| b64(&[*i; 16])).collect();
    serde_json::json!({"type": "ack", "envelope_ids": ids}).to_string()
}

#[test]
fn a_valid_ack_and_ping_are_understood() {
    assert_eq!(
        parse_incoming(&ack(&[1, 2])),
        Ok(Incoming::Ack(vec![[1; 16], [2; 16]]))
    );
    assert_eq!(parse_incoming(r#"{"type":"ping"}"#), Ok(Incoming::Ping));
}

#[test]
fn everything_else_from_a_device_is_refused() {
    let bad = [
        "not json",
        "[]",
        r#"{"type":"envelope","envelope_id":"AAAAAAAAAAAAAAAAAAAAAA","ciphertext":"A","enqueued_at":1}"#,
        r#"{"type":"queue-empty"}"#,
        r#"{"type":"ping","extra":1}"#,
        r#"{"type":"ack","envelope_ids":[]}"#,
        r#"{"type":"ack","envelope_ids":["short"]}"#,
        r#"{"type":"ack"}"#,
        r#"{"type":7}"#,
        r"{}",
    ];
    for text in bad {
        assert_eq!(parse_incoming(text), Err(FrameError::Invalid), "{text}");
    }
}

#[test]
fn an_ack_of_more_than_100_ids_is_refused() {
    let many: Vec<u8> = vec![1; 101];
    assert_eq!(parse_incoming(&ack(&many)), Err(FrameError::Invalid));
}

#[test]
fn oversized_frames_are_refused_before_parsing() {
    let big = format!(r#"{{"type":"ping","pad":"{}"}}"#, "x".repeat(9_000));
    assert_eq!(parse_incoming(&big), Err(FrameError::TooLarge));
    assert_eq!(FrameError::TooLarge.code(), "too_large");
    assert_eq!(FrameError::Invalid.code(), "invalid_request");
}

#[test]
fn the_size_limit_is_exact() {
    let ping = r#"{"type":"ping"}"#;
    let at_limit = format!("{ping}{}", " ".repeat(8_192 - ping.len()));
    assert_eq!(at_limit.len(), 8_192);
    assert_eq!(
        parse_incoming(&at_limit),
        Ok(Incoming::Ping),
        "exactly 8 KiB is allowed"
    );
    let over = format!("{at_limit} ");
    assert_eq!(
        parse_incoming(&over),
        Err(FrameError::TooLarge),
        "one byte more is not"
    );
}

#[test]
fn every_frame_the_server_sends_matches_its_published_schema() {
    let e = Envelope {
        id: [3; 16],
        ciphertext: vec![9; 40],
        enqueued_at: 1_700_000_000,
        seq: 1,
    };
    for (schema, frame) in [
        ("ws-envelope", envelope_frame(&e)),
        ("ws-queue-empty", queue_empty_frame()),
        ("ws-error", error_frame("rate_limited")),
        ("ws-device-unlinked", unlinked_frame(true)),
        ("ws-device-unlinked", unlinked_frame(false)),
    ] {
        assert!(
            validate(schema, frame.as_bytes()).is_ok(),
            "{schema}: {frame}"
        );
    }
}

#[test]
fn the_session_token_is_found_only_in_a_well_formed_offer() {
    let token = b64(&[5; 32]);
    assert_eq!(
        token_from_protocols(&format!("chat.v1, auth.{token}")),
        Some([5; 32])
    );
    assert_eq!(
        token_from_protocols(&format!("auth.{token},chat.v1")),
        Some([5; 32])
    );
    let bad = [
        format!("auth.{token}"),
        "chat.v1".to_string(),
        format!("chat.v1, auth.{token}, auth.{token}"),
        "chat.v1, auth.short".to_string(),
        "chat.v1, auth.!!!!".to_string(),
        String::new(),
    ];
    for offer in bad {
        assert_eq!(token_from_protocols(&offer), None, "{offer}");
    }
}

#[test]
fn a_flood_of_frames_is_cut_off_and_the_budget_resets_each_window() {
    let start = Instant::now();
    let mut budget = FrameBudget::new(start);
    assert!((0..100).all(|_| budget.allow(start)));
    assert!(
        !budget.allow(start),
        "the 101st frame in a window is refused"
    );
    assert!(
        budget.allow(start + Duration::from_secs(10)),
        "a new window starts fresh"
    );
}

#[tokio::test]
async fn the_backlog_is_sent_once_in_order_across_pages_and_then_only_new_items() {
    let outbox = MemoryOutbox::default();
    for i in 1..=120u8 {
        outbox.add(DEVICE, i, u64::from(i));
    }
    outbox.add([2; 16], 200, 5);
    let mut cursor = Cursor::default();
    let frames = flush(&outbox, &DEVICE, &mut cursor).await.unwrap();
    assert_eq!(
        frames.len(),
        120,
        "another device's envelope is not included"
    );
    assert!(frames[0].contains(&b64(&[1; 16])) && frames[119].contains(&b64(&[120; 16])));
    assert_eq!(cursor, Cursor { seq: 120 });
    assert!(
        flush(&outbox, &DEVICE, &mut cursor)
            .await
            .unwrap()
            .is_empty()
    );
    outbox.add(DEVICE, 121, 130);
    assert_eq!(flush(&outbox, &DEVICE, &mut cursor).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_failing_queue_is_reported() {
    let outbox = MemoryOutbox::default();
    *outbox.broken.lock().unwrap() = true;
    assert!(
        flush(&outbox, &DEVICE, &mut Cursor::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_ack_removes_only_the_devices_own_envelopes() {
    let outbox = MemoryOutbox::default();
    outbox.add(DEVICE, 1, 1);
    outbox.add(DEVICE, 2, 2);
    outbox.add([2; 16], 1, 1);
    handle_frame(&outbox, &DEVICE, &ack(&[1])).await.unwrap();
    assert_eq!(outbox.ids_for(DEVICE), vec![2]);
    assert_eq!(
        outbox.ids_for([2; 16]),
        vec![1],
        "same id on another device is untouched"
    );
    assert_eq!(
        handle_frame(&outbox, &DEVICE, r#"{"type":"ping"}"#).await,
        Ok(())
    );
    assert_eq!(
        handle_frame(&outbox, &DEVICE, "junk").await,
        Err("invalid_request")
    );
}
