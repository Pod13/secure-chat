use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let Ok(listener) = tokio::net::TcpListener::bind("127.0.0.1:8080").await else {
        eprintln!("cannot bind 127.0.0.1:8080");
        return ExitCode::FAILURE;
    };
    match axum::serve(listener, server::router()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
