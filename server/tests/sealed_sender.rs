//! Sealed-sender delivery: the server learns where an envelope goes, never who sent it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::app::{b64, start};
use common::{artifact, assert_nothing_leaked, secret};
use serde_json::json;

#[tokio::test]
async fn delivery_with_a_revoked_or_unknown_token_is_refused_and_queues_nothing() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let token = minted.body["token"].as_str().unwrap();
    let id = minted.body["token_id"].as_str().unwrap();
    let send = |t: String| json!({"token": t, "ciphertext": b64(&[1u8; 200])});

    assert_eq!(
        app.call("POST", "/v1/deliver", None, Some(&send(b64(&[8u8; 32]))))
            .await
            .status,
        401
    );
    app.call(
        "DELETE",
        &format!("/v1/delivery-tokens/{id}"),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(
        app.call("POST", "/v1/deliver", None, Some(&send(token.to_string())))
            .await
            .status,
        401
    );
    let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM envelopes")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(queued, 0);
}

#[tokio::test]
async fn refused_deliveries_look_the_same_whatever_the_reason() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let id = minted.body["token_id"].as_str().unwrap();
    app.call(
        "DELETE",
        &format!("/v1/delivery-tokens/{id}"),
        Some(&alice.token),
        None,
    )
    .await;
    let body = |t: &str| json!({"token": t, "ciphertext": b64(&[1u8; 50])});
    let revoked = app
        .call(
            "POST",
            "/v1/deliver",
            None,
            Some(&body(minted.body["token"].as_str().unwrap())),
        )
        .await;
    let unknown = app
        .call("POST", "/v1/deliver", None, Some(&body(&b64(&[4u8; 32]))))
        .await;
    assert_eq!(
        (revoked.status, &revoked.body),
        (unknown.status, &unknown.body)
    );
}

#[tokio::test]
async fn the_envelope_record_has_no_place_for_a_sender() {
    let app = start().await;
    let columns = app.columns("envelopes").await;
    assert_eq!(
        columns,
        [
            "seq",
            "envelope_id",
            "recipient_device_id",
            "ciphertext",
            "enqueued_at",
            "expires_at"
        ]
    );
}

#[tokio::test]
async fn a_sender_who_is_logged_in_is_still_not_recorded() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let bob = app.sign_up(&app.seed_invite(1).await, 2).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let token = minted.body["token"].as_str().unwrap();

    // Bob (wrongly, or by habit) attaches his session token to the delivery.
    let reply = app
        .call(
            "POST",
            "/v1/deliver",
            Some(&bob.token),
            Some(&json!({"token": token, "ciphertext": b64(&[7u8; 400])})),
        )
        .await;
    assert_eq!(reply.status, 201, "{}", reply.raw);

    let sender = [
        secret("sender device id", &common::app::unb64(&bob.device_id)),
        secret("sender account id", &common::app::unb64(&bob.account_id)),
        secret("sender session token", &common::app::unb64(&bob.token)),
    ];
    let stored: Vec<_> = app
        .dump()
        .await
        .into_iter()
        .filter(|a| {
            a.source == "table envelopes"
                || a.source == "table abuse_counters"
                || a.source == "table audit_log"
        })
        .collect();
    assert_eq!(stored.len(), 3);
    assert_nothing_leaked(&stored, &sender);
    assert_nothing_leaked(&[artifact("response", reply.raw.as_bytes())], &sender);
}

#[tokio::test]
async fn deliveries_are_rate_limited_per_token_without_naming_anyone() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let body = json!({"token": minted.body["token"], "ciphertext": b64(&[1u8; 50])});
    for _ in 0..60 {
        assert_eq!(
            app.call("POST", "/v1/deliver", None, Some(&body))
                .await
                .status,
            201
        );
    }
    let over = app.call("POST", "/v1/deliver", None, Some(&body)).await;
    assert_eq!(over.status, 429, "{}", over.raw);
    let buckets: Vec<String> = sqlx::query_scalar("SELECT bucket FROM abuse_counters")
        .fetch_all(&app.pool)
        .await
        .unwrap();
    assert!(buckets.iter().all(|b| b.len() <= 64));
}
