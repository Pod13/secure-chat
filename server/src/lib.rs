//! Relay server: routes opaque ciphertext and stores only what the Data Inventory lists.

use axum::{Router, middleware, routing::get};

pub mod abuse;
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

/// Builds the HTTP router. Endpoints are added story by story from `contracts/http-api.md`.
pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .layer(middleware::from_fn(api::headers::add))
}

#[cfg(test)]
mod tests {
    use super::healthz;

    #[tokio::test]
    async fn healthz_reports_ok() {
        assert_eq!(healthz().await, "ok");
    }
}
