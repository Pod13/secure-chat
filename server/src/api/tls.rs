//! TLS 1.3 only (Constitution: Transport). The server speaks TLS itself and has no plaintext
//! mode. The configuration offers exactly one protocol version, so an older client cannot even
//! negotiate; tests prove it with real handshakes.

use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use rustls::{ServerConfig, version::TLS13};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use std::{io, net::SocketAddr, path::Path, sync::Arc};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

#[derive(Debug, PartialEq, Eq)]
pub enum TlsError {
    BadCertificate,
    BadKey,
    Config,
    /// A certificate or key file could not be read.
    Unreadable,
}

/// Builds a server configuration that accepts TLS 1.3 and nothing else.
pub fn server_config(cert_chain_pem: &[u8], key_pem: &[u8]) -> Result<Arc<ServerConfig>, TlsError> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_chain_pem)
        .collect::<Result<_, _>>()
        .map_err(|_| TlsError::BadCertificate)?;
    if certs.is_empty() {
        return Err(TlsError::BadCertificate);
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem).map_err(|_| TlsError::BadKey)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13])
        .map_err(|_| TlsError::Config)?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|_| TlsError::BadKey)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Reads the certificate chain and key from files, so a restart picks up replaced secrets.
pub fn server_config_from_files(cert: &Path, key: &Path) -> Result<Arc<ServerConfig>, TlsError> {
    let cert = std::fs::read(cert).map_err(|_| TlsError::Unreadable)?;
    let key = std::fs::read(key).map_err(|_| TlsError::Unreadable)?;
    server_config(&cert, &key)
}

/// A listener that completes a TLS handshake before handing the connection to the server.
/// Failed handshakes (including attempts with older TLS versions) are dropped quietly.
pub struct TlsListener {
    tcp: TcpListener,
    acceptor: TlsAcceptor,
}

impl TlsListener {
    pub fn new(tcp: TcpListener, config: Arc<ServerConfig>) -> Self {
        Self {
            tcp,
            acceptor: TlsAcceptor::from(config),
        }
    }
}

impl Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let Ok((stream, addr)) = self.tcp.accept().await else {
                continue;
            };
            if let Ok(tls) = self.acceptor.accept(stream).await {
                return (tls, addr);
            }
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.tcp.local_addr()
    }
}

/// The address of the other end of a connection, used only to pick a truncated rate-limit bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer(pub SocketAddr);

impl Connected<IncomingStream<'_, TlsListener>> for Peer {
    fn connect_info(stream: IncomingStream<'_, TlsListener>) -> Self {
        Self(*stream.remote_addr())
    }
}

impl Connected<IncomingStream<'_, TcpListener>> for Peer {
    fn connect_info(stream: IncomingStream<'_, TcpListener>) -> Self {
        Self(*stream.remote_addr())
    }
}
