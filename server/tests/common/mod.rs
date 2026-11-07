//! Server-adversary harness (Constitution I). It plays a fully compromised server: given
//! everything the server can see (database dump, blobs, logs, metrics), it looks for secrets
//! the test planted, in every encoding a careless implementation might store them in.

#![allow(dead_code)]

pub mod app;
pub mod db;

pub struct Artifact {
    pub source: String,
    pub bytes: Vec<u8>,
}

pub struct Secret {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Finding {
    pub secret: String,
    pub encoding: &'static str,
    pub source: String,
}

pub const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/// Secrets shorter than this would match by chance.
const MIN_SECRET_LEN: usize = 8;
const KEY_MARKERS: [&str; 3] = [
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
];

pub fn base64(data: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(alphabet[((n >> (18 - 6 * i)) & 63) as usize]));
        }
        if pad {
            out.extend(std::iter::repeat_n('=', 3 - chunk.len()));
        }
    }
    out
}

fn hex(data: &[u8], upper: bool) -> String {
    data.iter()
        .map(|b| {
            if upper {
                format!("{b:02X}")
            } else {
                format!("{b:02x}")
            }
        })
        .collect()
}

/// Base64 text of `secret` that is stable wherever the secret starts inside a larger message.
/// A stored secret may sit at any of three alignments, so each is encoded with leading filler
/// and the characters that depend on neighbouring bytes are trimmed away.
fn aligned_base64(secret: &[u8], alphabet: &[u8; 64]) -> Vec<String> {
    (0..3usize)
        .filter_map(|lead| {
            let mut data = vec![0u8; lead];
            data.extend_from_slice(secret);
            let text = base64(&data, alphabet, false);
            let head = [0, 2, 3][lead];
            let tail = [0, 2, 1][data.len() % 3];
            (text.len() > head + tail).then(|| text[head..text.len() - tail].to_string())
        })
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

fn encodings(secret: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let mut all = vec![
        ("raw", secret.to_vec()),
        ("hex", hex(secret, false).into_bytes()),
        ("HEX", hex(secret, true).into_bytes()),
    ];
    for t in aligned_base64(secret, STD) {
        all.push(("base64", t.into_bytes()));
    }
    for t in aligned_base64(secret, URL) {
        all.push(("base64url", t.into_bytes()));
    }
    all
}

/// Looks for every planted secret, and for private-key markers, in every artifact.
pub fn scan(artifacts: &[Artifact], secrets: &[Secret]) -> Vec<Finding> {
    let mut found = Vec::new();
    for secret in secrets {
        assert!(
            secret.bytes.len() >= MIN_SECRET_LEN,
            "secret '{}' is too short to scan for",
            secret.name
        );
        for (encoding, needle) in encodings(&secret.bytes) {
            for a in artifacts.iter().filter(|a| contains(&a.bytes, &needle)) {
                found.push(Finding {
                    secret: secret.name.clone(),
                    encoding,
                    source: a.source.clone(),
                });
            }
        }
    }
    for marker in KEY_MARKERS {
        for a in artifacts
            .iter()
            .filter(|a| contains(&a.bytes, marker.as_bytes()))
        {
            found.push(Finding {
                secret: marker.to_string(),
                encoding: "raw",
                source: a.source.clone(),
            });
        }
    }
    found.dedup_by(|a, b| a == b);
    found
}

/// Fails the test, naming every place a secret was found.
pub fn assert_nothing_leaked(artifacts: &[Artifact], secrets: &[Secret]) {
    let found = scan(artifacts, secrets);
    assert!(found.is_empty(), "the server can see secrets: {found:#?}");
}

pub fn artifact(source: &str, bytes: &[u8]) -> Artifact {
    Artifact {
        source: source.to_string(),
        bytes: bytes.to_vec(),
    }
}

pub fn secret(name: &str, bytes: &[u8]) -> Secret {
    Secret {
        name: name.to_string(),
        bytes: bytes.to_vec(),
    }
}
