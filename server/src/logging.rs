//! Structured, tamper-evident logging (Constitution XII, Data handling).
//!
//! What can be logged is limited by type: numbers, flags, fixed labels and truncated IP
//! addresses. There is no way to log a string that came from a request, so content, keys and
//! tokens cannot reach a log by accident. Each line commits to the one before it with SHA-256,
//! so removing, editing or reordering lines is detectable. Cutting lines off the end is not
//! detectable from the lines alone, so the latest hash must be anchored elsewhere.

use crate::ports::Clock;
use serde_json::{Map, Value as Json, json};
use sha2::{Digest, Sha256};
use std::net::IpAddr;

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// An IP address with the host part removed (IPv4 to /24, IPv6 to /48). Full addresses are never logged.
#[derive(Debug, PartialEq, Eq)]
pub struct TruncatedIp(String);

impl TruncatedIp {
    pub fn new(ip: IpAddr) -> Self {
        let text = match ip {
            IpAddr::V4(v4) => {
                let o = v4.octets();
                format!("{}.{}.{}.0", o[0], o[1], o[2])
            }
            IpAddr::V6(v6) => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}::", s[0], s[1], s[2])
            }
        };
        Self(text)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The only kinds of value a log field can hold.
pub enum Value {
    Count(u64),
    Flag(bool),
    Label(&'static str),
    Ip(TruncatedIp),
}

impl Value {
    fn to_json(&self) -> Json {
        match self {
            Self::Count(n) => json!(n),
            Self::Flag(b) => json!(b),
            Self::Label(s) => json!(s),
            Self::Ip(ip) => json!(ip.0),
        }
    }
}

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

pub trait LogSink {
    fn write_line(&mut self, line: &str);
}

impl LogSink for Vec<String> {
    fn write_line(&mut self, line: &str) {
        self.push(line.to_string());
    }
}

/// Writes lines to standard output for the platform's log collector.
pub struct StdoutSink;

impl LogSink for StdoutSink {
    fn write_line(&mut self, line: &str) {
        println!("{line}");
    }
}

pub struct Logger<S: LogSink, C: Clock> {
    sink: S,
    clock: C,
    prev: String,
}

fn hash_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl<S: LogSink, C: Clock> Logger<S, C> {
    pub fn new(sink: S, clock: C) -> Self {
        Self {
            sink,
            clock,
            prev: GENESIS.to_string(),
        }
    }

    /// Hands back the sink, for tests that read what was written.
    pub fn into_sink(self) -> S {
        self.sink
    }

    pub fn log(&mut self, level: Level, event: &'static str, fields: &[(&'static str, Value)]) {
        let fields: Map<String, Json> = fields
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.to_json()))
            .collect();
        let mut line = Map::new();
        line.insert("at".into(), json!(self.clock.now_secs()));
        line.insert("level".into(), json!(level.as_str()));
        line.insert("event".into(), json!(event));
        line.insert("fields".into(), Json::Object(fields));
        line.insert("prev".into(), json!(self.prev));
        let hash = hash_hex(&Json::Object(line.clone()).to_string());
        line.insert("hash".into(), json!(hash));
        self.sink.write_line(&Json::Object(line).to_string());
        self.prev = hash;
    }
}

/// Checks that every line commits to the one before it. Returns the index of the first bad line.
pub fn verify_chain(lines: &[String]) -> Result<(), usize> {
    let mut prev = GENESIS.to_string();
    for (i, text) in lines.iter().enumerate() {
        let Ok(Json::Object(mut line)) = serde_json::from_str::<Json>(text) else {
            return Err(i);
        };
        let Some(Json::String(hash)) = line.remove("hash") else {
            return Err(i);
        };
        let links_back = line.get("prev") == Some(&json!(prev));
        if !links_back || hash_hex(&Json::Object(line).to_string()) != hash {
            return Err(i);
        }
        prev = hash;
    }
    Ok(())
}
