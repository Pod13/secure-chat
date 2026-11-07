//! Rehearsal of secret rotation (Constitution XII, `server/deploy/rotation.md`). The server reads
//! its TLS material from files when it starts, so rotation is a rolling restart: a new instance
//! starts with the new material, passes a health check, and then takes traffic. These tests play
//! that procedure with real handshakes and prove the failure modes close safely.

#![allow(clippy::unwrap_used)]

use rustls::{ClientConfig, RootCertStore, version};
use rustls_pki_types::{CertificateDer, ServerName, pem::PemObject};
use server::api::tls::{TlsError, TlsListener, server_config, server_config_from_files};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsConnector;

struct Identity {
    cert_pem: String,
    key_pem: String,
}

fn identity() -> Identity {
    let made = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    Identity {
        cert_pem: made.cert.pem(),
        key_pem: made.signing_key.serialize_pem(),
    }
}

async fn serve(config: Arc<rustls::ServerConfig>) -> SocketAddr {
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    let listener = TlsListener::new(tcp, config);
    tokio::spawn(async move { axum::serve(listener, server::router()).await });
    addr
}

fn trusting(id: &Identity) -> TlsConnector {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).unwrap())
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&version::TLS13])
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

/// True if a client that trusts only `id` gets a healthy answer from `addr`.
async fn healthy(addr: SocketAddr, id: &Identity) -> bool {
    let Ok(tcp) = TcpStream::connect(addr).await else {
        return false;
    };
    let name = ServerName::try_from("localhost").unwrap();
    let Ok(mut tls) = trusting(id).connect(name, tcp).await else {
        return false;
    };
    let request = "GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
    if tls.write_all(request.as_bytes()).await.is_err() {
        return false;
    }
    let mut out = String::new();
    let _ = tls.read_to_string(&mut out).await;
    out.starts_with("HTTP/1.1 200")
}

/// A new empty directory under the system temporary directory.
fn scratch_dir() -> PathBuf {
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).unwrap();
    let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("rotation-{name}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, id: &Identity) {
    std::fs::write(dir.join("cert.pem"), &id.cert_pem).unwrap();
    std::fs::write(dir.join("key.pem"), &id.key_pem).unwrap();
}

fn config_from(dir: &Path) -> Result<Arc<rustls::ServerConfig>, TlsError> {
    server_config_from_files(&dir.join("cert.pem"), &dir.join("key.pem"))
}

#[tokio::test]
async fn a_restart_picks_up_the_replaced_files_and_old_trust_stops_working() {
    let dir = scratch_dir();
    let (old, new) = (identity(), identity());

    write(&dir, &old);
    let before = serve(config_from(&dir).unwrap()).await;
    assert!(healthy(before, &old).await);

    // The secrets manager replaces the files; the next instance starts with them.
    write(&dir, &new);
    let after = serve(config_from(&dir).unwrap()).await;
    assert!(healthy(after, &new).await, "new certificate must be served");
    assert!(
        !healthy(after, &old).await,
        "the old certificate must not be accepted by the new instance"
    );
}

#[tokio::test]
async fn the_new_instance_is_not_taken_into_service_if_its_material_is_wrong() {
    let dir = scratch_dir();
    let (a, b) = (identity(), identity());
    // A certificate from one pair with a key from another: a typical rotation mistake.
    std::fs::write(dir.join("cert.pem"), &a.cert_pem).unwrap();
    std::fs::write(dir.join("key.pem"), &b.key_pem).unwrap();
    assert_eq!(config_from(&dir).err(), Some(TlsError::BadKey));
}

#[tokio::test]
async fn missing_empty_or_garbage_files_are_refused() {
    let dir = scratch_dir();
    assert_eq!(config_from(&dir).err(), Some(TlsError::Unreadable));
    std::fs::write(dir.join("cert.pem"), "").unwrap();
    std::fs::write(dir.join("key.pem"), "").unwrap();
    assert!(config_from(&dir).is_err());
    std::fs::write(dir.join("cert.pem"), "not a certificate").unwrap();
    std::fs::write(dir.join("key.pem"), "not a key").unwrap();
    assert!(config_from(&dir).is_err());
}

#[tokio::test]
async fn refusals_never_repeat_key_material() {
    let id = identity();
    let broken_key = id.key_pem.replace("PRIVATE KEY", "PRIVATE KEY ");
    let outcomes = [
        server_config(id.cert_pem.as_bytes(), broken_key.as_bytes()),
        server_config(b"garbage", id.key_pem.as_bytes()),
    ];
    let body: String = id.key_pem.lines().nth(1).unwrap().to_string();
    for outcome in outcomes {
        let text = format!("{:?}", outcome.err());
        assert!(!text.contains(&body), "{text}");
    }
}

#[tokio::test]
async fn both_instances_can_run_side_by_side_during_the_changeover() {
    let (old, new) = (identity(), identity());
    let first =
        serve(server_config(old.cert_pem.as_bytes(), old.key_pem.as_bytes()).unwrap()).await;
    let second =
        serve(server_config(new.cert_pem.as_bytes(), new.key_pem.as_bytes()).unwrap()).await;
    assert!(healthy(first, &old).await && healthy(second, &new).await);
    assert!(!healthy(first, &new).await && !healthy(second, &old).await);
}
