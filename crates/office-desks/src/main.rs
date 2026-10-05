//! `office-desks`: the Office Desks server (native backend) in one binary. Port of
//! `bin/office-desks.mjs` plus the server start in `server.ts`.

mod cli;

use std::process::exit;

use od_core::native::env::process_env;
use od_server::{bind, serve, ServerConfig};

fn main() {
    // The default agent hook command is `<this exe> hook-relay`: nothing else may start first.
    // `args_os` so a non-UTF-8 argument can't panic.
    if std::env::args_os()
        .nth(1)
        .is_some_and(|a| a == "hook-relay")
    {
        exit(od_core::native::hook_relay::run());
    }
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
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
            eprintln!(
                "[office-desks] cannot listen on 127.0.0.1:{}: {e}",
                cli.port
            );
            return 1;
        }
    };
    let port = bound.port;
    // Installed before the backend exists, so an early signal is not lost to the default action.
    let signals = Signals::install();
    // Node probes before it binds; here a busy port fails first, before anything is spawned.
    let mut cfg = ServerConfig::from_env(&env);
    let probe_env = env.clone();
    let probe = async move {
        od_orca::probe_orca(&od_orca::OrcaCli::from_env(
            &probe_env,
            od_orca::PROBE_TIMEOUT,
        ))
        .await
    };
    let created = match od_server::create_backend(cli.backend, &env, port, &mut cfg, probe).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[office-desks] {e}");
            return 1;
        }
    };
    let handle = serve(bound, created.backend, cfg).await;
    println!(
        "[office-desks] bridge on http://127.0.0.1:{port} ({})",
        created.label
    );
    signals.wait().await;
    // Later signals are ignored: the handlers stay installed but nobody listens.
    handle.shutdown().await;
    0
}

/// Handlers stay installed for the process lifetime, so later signals are ignored.
#[cfg(unix)]
struct Signals {
    int: tokio::signal::unix::Signal,
    term: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    fn install() -> Self {
        use tokio::signal::unix::{signal, SignalKind};
        Signals {
            int: signal(SignalKind::interrupt()).expect("SIGINT handler"),
            term: signal(SignalKind::terminate()).expect("SIGTERM handler"),
        }
    }
    async fn wait(mut self) {
        tokio::select! {
            _ = self.int.recv() => {}
            _ = self.term.recv() => {}
        }
    }
}

#[cfg(windows)]
struct Signals {
    c: tokio::signal::windows::CtrlC,
    brk: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl Signals {
    fn install() -> Self {
        use tokio::signal::windows as w;
        Signals {
            c: w::ctrl_c().expect("ctrl_c handler"),
            brk: w::ctrl_break().expect("ctrl_break handler"),
            close: w::ctrl_close().expect("ctrl_close handler"),
            shutdown: w::ctrl_shutdown().expect("ctrl_shutdown handler"),
        }
    }
    async fn wait(mut self) {
        tokio::select! {
            _ = self.c.recv() => {}
            _ = self.brk.recv() => {}
            _ = self.close.recv() => {}
            _ = self.shutdown.recv() => {}
        }
    }
}
