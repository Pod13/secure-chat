use server::config::{Config, ConfigError, Env};
use std::collections::HashMap;

struct MapEnv(HashMap<&'static str, &'static str>);

impl Env for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.0.get(key).map(|v| (*v).to_string())
    }
}

fn env(pairs: &[(&'static str, &'static str)]) -> MapEnv {
    MapEnv(pairs.iter().copied().collect())
}

const DB: (&str, &str) = ("DATABASE_URL", "postgres://user:hunter2@db/chat");
const CERT: (&str, &str) = ("TLS_CERT_FILE", "/run/secrets/cert.pem");
const KEY: (&str, &str) = ("TLS_KEY_FILE", "/run/secrets/key.pem");

#[test]
fn defaults_apply_when_only_the_database_is_given() {
    let config = Config::load(&env(&[DB, CERT, KEY])).unwrap();
    assert_eq!(config.bind_addr.to_string(), "127.0.0.1:8080");
    assert_eq!(config.session_ttl_secs, 900);
}

#[test]
fn the_database_url_is_required() {
    assert_eq!(
        Config::load(&env(&[])).unwrap_err(),
        ConfigError::Missing("DATABASE_URL")
    );
}

#[test]
fn only_postgres_urls_are_accepted() {
    let bad = env(&[("DATABASE_URL", "mysql://x"), CERT, KEY]);
    assert_eq!(
        Config::load(&bad).unwrap_err(),
        ConfigError::Invalid("DATABASE_URL")
    );
}

#[test]
fn there_is_no_plaintext_mode_so_a_certificate_and_key_are_required() {
    assert_eq!(
        Config::load(&env(&[DB, KEY])).unwrap_err(),
        ConfigError::Missing("TLS_CERT_FILE")
    );
    assert_eq!(
        Config::load(&env(&[DB, CERT])).unwrap_err(),
        ConfigError::Missing("TLS_KEY_FILE")
    );
}

#[test]
fn a_bad_bind_address_is_rejected() {
    let bad = env(&[DB, CERT, KEY, ("BIND_ADDR", "not an address")]);
    assert_eq!(
        Config::load(&bad).unwrap_err(),
        ConfigError::Invalid("BIND_ADDR")
    );
}

#[test]
fn session_lifetime_is_bounded_to_fifteen_minutes() {
    for bad in ["0", "901", "-1", "soon"] {
        let e = MapEnvOwned::with(bad);
        assert_eq!(
            Config::load(&e).unwrap_err(),
            ConfigError::Invalid("SESSION_TTL_SECS"),
            "{bad}"
        );
    }
    assert_eq!(
        Config::load(&MapEnvOwned::with("60"))
            .unwrap()
            .session_ttl_secs,
        60
    );
}

/// An environment with one session lifetime value, to loop over inputs.
struct MapEnvOwned(String);

impl MapEnvOwned {
    fn with(ttl: &str) -> Self {
        Self(ttl.to_string())
    }
}

impl Env for MapEnvOwned {
    fn get(&self, key: &str) -> Option<String> {
        match key {
            "DATABASE_URL" => Some("postgres://u:p@db/chat".to_string()),
            "TLS_CERT_FILE" => Some("/c".to_string()),
            "TLS_KEY_FILE" => Some("/k".to_string()),
            "SESSION_TTL_SECS" => Some(self.0.clone()),
            _ => None,
        }
    }
}

#[test]
fn debug_output_never_shows_the_database_password() {
    let shown = format!("{:?}", Config::load(&env(&[DB, CERT, KEY])).unwrap());
    assert!(
        !shown.contains("hunter2") && !shown.contains("postgres://"),
        "{shown}"
    );
}

#[test]
fn errors_name_the_setting_but_never_its_value() {
    assert_eq!(ConfigError::Missing("X").to_string(), "X is required");
    assert_eq!(ConfigError::Invalid("X").to_string(), "X is invalid");
}

#[test]
fn the_process_environment_is_readable() {
    use server::config::ProcessEnv;
    assert!(ProcessEnv.get("PATH").is_some());
    assert!(ProcessEnv.get("SURELY_NOT_SET_ANYWHERE_12345").is_none());
}
