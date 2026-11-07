//! Account creation must leave no stored link between the Invite and the new Account.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::app::{START, b64, start};
use common::{artifact, assert_nothing_leaked, secret};
use serde_json::json;

#[tokio::test]
async fn nothing_stored_ties_an_account_to_the_invite_it_used() {
    let app = start().await;
    let invite = app.seed_invite(3).await;
    let token = common::app::unb64(&invite);
    let hash = server::accounts::sha256(&token);
    let people = [app.sign_up(&invite, 1).await, app.sign_up(&invite, 2).await];

    let looking_for = [
        secret("invite token", &token),
        secret("invite token hash", &hash),
        secret("invite id", &hash[..16]),
    ];
    let elsewhere: Vec<_> = app
        .dump()
        .await
        .into_iter()
        .filter(|a| a.source != "table invites")
        .collect();
    assert!(elsewhere.len() >= 10);
    assert_nothing_leaked(&elsewhere, &looking_for);

    // The only trace of the sign-ups is a count on the Invite itself.
    let uses: i32 = sqlx::query_scalar("SELECT uses FROM invites")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(uses, 2);
    assert_eq!(people.len(), 2);
}

#[tokio::test]
async fn the_invite_record_has_no_place_for_a_redeemer_and_accounts_have_none_for_an_invite() {
    let app = start().await;
    assert_eq!(
        app.columns("invites").await,
        [
            "token_hash",
            "kind",
            "owner_account_id",
            "expires_at",
            "max_uses",
            "uses",
            "revoked"
        ]
    );
    for table in ["accounts", "devices", "key_packages"] {
        for column in app.columns(table).await {
            assert!(!column.contains("invite"), "{table}.{column}");
        }
    }
}

#[tokio::test]
async fn account_dates_are_days_not_moments() {
    let app = start().await;
    let invite = app.seed_invite(1).await;
    app.sign_up(&invite, 1).await;
    let kinds: Vec<String> = sqlx::query_scalar(
        "SELECT data_type::text FROM information_schema.columns WHERE table_schema = current_schema() \
         AND table_name = 'accounts' AND column_name IN ('created_on', 'last_connected_on')",
    )
    .fetch_all(&app.pool)
    .await
    .unwrap();
    assert_eq!(kinds, ["date", "date"]);
}

#[tokio::test]
async fn a_failed_sign_up_does_not_use_up_the_invite() {
    let app = start().await;
    let invite = app.seed_invite(1).await;
    let mut body = common::app::sign_up_body(&ed(1), &ed(2), &invite, 1);
    body["device_certificate"] = json!(b64(&[0u8; 64]));
    assert_eq!(
        app.call("POST", "/v1/accounts", None, Some(&body))
            .await
            .status,
        400
    );
    let uses: i32 = sqlx::query_scalar("SELECT uses FROM invites")
        .fetch_one(&app.pool)
        .await
        .unwrap();
    assert_eq!(uses, 0);
    let _ = (START, artifact("x", b""));
}

fn ed(n: u8) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[n; 32])
}
