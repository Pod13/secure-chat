//! Relay server: routes opaque ciphertext and stores only what the Data Inventory lists.

use axum::{
    Router, middleware,
    routing::{delete, get, post, put},
};

pub mod abuse;
pub mod accounts;
pub mod api;
pub mod auth;
pub mod config;
pub mod delivery;
pub mod logging;
pub mod ports;
pub mod retention;

/// Liveness probe. Carries no user data.
async fn healthz() -> &'static str {
    "ok"
}

/// Builds the HTTP router with only the health check (no storage needed).
pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .layer(middleware::from_fn(api::headers::add))
}

/// The whole service: the HTTP API plus the real-time channel, sharing one delivery queue.
pub fn full_router(state: api::state::AppState) -> Router {
    let ws = api::ws::WsState {
        auth: std::sync::Arc::new(state.auth_store()),
        outbox: state.queue.clone(),
        clock: std::sync::Arc::new(state.clock.clone()),
        idle_timeout: api::ws::DEFAULT_IDLE_TIMEOUT,
    };
    api_routes(state)
        .merge(api::ws::router(ws))
        .layer(middleware::from_fn(api::headers::add))
}

/// The HTTP API alone (`contracts/http-api.md`), with the standard security headers.
pub fn app_router(state: api::state::AppState) -> Router {
    api_routes(state).layer(middleware::from_fn(api::headers::add))
}

fn api_routes(state: api::state::AppState) -> Router {
    use api::routes::*;
    Router::new()
        .route("/healthz", get(healthz))
        .route("/v1/accounts", post(create_account))
        .route("/v1/auth/challenge", post(auth_challenge))
        .route("/v1/auth/token", post(auth_token))
        .route("/v1/invites", post(create_invite))
        .route("/v1/invites/redeem", post(redeem_invite))
        .route("/v1/invites/{id}", delete(revoke_invite))
        .route("/v1/delivery-tokens", post(create_delivery_token))
        .route("/v1/delivery-tokens/{id}", delete(revoke_delivery_token))
        .route("/v1/deliver", post(deliver))
        .route("/v1/devices/me/key-packages", put(put_key_packages))
        .route("/v1/key-packages/fetch", post(fetch_key_packages))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::healthz;

    #[tokio::test]
    async fn healthz_reports_ok() {
        assert_eq!(healthz().await, "ok");
    }
}
