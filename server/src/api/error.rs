//! API errors: a stable code and status, never an echo of what the client sent (contract
//! `error-response`). Authentication failures all look the same.

use super::validate::ValidationError;
use axum::{
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, PartialEq, Eq)]
pub enum ApiError {
    Invalid,
    Unauthorized,
    NotFound,
    /// Over a rate limit; retry after this many seconds.
    TooMany(u64),
    TooLarge,
    Conflict,
    Internal,
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            Self::Invalid => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::TooMany(_) => StatusCode::TOO_MANY_REQUESTS,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Conflict => StatusCode::CONFLICT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid => "invalid_request",
            Self::Unauthorized => "unauthorized",
            Self::NotFound => "not_found",
            Self::TooMany(_) => "rate_limited",
            Self::TooLarge => "too_large",
            Self::Conflict => "conflict",
            Self::Internal => "internal",
        }
    }
}

impl From<ValidationError> for ApiError {
    fn from(error: ValidationError) -> Self {
        match error {
            ValidationError::TooLarge => Self::TooLarge,
            ValidationError::NotJson | ValidationError::Invalid => Self::Invalid,
            ValidationError::UnknownSchema | ValidationError::Internal => Self::Internal,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = match self {
            Self::TooMany(retry) => {
                json!({"code": self.code(), "retry_after": retry.clamp(1, 86_400)})
            }
            _ => json!({"code": self.code()}),
        };
        let mut response = (self.status(), body.to_string()).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if let Self::TooMany(retry) = self
            && let Ok(value) = HeaderValue::from_str(&retry.clamp(1, 86_400).to_string())
        {
            headers.insert(header::RETRY_AFTER, value);
        }
        response
    }
}
