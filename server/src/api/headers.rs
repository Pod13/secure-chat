//! Security headers on every response (Constitution VII, Transport). No third-party origins
//! are ever allowed, and the page policy forbids inline and eval'd script.

use axum::{
    extract::Request,
    http::{HeaderName, HeaderValue},
    middleware::Next,
    response::Response,
};

/// Policy for API responses: nothing may load or be framed.
pub const API_CSP: &str =
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/// Policy for the web app's HTML: own origin only, no inline or eval'd script, Trusted Types.
pub const APP_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; \
    connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; \
    manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; \
    frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types app";

pub const HEADERS: [(&str, &str); 9] = [
    (
        "strict-transport-security",
        "max-age=63072000; includeSubDomains; preload",
    ),
    ("content-security-policy", API_CSP),
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "same-origin"),
    (
        "permissions-policy",
        "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
    ),
    ("cache-control", "no-store"),
    ("x-frame-options", "DENY"),
];

/// Adds the headers to a response, replacing any the handler set with the same name.
pub async fn add(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in HEADERS {
        response.headers_mut().insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    response
}
