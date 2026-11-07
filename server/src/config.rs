//! Configuration comes from the environment only (a secrets manager injects it). There is no
//! config file, so there is no file in which a secret could be committed or leaked.

use std::fmt;
use std::net::SocketAddr;

/// Reads one environment variable. Injected so tests do not touch the real environment.
pub trait Env {
    fn get(&self, key: &str) -> Option<String>;
}

pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    Invalid(&'static str),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(name) => write!(f, "{name} is required"),
            Self::Invalid(name) => write!(f, "{name} is invalid"),
        }
    }
}

pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub session_ttl_secs: u64,
    /// Paths to the TLS certificate chain and private key. There is no plaintext mode.
    pub tls_cert_path: String,
    pub tls_key_path: String,
}

const DEFAULT_BIND: &str = "127.0.0.1:8080";
/// Sessions are short-lived (Constitution: Authentication & sessions).
const DEFAULT_SESSION_TTL_SECS: u64 = 900;
const MAX_SESSION_TTL_SECS: u64 = 900;

impl Config {
    pub fn load(env: &impl Env) -> Result<Self, ConfigError> {
        let bind = env
            .get("BIND_ADDR")
            .unwrap_or_else(|| DEFAULT_BIND.to_string());
        let bind_addr = bind
            .parse()
            .map_err(|_| ConfigError::Invalid("BIND_ADDR"))?;
        let database_url = env
            .get("DATABASE_URL")
            .ok_or(ConfigError::Missing("DATABASE_URL"))?;
        if !database_url.starts_with("postgres://") && !database_url.starts_with("postgresql://") {
            return Err(ConfigError::Invalid("DATABASE_URL"));
        }
        let tls_cert_path = env
            .get("TLS_CERT_FILE")
            .ok_or(ConfigError::Missing("TLS_CERT_FILE"))?;
        let tls_key_path = env
            .get("TLS_KEY_FILE")
            .ok_or(ConfigError::Missing("TLS_KEY_FILE"))?;
        Ok(Self {
            bind_addr,
            database_url,
            session_ttl_secs: session_ttl(env)?,
            tls_cert_path,
            tls_key_path,
        })
    }
}

fn session_ttl(env: &impl Env) -> Result<u64, ConfigError> {
    match env.get("SESSION_TTL_SECS") {
        None => Ok(DEFAULT_SESSION_TTL_SECS),
        Some(text) => match text.parse::<u64>() {
            Ok(secs) if (1..=MAX_SESSION_TTL_SECS).contains(&secs) => Ok(secs),
            _ => Err(ConfigError::Invalid("SESSION_TTL_SECS")),
        },
    }
}

/// The database URL holds a password, so it never appears in debug output.
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("bind_addr", &self.bind_addr)
            .field("database_url", &"<redacted>")
            .field("session_ttl_secs", &self.session_ttl_secs)
            .field("tls_cert_path", &self.tls_cert_path)
            .field("tls_key_path", &self.tls_key_path)
            .finish()
    }
}
