//! Server-adversary test for a full chat (Constitution I): two people sign up, become Contacts
//! and exchange messages through the server. An attacker with every table, queue and response
//! looks for anything the user considers secret: the message text, usernames, the Contact list,
//! the recovery phrase and every private key.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::app::{b64, start};
use common::{artifact, assert_nothing_leaked, secret};
use serde_json::json;

#[tokio::test]
async fn a_full_chat_leaves_no_plaintext_username_contact_or_key_on_the_server() {
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let bob = app.sign_up(&app.seed_invite(1).await, 2).await;

    // Alice invites Bob; Bob redeems the Invite and gets a way to reach Alice.
    let body = json!({"kind": "contact", "expires_at": common::app::START + 3600, "max_uses": 1});
    let invite = app
        .call("POST", "/v1/invites", Some(&alice.token), Some(&body))
        .await;
    let redeemed = app
        .call(
            "POST",
            "/v1/invites/redeem",
            None,
            Some(&json!({"invite_token": invite.body["invite_token"]})),
        )
        .await;
    let to_alice = redeemed.body["devices"][0]["delivery_token"]
        .as_str()
        .unwrap()
        .to_string();

    // Bob sends a few messages. What the server gets is ciphertext: here, bytes that merely look
    // random, because the real encryption happens on the device.
    let mut transcript = String::new();
    for i in 0..3u8 {
        let reply = app
            .call(
                "POST",
                "/v1/deliver",
                Some(&bob.token),
                Some(&json!({"token": to_alice, "ciphertext": b64(&[i + 9; 600])})),
            )
            .await;
        assert_eq!(reply.status, 201, "{}", reply.raw);
        transcript.push_str(&reply.raw);
    }

    // Things only the people in the chat know. None of them is ever sent to the server.
    let secrets = [
        secret("message text", b"meet at the old bridge at nine tonight"),
        secret("alice username", b"alice-wonder-1999"),
        secret("bob username", b"bob-the-builder-77"),
        secret("contact list entry", b"Charlie Contact Person"),
        secret(
            "recovery phrase",
            b"correct horse battery staple twelve words",
        ),
        secret("alice identity private key", &alice.identity.to_bytes()),
        secret("alice device private key", &alice.device.to_bytes()),
        secret("bob identity private key", &bob.identity.to_bytes()),
        secret("bob device private key", &bob.device.to_bytes()),
    ];

    let mut artifacts = app.dump().await;
    artifacts.push(artifact("responses", transcript.as_bytes()));
    assert!(artifacts.len() >= 10, "the dump should cover every table");
    assert_nothing_leaked(&artifacts, &secrets);
}

#[tokio::test]
async fn the_dump_does_include_what_the_server_legitimately_holds() {
    // Guards the test above: if the dump were empty it would pass for the wrong reason.
    let app = start().await;
    let alice = app.sign_up(&app.seed_invite(1).await, 1).await;
    let artifacts = app.dump().await;
    let legitimate = [secret(
        "alice device public key",
        alice.device.verifying_key().as_bytes(),
    )];
    let found = common::scan(&artifacts, &legitimate);
    assert!(
        !found.is_empty(),
        "the dump should contain the Device public key"
    );
}
