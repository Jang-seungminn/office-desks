//! Process trials for the Orca CLI runner against a fake `orca`.
//!
//! This test binary is its own fake: copied into a scratch dir as `orca` (or `orca-real`), it
//! reads `fake-orca.json` next to itself, logs the call to `calls.jsonl` and answers. The runner
//! always gets the absolute path of a copy, so the user's real `orca` is never run.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use libtest_mimic::{Arguments, Failed, Trial};
use od_core::backend::BackendError;
use od_core::native::env::EnvMap;
use od_orca::cli::{probe_orca, OrcaCli, OrcaRunner};
use serde_json::{json, Value};

type R = Result<(), Failed>;

// ---------------------------------------------------------------------------------------------
// The fake

fn main() {
    let exe = std::env::current_exe().expect("current_exe");
    let stem = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if stem == "orca" || stem == "orca-real" {
        fake_orca(&exe);
    }
    let root = tempfile::Builder::new()
        .prefix("od-orca-cli-")
        .tempdir()
        .expect("tempdir");
    ROOT.set(root.path().to_path_buf()).expect("root set once");
    let args = Arguments::from_args();
    let conclusion = libtest_mimic::run(&args, trials());
    drop(root);
    conclusion.exit();
}

fn fake_orca(exe: &Path) -> ! {
    let dir = exe.parent().expect("exe dir");
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let rules: Vec<Value> = std::fs::read_to_string(dir.join("fake-orca.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let line = json!({"pid": std::process::id(), "exe": exe.to_string_lossy(), "argv": argv});
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("calls.jsonl"))
    {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
    let matches = |r: &&Value| {
        let m: Vec<String> = r["match"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        argv.len() >= m.len() && argv[..m.len()] == m[..]
    };
    let (stdout, stderr, code) = match rules.iter().find(matches) {
        Some(r) => {
            let sleep = r["sleepMs"].as_u64().unwrap_or(0);
            if sleep > 0 {
                std::thread::sleep(Duration::from_millis(sleep));
            }
            (
                r["stdout"].as_str().unwrap_or("").to_string(),
                r["stderr"].as_str().unwrap_or("").to_string(),
                r["code"].as_i64().unwrap_or(0) as i32,
            )
        }
        None => (
            json!({"ok": true, "result": {"argv": argv}}).to_string(),
            String::new(),
            0,
        ),
    };
    let mut out = std::io::stdout();
    let _ = out.write_all(stdout.as_bytes());
    let _ = out.flush();
    let mut err = std::io::stderr();
    let _ = err.write_all(stderr.as_bytes());
    let _ = err.flush();
    std::process::exit(code);
}

// ---------------------------------------------------------------------------------------------
// Helpers

/// The process-level scratch root, a `TempDir` owned by `main`.
static ROOT: OnceLock<PathBuf> = OnceLock::new();

fn scratch_root() -> &'static Path {
    ROOT.get().expect("scratch root")
}

/// The trial's own scratch dir.
fn scratch(trial: &str) -> PathBuf {
    let d = scratch_root().join(trial);
    std::fs::create_dir_all(&d).expect("scratch dir");
    d
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Copies this test binary to `<dir>/<name>[.exe]` and returns its absolute path.
fn install(dir: &Path, name: &str) -> PathBuf {
    let to = dir.join(exe_name(name));
    std::fs::copy(std::env::current_exe().expect("current_exe"), &to).expect("copy fake orca");
    to
}

fn rules(dir: &Path, rules: Value) {
    std::fs::write(dir.join("fake-orca.json"), rules.to_string()).expect("write rules");
}

fn calls(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join("calls.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn argv(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}

fn runner(command: &Path, timeout: Duration) -> OrcaCli {
    OrcaCli::new(s(command), timeout, &EnvMap::new())
}

/// Runs `f` on its own runtime, and does not wait on stray blocking readers at the end.
fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let out = rt.block_on(f);
    rt.shutdown_timeout(Duration::from_secs(1));
    out
}

fn expect_err(r: Result<Value, BackendError>, code: &str, message: &str) -> R {
    match r {
        Ok(v) => Err(format!("expected {code} error, got Ok({v})").into()),
        Err(e) if e.code.as_deref() == Some(code) && e.message == message => Ok(()),
        Err(e) => Err(format!(
            "expected ({code:?}, {message:?}), got ({:?}, {:?})",
            e.code, e.message
        )
        .into()),
    }
}

fn check(cond: bool, what: impl Into<String>) -> R {
    if cond {
        Ok(())
    } else {
        Err(what.into().into())
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists; this is our own child's PID.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    !(r == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH))
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain Win32 calls on our own child's PID; the handle is closed before returning.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

// ---------------------------------------------------------------------------------------------
// Trials

fn trials() -> Vec<Trial> {
    #[allow(unused_mut)]
    let mut list = vec![
        Trial::test("echo_round_trip", echo_round_trip),
        Trial::test("coded_error", coded_error),
        Trial::test("bad_output", bad_output),
        Trial::test("empty_output", empty_output),
        Trial::test("ok_false_without_error", ok_false_without_error),
        Trial::test("timeout_kills_its_child", timeout_kills_its_child),
        Trial::test(
            "timeout_override_outlives_default",
            timeout_override_outlives_default,
        ),
        Trial::test("output_too_large", output_too_large),
        Trial::test("not_found", not_found),
        Trial::test("probe", probe),
    ];
    #[cfg(windows)]
    list.extend([
        Trial::test("cmd_shim_round_trip", win::cmd_shim_round_trip),
        Trial::test(
            "cmd_shim_refuses_before_spawn",
            win::cmd_shim_refuses_before_spawn,
        ),
        Trial::test("exe_preferred_over_cmd", win::exe_preferred_over_cmd),
        Trial::test("cmd_only_install", win::cmd_only_install),
    ]);
    list
}

fn echo_round_trip() -> R {
    let dir = scratch("echo_round_trip");
    let orca = install(&dir, "orca");
    let args = argv(&[
        "terminal",
        "send",
        "--terminal",
        "h 1",
        "--text=--help\n둘째 줄 (ok)?",
        "--enter",
    ]);
    let got = block_on(runner(&orca, Duration::from_secs(15)).run(&args))?;
    let mut want = args.clone();
    want.push("--json".into());
    check(got == json!({ "argv": want }), format!("got {got}"))
}

fn scripted(trial: &str, rule: Value) -> Result<Value, BackendError> {
    let dir = scratch(trial);
    let orca = install(&dir, "orca");
    rules(&dir, json!([rule]));
    block_on(runner(&orca, Duration::from_secs(15)).run(&argv(&["terminal", "send", "--text=x"])))
}

fn coded_error() -> R {
    let stdout = r#"{"ok":false,"error":{"code":"terminal_not_writable","message":"terminal_not_writable Terminal prompt request ID: 1fe4f207-0a7f-487d-8c7e-d7f040e56dd6."}}"#;
    expect_err(
        scripted(
            "coded_error",
            json!({"match": ["terminal", "send"], "stdout": stdout, "code": 1}),
        ),
        "terminal_not_writable",
        "terminal_not_writable Terminal prompt request ID: 1fe4f207-0a7f-487d-8c7e-d7f040e56dd6.",
    )
}

fn bad_output() -> R {
    expect_err(
        scripted(
            "bad_output",
            json!({"match": ["terminal"], "stdout": "not json", "stderr": "  some\n  error  ", "code": 2}),
        ),
        "bad_output",
        "some error",
    )
}

fn empty_output() -> R {
    expect_err(
        scripted("empty_output", json!({"match": [], "code": 3})),
        "bad_output",
        "orca exited with 3",
    )
}

fn ok_false_without_error() -> R {
    expect_err(
        scripted(
            "ok_false_without_error",
            json!({"match": ["terminal"], "stdout": "{\"ok\":false}", "code": 0}),
        ),
        "orca_error",
        "orca exited with 0",
    )
}

fn timeout_kills_its_child() -> R {
    let dir = scratch("timeout_kills_its_child");
    let orca = install(&dir, "orca");
    rules(&dir, json!([{"match": ["status"], "sleepMs": 30_000}]));
    let r = block_on(runner(&orca, Duration::from_secs(3)).run(&argv(&["status"])));
    expect_err(r, "timeout", "orca status  timed out")?;
    let pid = calls(&dir)
        .first()
        .and_then(|c| c["pid"].as_u64())
        .ok_or("the fake orca never logged its pid (it started too slowly?)")? as u32;
    let start = Instant::now();
    while pid_alive(pid) {
        if start.elapsed() > Duration::from_secs(2) {
            return Err(
                format!("our fake orca child {pid} is still alive after the timeout").into(),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

/// The hire's terminal wait outlives the runner's default timeout through `run_with_timeout`.
fn timeout_override_outlives_default() -> R {
    let dir = scratch("timeout_override_outlives_default");
    let orca = install(&dir, "orca");
    rules(
        &dir,
        json!([{"match": ["terminal", "wait"], "sleepMs": 1500, "stdout": "{\"ok\":true,\"result\":{\"waited\":true}}"}]),
    );
    let cli = runner(&orca, Duration::from_millis(500));
    let got =
        block_on(cli.run_with_timeout(&argv(&["terminal", "wait"]), Duration::from_secs(30)))?;
    check(got == json!({"waited": true}), format!("got {got}"))
}

fn output_too_large() -> R {
    let dir = scratch("output_too_large");
    let orca = install(&dir, "orca");
    rules(
        &dir,
        json!([{"match": ["status"], "stdout": "x".repeat(64 * 1024)}]),
    );
    let cli = runner(&orca, Duration::from_secs(15)).with_max_output(1024);
    expect_err(
        block_on(cli.run(&argv(&["status"]))),
        "bad_output",
        "orca output too large",
    )
}

fn not_found() -> R {
    let dir = scratch("not_found");
    let missing = s(&dir.join("no-such-orca"));
    let cli = OrcaCli::new(missing.clone(), Duration::from_secs(15), &EnvMap::new());
    expect_err(
        block_on(cli.run(&argv(&["status"]))),
        "not_found",
        &format!("Orca CLI \"{missing}\" not found on PATH"),
    )
}

fn probe() -> R {
    let dir = scratch("probe");
    let orca = install(&dir, "orca");
    let cli = runner(&orca, Duration::from_secs(15));
    let status = |reachable: bool| json!([{"match": ["status"], "stdout": json!({"ok": true, "result": {"app": {"running": true}, "runtime": {"reachable": reachable}}}).to_string()}]);
    rules(&dir, status(true));
    check(
        block_on(probe_orca(&cli)),
        "reachable:true should probe true",
    )?;
    rules(&dir, status(false));
    check(
        !block_on(probe_orca(&cli)),
        "reachable:false should probe false",
    )?;
    let missing = OrcaCli::new(
        s(&dir.join("no-such-orca")),
        Duration::from_secs(3),
        &EnvMap::new(),
    );
    check(
        !block_on(probe_orca(&missing)),
        "a missing orca should probe false",
    )?;
    let logged: Vec<Value> = calls(&dir).iter().map(|c| c["argv"].clone()).collect();
    check(
        logged == vec![json!(["status", "--json"]), json!(["status", "--json"])],
        format!("calls {logged:?}"),
    )
}

#[cfg(windows)]
mod win {
    use super::*;
    use od_core::native::env::resolve_windows_command;
    use od_orca::cli::UNSAFE_FOR_CMD;

    /// `<trial>\my bin` with `orca-real.exe` (the fake) and an `orca.cmd` shim forwarding to it.
    fn shim_dir(trial: &str) -> PathBuf {
        let dir = scratch(trial).join("my bin");
        std::fs::create_dir_all(&dir).expect("my bin");
        install(&dir, "orca-real");
        std::fs::write(dir.join("orca.cmd"), "@\"%~dp0orca-real.exe\" %*\r\n").expect("orca.cmd");
        dir
    }

    fn path_env(dir: &Path) -> EnvMap {
        EnvMap::from([("PATH".to_string(), s(dir))])
    }

    /// A bare `orca` must resolve inside our scratch folder, or the trial must not run it: an
    /// unresolved `orca` would be searched on the real PATH.
    fn guard_resolution(dir: &Path, env: &EnvMap) -> Result<String, Failed> {
        let r = resolve_windows_command("orca", env, &|p| Path::new(p).exists());
        let file = PathBuf::from(&r.file);
        if file.parent() != Some(dir) {
            return Err(format!("bare orca resolved outside the scratch dir: {}", r.file).into());
        }
        Ok(r.file)
    }

    pub fn cmd_shim_round_trip() -> R {
        let dir = shim_dir("cmd_shim_round_trip");
        let cli = OrcaCli::new(
            s(&dir.join("orca.cmd")),
            Duration::from_secs(15),
            &EnvMap::new(),
        );
        let args = argv(&[
            "search",
            "--query=한글 메시지 (ok), yes?",
            "--path=C:\\a b\\c\\",
            "--text=--help",
        ]);
        let got = block_on(cli.run(&args))?;
        let mut want = args.clone();
        want.push("--json".into());
        check(got == json!({ "argv": want }), format!("got {got}"))
    }

    pub fn cmd_shim_refuses_before_spawn() -> R {
        let dir = shim_dir("cmd_shim_refuses_before_spawn");
        let cli = OrcaCli::new(
            s(&dir.join("orca.cmd")),
            Duration::from_secs(15),
            &EnvMap::new(),
        );
        expect_err(
            block_on(cli.run(&argv(&["terminal", "send", "--text=a&b"]))),
            "unsafe_for_cmd",
            UNSAFE_FOR_CMD,
        )?;
        check(
            calls(&dir).is_empty(),
            "the shim ran although the call was refused",
        )
    }

    pub fn exe_preferred_over_cmd() -> R {
        let dir = shim_dir("exe_preferred_over_cmd");
        install(&dir, "orca");
        let env = path_env(&dir);
        let file = guard_resolution(&dir, &env)?;
        check(file.ends_with("orca.exe"), format!("resolved {file}"))?;
        block_on(OrcaCli::new("orca", Duration::from_secs(15), &env).run(&argv(&["status"])))?;
        let exe = calls(&dir)
            .first()
            .and_then(|c| c["exe"].as_str().map(String::from))
            .unwrap_or_default();
        check(exe.ends_with("orca.exe"), format!("ran {exe}"))
    }

    pub fn cmd_only_install() -> R {
        let dir = shim_dir("cmd_only_install");
        let env = path_env(&dir);
        let file = guard_resolution(&dir, &env)?;
        check(file.ends_with("orca.cmd"), format!("resolved {file}"))?;
        block_on(OrcaCli::new("orca", Duration::from_secs(15), &env).run(&argv(&["status"])))?;
        let exe = calls(&dir)
            .first()
            .and_then(|c| c["exe"].as_str().map(String::from))
            .unwrap_or_default();
        check(exe.ends_with("orca-real.exe"), format!("ran {exe}"))
    }
}
