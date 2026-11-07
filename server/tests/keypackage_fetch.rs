//! Key-package fetch and Invite redemption need no account, and the server records nothing about
//! who asks.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::app::{START, b64, start};
use serde_json::json;

fn contact_invite() -> serde_json::Value {
    json!({"kind": "contact", "expires_at": START + 3600, "max_uses": 5})
}

#[tokio::test]
async fn both_endpoints_work_without_credentials_and_ignore_any_that_are_sent() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let bob = app.sign_up(&app.seed_invite(1).await, 2).await;
    let invite = app
        .call(
            "POST",
            "/v1/invites",
            Some(&alice.token),
            Some(&contact_invite()),
        )
        .await;
    let request = json!({"invite_token": invite.body["invite_token"]});

    let anonymous = app
        .call("POST", "/v1/invites/redeem", None, Some(&request))
        .await;
    assert_eq!(anonymous.status, 200, "{}", anonymous.raw);
    let with_credentials = app
        .call(
            "POST",
            "/v1/invites/redeem",
            Some(&bob.token),
            Some(&request),
        )
        .await;
    assert_eq!(with_credentials.status, 200);
    let token = anonymous.body["devices"][0]["delivery_token"].clone();
    let fetch = app
        .call(
            "POST",
            "/v1/key-packages/fetch",
            None,
            Some(&json!({"token": token})),
        )
        .await;
    assert_eq!(fetch.status, 200, "{}", fetch.raw);
    // A garbage Authorization header does not matter either.
    let odd = app
        .call(
            "POST",
            "/v1/key-packages/fetch",
            Some("garbage"),
            Some(&json!({"token": token})),
        )
        .await;
    assert_ne!(odd.status, 401, "{}", odd.raw);
}

fn shape(bucket: &str) -> bool {
    let rest = bucket.split_once(':').map_or("", |(_, r)| r);
    rest.starts_with("h:") || rest.starts_with("ip:")
}

#[tokio::test]
async fn rate_limit_counters_are_named_by_network_prefix_or_token_hash_only() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let bob = app.sign_up(&app.seed_invite(1).await, 2).await;
    let invite = app
        .call(
            "POST",
            "/v1/invites",
            Some(&alice.token),
            Some(&contact_invite()),
        )
        .await;
    let request = json!({"invite_token": invite.body["invite_token"]});
    let redeemed = app
        .call(
            "POST",
            "/v1/invites/redeem",
            Some(&bob.token),
            Some(&request),
        )
        .await;
    let token = redeemed.body["devices"][0]["delivery_token"].clone();
    app.call(
        "POST",
        "/v1/key-packages/fetch",
        Some(&bob.token),
        Some(&json!({"token": token})),
    )
    .await;

    let buckets: Vec<String> = sqlx::query_scalar(
        "SELECT bucket FROM abuse_counters WHERE bucket LIKE 'kpfetch:%' OR bucket LIKE 'redeem:%'",
    )
    .fetch_all(&app.pool)
    .await
    .unwrap();
    assert_eq!(buckets.len(), 2);
    assert!(buckets.iter().all(|b| shape(b)), "{buckets:?}");
    assert!(
        buckets.iter().any(|b| b == "redeem:ip:127.0.0.0"),
        "{buckets:?}"
    );
    let requester = [
        bob.device_id.clone(),
        bob.account_id.clone(),
        bob.token.clone(),
    ];
    for bucket in &buckets {
        assert!(requester.iter().all(|r| !bucket.contains(r.as_str())));
    }
}

#[tokio::test]
async fn nothing_but_expected_counters_changes_when_someone_fetches() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let invite = app
        .call(
            "POST",
            "/v1/invites",
            Some(&alice.token),
            Some(&contact_invite()),
        )
        .await;
    let redeemed = app
        .call(
            "POST",
            "/v1/invites/redeem",
            None,
            Some(&json!({"invite_token": invite.body["invite_token"]})),
        )
        .await;
    let token = redeemed.body["devices"][0]["delivery_token"].clone();

    let before = app.dump().await;
    app.call(
        "POST",
        "/v1/key-packages/fetch",
        None,
        Some(&json!({"token": token})),
    )
    .await;
    let after = app.dump().await;
    for (old, new) in before.iter().zip(&after) {
        let changed = old.bytes != new.bytes;
        let allowed = matches!(
            old.source.as_str(),
            "table key_packages" | "table abuse_counters"
        );
        assert!(!changed || allowed, "{} changed", old.source);
    }
}

#[tokio::test]
async fn single_use_key_packages_are_handed_out_once_then_the_last_resort_repeats() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let body = json!({"token": minted.body["token"]});
    let mut seen = Vec::new();
    for _ in 0..4 {
        let reply = app
            .call("POST", "/v1/key-packages/fetch", None, Some(&body))
            .await;
        seen.push(reply.body["key_packages"][0].as_str().unwrap().to_string());
    }
    // Sign-up stored two single-use packages (tags 1 and 2) and a last-resort one (tag 3).
    assert_eq!(seen[0], b64(&[1u8; 64]));
    assert_eq!(seen[1], b64(&[2u8; 64]));
    assert_eq!(seen[2], b64(&[3u8; 64]));
    assert_eq!(seen[3], b64(&[3u8; 64]));
}
