//! Relay server: routes opaque ciphertext and stores only what the Data Inventory lists.

use axum::{Router, routing::get};

pub mod ports;

/// Liveness probe. Carries no user data.
async fn healthz() -> &'static str {
    "ok"
}

/// Builds the HTTP router. Endpoints are added story by story from `contracts/http-api.md`.
pub fn router() -> Router {
    Router::new().route("/healthz", get(healthz))
}

#[cfg(test)]
mod tests {
    use super::healthz;

    #[tokio::test]
    async fn healthz_reports_ok() {
        assert_eq!(healthz().await, "ok");
    }
}
