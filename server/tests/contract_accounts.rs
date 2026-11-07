//! Contract tests for the Phase 3 endpoints (`contracts/http-api.md`): sign-up, login, Invites,
//! delivery tokens, delivery and key packages. Every success response is checked against its
//! schema in `contracts-schema/`, and every failure against `error-response`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::app::{TestApp, b64, sign_up_body, start};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use server::api::validate::validate;

fn assert_matches(schema: &str, body: &Value) {
    assert!(
        validate(schema, body.to_string().as_bytes()).is_ok(),
        "{schema}: {body}"
    );
}

fn assert_error(reply: &common::app::Reply, status: u16, code: &str) {
    assert_eq!(reply.status, status, "{}", reply.raw);
    assert_eq!(reply.body["code"], code, "{}", reply.raw);
    assert_matches("error-response", &reply.body);
}

fn keys() -> (SigningKey, SigningKey) {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    getrandom::fill(&mut a).unwrap();
    getrandom::fill(&mut b).unwrap();
    (SigningKey::from_bytes(&a), SigningKey::from_bytes(&b))
}

async fn expect_status(app: &TestApp, body: Value, status: u16, code: &str) {
    assert_error(
        &app.call("POST", "/v1/accounts", None, Some(&body)).await,
        status,
        code,
    );
}

#[tokio::test]
async fn sign_up_creates_an_account_and_a_device() {
    let app = start().await;
    let invite = app.seed_invite(1).await;
    let (identity, device) = keys();
    let reply = app
        .call(
            "POST",
            "/v1/accounts",
            None,
            Some(&sign_up_body(&identity, &device, &invite, 1)),
        )
        .await;
    assert_eq!(reply.status, 201, "{}", reply.raw);
    assert_matches("account-create-response", &reply.body);
}

#[tokio::test]
async fn sign_up_needs_a_live_invite() {
    let app = start().await;
    let (identity, device) = keys();
    let unknown = b64(&[9u8; 32]);
    expect_status(
        &app,
        sign_up_body(&identity, &device, &unknown, 1),
        401,
        "unauthorized",
    )
    .await;

    let one_use = app.seed_invite(1).await;
    app.sign_up(&one_use, 1).await;
    let (identity, device) = keys();
    expect_status(
        &app,
        sign_up_body(&identity, &device, &one_use, 2),
        401,
        "unauthorized",
    )
    .await;

    let expiring = app.seed_invite(5).await;
    app.clock.advance(86_401);
    let (identity, device) = keys();
    expect_status(
        &app,
        sign_up_body(&identity, &device, &expiring, 3),
        401,
        "unauthorized",
    )
    .await;
}

#[tokio::test]
async fn sign_up_rejects_a_certificate_that_does_not_match() {
    let app = start().await;
    let invite = app.seed_invite(5).await;
    let (identity, device) = keys();
    let (_, other_device) = keys();
    let mut body = sign_up_body(&identity, &device, &invite, 1);
    body["device_public_key"] = json!(b64(other_device.verifying_key().as_bytes()));
    expect_status(&app, body, 400, "invalid_request").await;
    // The refused attempt did not use up the Invite.
    app.sign_up(&invite, 2).await;
}

#[tokio::test]
async fn a_device_key_cannot_be_registered_twice() {
    let app = start().await;
    let invite = app.seed_invite(5).await;
    let (identity, device) = keys();
    let body = sign_up_body(&identity, &device, &invite, 1);
    assert_eq!(
        app.call("POST", "/v1/accounts", None, Some(&body))
            .await
            .status,
        201
    );
    assert_error(
        &app.call("POST", "/v1/accounts", None, Some(&body)).await,
        409,
        "conflict",
    );
}

#[tokio::test]
async fn malformed_sign_ups_are_refused_before_anything_is_stored() {
    let app = start().await;
    let invite = app.seed_invite(5).await;
    let (identity, device) = keys();
    let good = sign_up_body(&identity, &device, &invite, 1);
    let mut extra = good.clone();
    extra["username"] = json!("alice");
    let mut short = good.clone();
    short["identity_public_key"] = json!("AAAA");
    let mut none = good.clone();
    none["key_packages"] = json!([]);
    for bad in [extra, short, none, json!({})] {
        expect_status(&app, bad, 400, "invalid_request").await;
    }
    let reply = app
        .call_raw("POST", "/v1/accounts", None, Some("not json"))
        .await;
    assert_error(&reply, 400, "invalid_request");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn sign_up_attempts_are_rate_limited_by_network_prefix() {
    let app = start().await;
    let (identity, device) = keys();
    let unknown = b64(&[9u8; 32]);
    for _ in 0..5 {
        expect_status(
            &app,
            sign_up_body(&identity, &device, &unknown, 1),
            401,
            "unauthorized",
        )
        .await;
    }
    let sixth = app
        .call(
            "POST",
            "/v1/accounts",
            None,
            Some(&sign_up_body(&identity, &device, &unknown, 1)),
        )
        .await;
    assert_error(&sixth, 429, "rate_limited");
    assert!(sixth.body["retry_after"].as_u64().unwrap() >= 1);
    assert!(sixth.raw.to_lowercase().contains("retry-after:"));
}

#[tokio::test]
async fn login_returns_a_short_lived_token_and_a_wrong_signature_fails() {
    let app = start().await;
    let invite = app.seed_invite(1).await;
    let person = app.sign_up(&invite, 1).await;
    assert_eq!(person.token.len(), 43);

    let challenge = app
        .call(
            "POST",
            "/v1/auth/challenge",
            None,
            Some(&json!({"device_id": person.device_id})),
        )
        .await;
    assert_matches("auth-challenge-response", &challenge.body);
    let wrong = app
        .call(
            "POST",
            "/v1/auth/token",
            None,
            Some(&json!({"device_id": person.device_id, "signature": b64(&[1u8; 64])})),
        )
        .await;
    assert_error(&wrong, 401, "unauthorized");
}

#[tokio::test]
async fn an_unknown_device_gets_a_challenge_but_can_never_log_in() {
    let app = start().await;
    let unknown = b64(&[7u8; 16]);
    let challenge = app
        .call(
            "POST",
            "/v1/auth/challenge",
            None,
            Some(&json!({"device_id": unknown})),
        )
        .await;
    assert_eq!(challenge.status, 200);
    let reply = app
        .call(
            "POST",
            "/v1/auth/token",
            None,
            Some(&json!({"device_id": unknown, "signature": b64(&[1u8; 64])})),
        )
        .await;
    assert_error(&reply, 401, "unauthorized");
}

#[tokio::test]
async fn invites_can_be_made_and_revoked_only_by_their_owner() {
    let app = start().await;
    let owner = app.sign_up(&app.seed_invite(2).await, 1).await;
    let other = app.sign_up(&app.seed_invite(2).await, 2).await;
    let body = json!({"kind": "contact", "expires_at": common::app::START + 3600, "max_uses": 3});

    let made = app
        .call("POST", "/v1/invites", Some(&owner.token), Some(&body))
        .await;
    assert_eq!(made.status, 201, "{}", made.raw);
    assert_matches("invite-create-response", &made.body);
    let id = made.body["invite_id"].as_str().unwrap();

    assert_error(
        &app.call(
            "DELETE",
            &format!("/v1/invites/{id}"),
            Some(&other.token),
            None,
        )
        .await,
        404,
        "not_found",
    );
    assert_eq!(
        app.call(
            "DELETE",
            &format!("/v1/invites/{id}"),
            Some(&owner.token),
            None
        )
        .await
        .status,
        204
    );
    let redeem = app
        .call(
            "POST",
            "/v1/invites/redeem",
            None,
            Some(&json!({"invite_token": made.body["invite_token"]})),
        )
        .await;
    assert_error(&redeem, 401, "unauthorized");
}

#[tokio::test]
async fn invite_requests_are_checked() {
    let app = start().await;
    let owner = app.sign_up(&app.seed_invite(1).await, 1).await;
    let now = common::app::START;
    let bad = [
        json!({"kind": "contact", "expires_at": now - 1, "max_uses": 1}),
        json!({"kind": "contact", "expires_at": now + 91 * 86_400, "max_uses": 1}),
        json!({"kind": "contact", "expires_at": now + 60, "max_uses": 0}),
        json!({"kind": "contact", "expires_at": now + 60, "max_uses": 1001}),
        json!({"kind": "other", "expires_at": now + 60, "max_uses": 1}),
    ];
    for body in bad {
        assert_error(
            &app.call("POST", "/v1/invites", Some(&owner.token), Some(&body))
                .await,
            400,
            "invalid_request",
        );
    }
    let ok = json!({"kind": "contact", "expires_at": now + 60, "max_uses": 1});
    assert_error(
        &app.call("POST", "/v1/invites", None, Some(&ok)).await,
        401,
        "unauthorized",
    );
    assert_error(
        &app.call("POST", "/v1/invites", Some("garbage"), Some(&ok))
            .await,
        401,
        "unauthorized",
    );
}

#[tokio::test]
async fn delivery_tokens_carry_envelopes_and_revoking_one_stops_it() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    assert_eq!(minted.status, 201, "{}", minted.raw);
    assert_matches("delivery-token-create-response", &minted.body);
    let token = minted.body["token"].as_str().unwrap();
    let id = minted.body["token_id"].as_str().unwrap();

    let sent = app
        .call(
            "POST",
            "/v1/deliver",
            None,
            Some(&json!({"token": token, "ciphertext": b64(&[5u8; 300])})),
        )
        .await;
    assert_eq!(sent.status, 201, "{}", sent.raw);
    assert_matches("deliver-response", &sent.body);

    assert_eq!(
        app.call(
            "DELETE",
            &format!("/v1/delivery-tokens/{id}"),
            Some(&alice.token),
            None
        )
        .await
        .status,
        204
    );
    let after = app
        .call(
            "POST",
            "/v1/deliver",
            None,
            Some(&json!({"token": token, "ciphertext": b64(&[5u8; 300])})),
        )
        .await;
    assert_error(&after, 401, "unauthorized");
}

#[tokio::test]
async fn key_packages_can_be_added_and_fetched_with_a_delivery_token() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 10).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let token = minted.body["token"].as_str().unwrap();
    let put = app
        .call(
            "PUT",
            "/v1/devices/me/key-packages",
            Some(&alice.token),
            Some(&json!({"key_packages": [b64(&[77u8; 64])]})),
        )
        .await;
    assert_eq!(put.status, 204, "{}", put.raw);

    let fetched = app
        .call(
            "POST",
            "/v1/key-packages/fetch",
            None,
            Some(&json!({"token": token})),
        )
        .await;
    assert_eq!(fetched.status, 200, "{}", fetched.raw);
    assert_matches("key-packages-fetch-response", &fetched.body);

    let unknown = app
        .call(
            "POST",
            "/v1/key-packages/fetch",
            None,
            Some(&json!({"token": b64(&[3u8; 32])})),
        )
        .await;
    assert_error(&unknown, 401, "unauthorized");
}

#[tokio::test]
async fn redeeming_a_contact_invite_returns_tokens_and_key_packages() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 20).await;
    let body = json!({"kind": "contact", "expires_at": common::app::START + 3600, "max_uses": 1});
    let invite = app
        .call("POST", "/v1/invites", Some(&alice.token), Some(&body))
        .await;
    let request = json!({"invite_token": invite.body["invite_token"]});
    let redeemed = app
        .call("POST", "/v1/invites/redeem", None, Some(&request))
        .await;
    assert_eq!(redeemed.status, 200, "{}", redeemed.raw);
    assert_matches("invite-redeem-response", &redeemed.body);
    assert_eq!(redeemed.body["devices"].as_array().unwrap().len(), 1);
    // One use only.
    assert_error(
        &app.call("POST", "/v1/invites/redeem", None, Some(&request))
            .await,
        401,
        "unauthorized",
    );
}

#[tokio::test]
async fn a_service_invite_cannot_be_redeemed_as_a_contact_invite() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 30).await;
    let body = json!({"kind": "service", "expires_at": common::app::START + 3600, "max_uses": 1});
    let invite = app
        .call("POST", "/v1/invites", Some(&alice.token), Some(&body))
        .await;
    let request = json!({"invite_token": invite.body["invite_token"]});
    assert_error(
        &app.call("POST", "/v1/invites/redeem", None, Some(&request))
            .await,
        401,
        "unauthorized",
    );
    // But it does work for sign-up.
    let invite_token = invite.body["invite_token"].as_str().unwrap().to_string();
    app.sign_up(&invite_token, 31).await;
}

#[tokio::test]
async fn invite_lifetimes_are_inclusive_at_ninety_days_and_must_end_in_the_future() {
    let app = start().await;
    let owner = app.sign_up(&app.seed_invite(1).await, 1).await;
    let now = common::app::START;
    let make =
        |expires_at: u64| json!({"kind": "contact", "expires_at": expires_at, "max_uses": 1});
    let ninety = 90 * 24 * 60 * 60;
    assert_eq!(
        app.call(
            "POST",
            "/v1/invites",
            Some(&owner.token),
            Some(&make(now + ninety))
        )
        .await
        .status,
        201
    );
    assert_eq!(
        app.call(
            "POST",
            "/v1/invites",
            Some(&owner.token),
            Some(&make(now + ninety + 1))
        )
        .await
        .status,
        400
    );
    assert_eq!(
        app.call("POST", "/v1/invites", Some(&owner.token), Some(&make(now)))
            .await
            .status,
        400
    );
    assert_eq!(
        app.call(
            "POST",
            "/v1/invites",
            Some(&owner.token),
            Some(&make(now + 1))
        )
        .await
        .status,
        201
    );
}

#[tokio::test]
async fn size_limits_are_inclusive() {
    let app = start().await;
    let (identity, device) = keys();
    let invite = app.seed_invite(2).await;
    let mut body = sign_up_body(&identity, &device, &invite, 1);
    body["key_packages"] = json!([b64(&vec![1u8; 4096])]);
    body["last_resort_key_package"] = json!(b64(&vec![2u8; 4096]));
    body["label_blob"] = json!(b64(&vec![3u8; 1024]));
    assert_eq!(
        app.call("POST", "/v1/accounts", None, Some(&body))
            .await
            .status,
        201
    );

    let alice = app.sign_up(&invite, 2).await;
    let minted = app
        .call("POST", "/v1/delivery-tokens", Some(&alice.token), None)
        .await;
    let send =
        |len: usize| json!({"token": minted.body["token"], "ciphertext": b64(&vec![9u8; len])});
    assert_eq!(
        app.call("POST", "/v1/deliver", None, Some(&send(131_072)))
            .await
            .status,
        201
    );
    assert_eq!(
        app.call("POST", "/v1/deliver", None, Some(&send(131_073)))
            .await
            .status,
        400
    );
}

#[tokio::test]
async fn too_many_key_packages_are_refused() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let fill =
        |n: usize| json!({"key_packages": (0..n).map(|i| b64(&[i as u8; 32])).collect::<Vec<_>>()});
    assert_eq!(
        app.call(
            "PUT",
            "/v1/devices/me/key-packages",
            Some(&alice.token),
            Some(&fill(98))
        )
        .await
        .status,
        204
    );
    // Two were stored at sign-up, so 100 is full.
    let over = app
        .call(
            "PUT",
            "/v1/devices/me/key-packages",
            Some(&alice.token),
            Some(&fill(1)),
        )
        .await;
    assert_error(&over, 409, "conflict");
}
