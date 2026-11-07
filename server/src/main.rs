use server::api::tls::{TlsListener, server_config};
use server::config::{Config, ProcessEnv};
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(reason) => {
            eprintln!("{reason}");
            ExitCode::FAILURE
        }
    }
}

/// Reads settings from the environment and serves over TLS 1.3. Messages never include values.
async fn run() -> Result<(), String> {
    let config = Config::load(&ProcessEnv).map_err(|e| e.to_string())?;
    let cert = std::fs::read(&config.tls_cert_path).map_err(|_| "cannot read TLS_CERT_FILE")?;
    let key = std::fs::read(&config.tls_key_path).map_err(|_| "cannot read TLS_KEY_FILE")?;
    let tls = server_config(&cert, &key).map_err(|e| format!("invalid TLS material: {e:?}"))?;
    let tcp = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .map_err(|_| "cannot bind BIND_ADDR")?;
    axum::serve(TlsListener::new(tcp, tls), server::router())
        .await
        .map_err(|_| "server stopped".to_string())
}
