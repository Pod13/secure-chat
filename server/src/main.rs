use server::accounts::invites::{self, Kind, NewInvite};
use server::api::state::AppState;
use server::api::tls::{Peer, TlsListener, server_config_from_files};
use server::config::{Config, ProcessEnv};
use server::ports::{DynClock, DynRandom, OsRandom, SystemClock};
use sqlx::postgres::PgPoolOptions;
use std::{process::ExitCode, sync::Arc};

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        None => serve().await,
        Some("seed-invite") => seed_invite(&args[1..]).await,
        Some(_) => Err("usage: server [seed-invite <days> <uses>]".to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(reason) => {
            eprintln!("{reason}");
            ExitCode::FAILURE
        }
    }
}

async fn state(config: &Config) -> Result<AppState, String> {
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&config.database_url)
        .await
        .map_err(|_| "cannot connect to the database")?;
    let clock: DynClock = Arc::new(SystemClock);
    let random: DynRandom = Arc::new(OsRandom);
    Ok(AppState::new(pool, clock, random, config.session_ttl_secs))
}

/// Reads settings from the environment and serves over TLS 1.3. Messages never include values.
async fn serve() -> Result<(), String> {
    let config = Config::load(&ProcessEnv).map_err(|e| e.to_string())?;
    let tls = server_config_from_files(
        std::path::Path::new(&config.tls_cert_path),
        std::path::Path::new(&config.tls_key_path),
    )
    .map_err(|e| format!("invalid TLS material: {e:?}"))?;
    let app = server::full_router(state(&config).await?);
    let tcp = tokio::net::TcpListener::bind(config.bind_addr)
        .await
        .map_err(|_| "cannot bind BIND_ADDR")?;
    axum::serve(
        TlsListener::new(tcp, tls),
        app.into_make_service_with_connect_info::<Peer>(),
    )
    .await
    .map_err(|_| "server stopped".to_string())
}

/// Operator command: makes an Invite for sign-up and prints its token once.
async fn seed_invite(args: &[String]) -> Result<(), String> {
    let [days, uses] = args else {
        return Err("usage: server seed-invite <days> <uses>".to_string());
    };
    let days: u64 = days.parse().map_err(|_| "days must be a number")?;
    let max_uses: u32 = uses.parse().map_err(|_| "uses must be a number")?;
    let config = Config::load(&ProcessEnv).map_err(|e| e.to_string())?;
    let state = state(&config).await?;
    let new = NewInvite {
        owner: None,
        kind: Kind::Service,
        expires_at: server::ports::Clock::now_secs(&state.clock) + days * 86_400,
        max_uses,
    };
    let made = invites::create(&state.pool, &state.clock, &state.random, new)
        .await
        .map_err(|_| "could not create the Invite (days up to 90, uses 1 to 1000)")?;
    println!("{}", server::api::state::encode(&made.token));
    Ok(())
}
