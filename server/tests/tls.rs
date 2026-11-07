#![allow(clippy::unwrap_used)]

use rustls::{ClientConfig, RootCertStore, SupportedProtocolVersion, version};
use rustls_pki_types::{CertificateDer, ServerName, pem::PemObject};
use server::api::headers::{API_CSP, APP_CSP, HEADERS};
use server::api::tls::{TlsError, TlsListener, server_config};
use std::{net::SocketAddr, sync::Arc};
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

async fn start(id: &Identity) -> SocketAddr {
    let config = server_config(id.cert_pem.as_bytes(), id.key_pem.as_bytes()).unwrap();
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    let listener = TlsListener::new(tcp, config);
    tokio::spawn(async move { axum::serve(listener, server::router()).await });
    addr
}

fn client(id: &Identity, versions: &[&'static SupportedProtocolVersion]) -> TlsConnector {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(id.cert_pem.as_bytes()).unwrap())
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

async fn get(addr: SocketAddr, connector: &TlsConnector, path: &str) -> std::io::Result<String> {
    let tcp = TcpStream::connect(addr).await?;
    let name = ServerName::try_from("localhost").unwrap();
    let mut tls = connector.connect(name, tcp).await?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    tls.write_all(request.as_bytes()).await?;
    let mut out = String::new();
    let _ = tls.read_to_string(&mut out).await;
    Ok(out)
}

#[tokio::test]
async fn a_tls_1_3_client_is_served() {
    let id = identity();
    let addr = start(&id).await;
    let response = get(addr, &client(&id, &[&version::TLS13]), "/healthz")
        .await
        .unwrap();
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.ends_with("ok"), "{response}");
}

#[tokio::test]
async fn a_tls_1_2_only_client_cannot_connect() {
    let id = identity();
    let addr = start(&id).await;
    let result = get(addr, &client(&id, &[&version::TLS12]), "/healthz").await;
    let error = result
        .expect_err("a TLS 1.2 handshake must fail")
        .to_string();
    assert!(
        error.contains("protocol version") || error.contains("ProtocolVersion"),
        "{error}"
    );
}

#[tokio::test]
async fn plain_http_gets_no_answer() {
    let id = identity();
    let addr = start(&id).await;
    let mut tcp = TcpStream::connect(addr).await.unwrap();
    tcp.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut buf = Vec::new();
    let _ =
        tokio::time::timeout(std::time::Duration::from_secs(2), tcp.read_to_end(&mut buf)).await;
    assert!(
        !String::from_utf8_lossy(&buf).contains("200 OK"),
        "plaintext was served"
    );
}

#[tokio::test]
async fn every_response_carries_the_security_headers_even_errors() {
    let id = identity();
    let addr = start(&id).await;
    let connector = client(&id, &[&version::TLS13]);
    for path in ["/healthz", "/no-such-page"] {
        let response = get(addr, &connector, path).await.unwrap().to_lowercase();
        for (name, value) in HEADERS {
            let line = format!("{name}: {}", value.to_lowercase());
            assert!(response.contains(&line), "{path} is missing {name}");
        }
    }
}

#[test]
fn the_policies_allow_no_inline_eval_or_foreign_sources() {
    for policy in [API_CSP, APP_CSP] {
        // WebAssembly may be compiled (needed for the MLS module), which is not general eval.
        let policy = &policy.replace("'wasm-unsafe-eval'", "");
        for banned in [
            "unsafe-inline",
            "unsafe-eval",
            "http:",
            "https:",
            " * ",
            "data:",
        ] {
            assert!(!policy.contains(banned), "{banned} found in {policy}");
        }
        assert!(
            policy.starts_with("default-src 'none'") && policy.contains("frame-ancestors 'none'")
        );
    }
    assert!(APP_CSP.contains("require-trusted-types-for 'script'"));
    assert!(APP_CSP.contains("script-src 'self' 'wasm-unsafe-eval';"));
    assert!(APP_CSP.contains("trusted-types sw-url"));
    assert!(!APP_CSP.contains("'unsafe-eval'"));
}

#[test]
fn hsts_is_long_lived_covers_subdomains_and_is_preloadable() {
    let hsts = HEADERS
        .iter()
        .find(|(n, _)| *n == "strict-transport-security")
        .unwrap()
        .1;
    assert!(
        hsts.contains("max-age=63072000")
            && hsts.contains("includeSubDomains")
            && hsts.contains("preload")
    );
}

#[test]
fn bad_certificates_and_keys_are_rejected() {
    let (good, other) = (identity(), identity());
    let (cert, key) = (good.cert_pem.as_bytes(), good.key_pem.as_bytes());
    assert_eq!(
        server_config(b"garbage", key).err(),
        Some(TlsError::BadCertificate)
    );
    assert_eq!(
        server_config(b"", key).err(),
        Some(TlsError::BadCertificate)
    );
    assert_eq!(
        server_config(cert, b"garbage").err(),
        Some(TlsError::BadKey)
    );
    assert_eq!(
        server_config(cert, other.key_pem.as_bytes()).err(),
        Some(TlsError::BadKey)
    );
    assert!(server_config(cert, key).is_ok());
}
