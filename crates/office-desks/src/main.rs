//! `office-desks`: the Office Desks server (native backend) in one binary. Port of
//! `bin/office-desks.mjs` plus the server start in `server.ts`.

mod cli;

use std::process::exit;
use std::sync::Arc;

use cli::BackendKind;
use od_core::native::env::process_env;
use od_server::{bind, native_backend, serve, ServerConfig};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The default agent hook command is `<this exe> hook-relay`: nothing else may start first.
    if args.first().map(String::as_str) == Some("hook-relay") {
        exit(od_core::native::hook_relay::run());
    }
    let env = process_env();
    let cli = match cli::parse(&args, &env) {
        Ok(c) => c,
        Err(message) => {
            eprintln!("{message}");
            exit(1);
        }
    };
    if cli.help {
        println!("{}", cli::HELP);
        return;
    }
    if cli.backend != BackendKind::Native {
        eprintln!(
            "office-desks: the {} backend is not in the Rust build yet; use the Node bridge (npx office-desks) for it",
            cli.backend.name()
        );
        exit(1);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[office-desks] {e}");
            exit(1);
        }
    };
    exit(runtime.block_on(run(cli, env)));
}

async fn run(cli: cli::Cli, env: od_core::native::env::EnvMap) -> i32 {
    let bound = match bind(cli.port).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[office-desks] {e}");
            return 1;
        }
    };
    let port = bound.port;
    let backend = Arc::new(native_backend(&env, port).await);
    let handle = serve(bound, backend, ServerConfig::from_env(&env)).await;
    println!("[office-desks] bridge on http://127.0.0.1:{port} (native backend)");
    wait_for_signal().await;
    // Later signals are ignored: the handlers stay installed but nobody listens.
    handle.shutdown().await;
    0
}

#[cfg(unix)]
async fn wait_for_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = int.recv() => {}
        _ = term.recv() => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
