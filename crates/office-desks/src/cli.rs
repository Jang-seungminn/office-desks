//! Command line of `office-desks` (port of the argument handling in `bin/office-desks.mjs`).

use od_core::native::env::EnvMap;

pub const DEFAULT_PORT: u16 = 4317;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    Orca,
    Native,
    Demo,
}

impl BackendKind {
    pub fn name(self) -> &'static str {
        match self {
            BackendKind::Orca => "orca",
            BackendKind::Native => "native",
            BackendKind::Demo => "demo",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub port: u16,
    pub backend: BackendKind,
    pub help: bool,
}

pub const PORT_ERROR: &str = "--port needs a number between 1 and 65535";
pub const BACKEND_ERROR: &str = "--backend needs one of: orca, native, demo";

pub const HELP: &str = "office-desks - a pixel-art office for your coding agents

Usage: office-desks [--port <n>] [--backend orca|native|demo] [--demo] [--no-tui]

  --port <n>        port to listen on (default 4317, or OFFICE_DESKS_PORT)
  --backend <kind>  orca: on top of a running Orca app
                    native: run agents in Office Desks itself (no Orca needed)
                    demo: fake office
                    default: native
  --demo            same as --backend demo
  --no-tui          server only (web), no terminal app
(Rust build: the terminal app arrives later; office-desks runs the server only.)

Then open http://127.0.0.1:<port>.";

/// JS `Number(s)` restricted to what `Number.isInteger` and the 1..=65535 range accept:
/// optional whitespace, decimal digits (also `1e3`, `0x10` forms are rejected: only digits).
fn parse_port(raw: &str) -> Option<u16> {
    let t = raw.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = t.parse().ok()?;
    u16::try_from(n).ok().filter(|p| *p >= 1)
}

/// `args` excludes the program name.
pub fn parse(args: &[String], env: &EnvMap) -> Result<Cli, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(Cli {
            port: DEFAULT_PORT,
            backend: BackendKind::Native,
            help: true,
        });
    }
    let value_of = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .map(|i| args.get(i + 1).map(String::as_str))
    };
    let port = match value_of("--port") {
        Some(v) => parse_port(v.unwrap_or("")).ok_or(PORT_ERROR)?,
        None => match env.get("OFFICE_DESKS_PORT").map(|v| v.trim()) {
            Some(v) if !v.is_empty() => parse_port(v).ok_or(PORT_ERROR)?,
            _ => DEFAULT_PORT,
        },
    };
    let kind = |s: &str| match s {
        "orca" => Some(BackendKind::Orca),
        "native" => Some(BackendKind::Native),
        "demo" => Some(BackendKind::Demo),
        _ => None,
    };
    let backend = if let Some(v) = value_of("--backend") {
        v.and_then(kind).ok_or(BACKEND_ERROR)?
    } else if args.iter().any(|a| a == "--demo") {
        BackendKind::Demo
    } else if let Some(v) = env
        .get("OFFICE_DESKS_BACKEND")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        kind(v).ok_or(BACKEND_ERROR)?
    } else if env.get("OFFICE_DESKS_DEMO").is_some_and(|v| !v.is_empty()) {
        BackendKind::Demo
    } else {
        BackendKind::Native
    };
    Ok(Cli {
        port,
        backend,
        help: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str], env: &[(&str, &str)]) -> Result<Cli, String> {
        let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let e: EnvMap = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        parse(&a, &e)
    }

    #[test]
    fn defaults() {
        let c = p(&[], &[]).unwrap();
        assert_eq!(
            (c.port, c.backend, c.help),
            (4317, BackendKind::Native, false)
        );
    }

    #[test]
    fn port_flag_and_env() {
        assert_eq!(p(&["--port", "8080"], &[]).unwrap().port, 8080);
        assert_eq!(p(&[], &[("OFFICE_DESKS_PORT", "9000")]).unwrap().port, 9000);
        assert_eq!(
            p(&["--port", "1"], &[("OFFICE_DESKS_PORT", "9000")])
                .unwrap()
                .port,
            1
        );
        assert_eq!(p(&[], &[("OFFICE_DESKS_PORT", "")]).unwrap().port, 4317);
        for bad in ["0", "0x1", "65536", "-1", "1.5", "abc", ""] {
            assert_eq!(
                p(&["--port", bad], &[]),
                Err(PORT_ERROR.to_string()),
                "{bad}"
            );
        }
        assert_eq!(p(&["--port"], &[]), Err(PORT_ERROR.to_string()));
    }

    #[test]
    fn backend_kinds() {
        assert_eq!(
            p(&["--backend", "orca"], &[]).unwrap().backend,
            BackendKind::Orca
        );
        assert_eq!(p(&["--demo"], &[]).unwrap().backend, BackendKind::Demo);
        assert_eq!(
            p(&[], &[("OFFICE_DESKS_BACKEND", "demo")]).unwrap().backend,
            BackendKind::Demo
        );
        assert_eq!(
            p(&[], &[("OFFICE_DESKS_DEMO", "1")]).unwrap().backend,
            BackendKind::Demo
        );
        assert_eq!(p(&["--backend", "x"], &[]), Err(BACKEND_ERROR.to_string()));
        assert_eq!(p(&["--no-tui"], &[]).unwrap().backend, BackendKind::Native);
    }

    #[test]
    fn help() {
        assert!(p(&["-h"], &[]).unwrap().help);
        assert!(p(&["--port", "zz", "--help"], &[]).unwrap().help);
    }
}
