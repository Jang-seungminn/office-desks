//! Running the Orca CLI. Port of `bridge/src/orcaCli.ts` (`resolveOrcaCommand`,
//! `createOrcaRunner`, `OrcaCliError`) and `probeOrca` from `bridge/src/backend/index.ts`.
//!
//! Every call is `orca <args> --json` as an argv (no shell). The child gets the runner's
//! [`EnvMap`] as its whole environment (Node inherits `process.env`, which the default map is)
//! and no stdin. A command that is not absolute is looked up on that env's PATH
//! ([`find_command`]) and is never spawned unresolved. Stdout and stderr are read with a cap;
//! on a timeout or an over-cap stream the runner kills and reaps its own child. On Windows the
//! child also runs in a Job Object, and that job is terminated too, so a `.cmd` shim's
//! grandchild dies with it (see `win_job`). It never looks for other processes.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use od_core::backend::BackendError;
use od_core::jsstr::{collapse_ws, slice_utf16, trim};
use od_core::jsval;
use od_core::native::env::{find_command, resolve_windows_command, EnvMap, ResolvedCommand};
use od_core::native::pty_host::unsafe_for_cmd_shim;
use od_core::nodepath::{node_is_absolute, win32_has_ext, win32_join};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};

/// The default timeout of every Orca call (TS `createOrcaRunner` default).
pub const ORCA_TIMEOUT: Duration = Duration::from_secs(15);
/// The timeout of the startup probe (TS `createOrcaRunner(undefined, 3000)`).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Per stream. Over it: kill the child, error `bad_output` `orca output too large`.
pub const MAX_OUTPUT: usize = 32 * 1024 * 1024;
/// The `.cmd` shim refusal (code `unsafe_for_cmd`), verbatim from TS.
pub const UNSAFE_FOR_CMD: &str = "Windows의 orca.cmd로는 줄바꿈이나 \" % & | < > ^ ! 문자를 안전하게 보낼 수 없습니다. ORCA_CLI_COMMAND에 orca.exe 경로를 지정해 주세요";

/// After a kill, how long we wait to reap the child before giving up on it.
const REAP_WAIT: Duration = Duration::from_secs(1);
/// `CREATE_NO_WINDOW`, the TS `windowsHide`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The Orca CLI executable, following Orca's own rules: `ORCA_CLI_COMMAND` wins (managed WSL
/// sessions), Linux uses `orca-ide` (bare `orca` there is usually the GNOME screen reader),
/// everything else uses `orca`.
pub fn resolve_orca_command(env: &EnvMap) -> String {
    resolve_orca_command_for(env, cfg!(target_os = "linux"))
}

/// [`resolve_orca_command`] with the platform as a parameter.
pub fn resolve_orca_command_for(env: &EnvMap, linux: bool) -> String {
    if let Some(v) = env.get("ORCA_CLI_COMMAND") {
        let v = trim(v);
        if !v.is_empty() {
            return v.to_string();
        }
    }
    if linux {
        "orca-ide".into()
    } else {
        "orca".into()
    }
}

/// Runs `orca <args> --json`. Object-safe, so `Arc<dyn OrcaRunner>` works.
#[async_trait]
pub trait OrcaRunner: Send + Sync {
    /// `orca <args> --json` with the runner's own timeout; the parsed `result` (JSON null
    /// when absent).
    async fn run(&self, args: &[String]) -> Result<Value, BackendError>;

    /// [`OrcaRunner::run`] with this call's own timeout instead of the runner's. For calls
    /// that wait on Orca longer than the default allows, like the hire's
    /// `orca terminal wait --timeout-ms 60000` (call it with about 65 s). Runners without a
    /// clock (fakes, the demo runner) ignore the timeout; this default does exactly that.
    async fn run_with_timeout(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        let _ = timeout;
        self.run(args).await
    }
}

/// The real Orca CLI runner.
#[derive(Debug, Clone)]
pub struct OrcaCli {
    command: String,
    timeout: Duration,
    /// Windows only: the file behind `command`, resolved once at construction like TS.
    win: Option<ResolvedCommand>,
    /// The child's whole environment, and the PATH a bare command is looked up on.
    env: Arc<EnvMap>,
    max_output: usize,
}

/// What to spawn for one call: the program and its full argv (`--json` included).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpawnPlan {
    pub program: String,
    pub args: Vec<String>,
}

/// The refusal and the command line, as a pure function so both hosts can test it. A `.cmd`
/// shim re-parses its arguments in cmd.exe, so anything cmd could interpret is refused before
/// a process exists.
pub(crate) fn spawn_plan(
    command: &str,
    win: Option<&ResolvedCommand>,
    args: &[String],
) -> Result<SpawnPlan, BackendError> {
    if win.is_some_and(|w| w.via_cmd) && args.iter().any(|a| unsafe_for_cmd_shim(a)) {
        return Err(unsafe_for_cmd());
    }
    let program = win.map_or(command, |w| w.file.as_str()).to_string();
    let mut argv = args.to_vec();
    argv.push("--json".into());
    Ok(SpawnPlan {
        program,
        args: argv,
    })
}

fn unsafe_for_cmd() -> BackendError {
    BackendError::with_code(UNSAFE_FOR_CMD, "unsafe_for_cmd")
}

/// JS `${args[0]} ${args[1] ?? ''}`: a missing first argument prints `undefined`.
fn timeout_error(args: &[String]) -> BackendError {
    let a0 = args.first().map_or("undefined", |s| s.as_str());
    let a1 = args.get(1).map_or("", |s| s.as_str());
    BackendError::with_code(format!("orca {a0} {a1} timed out"), "timeout")
}

fn too_large() -> BackendError {
    BackendError::with_code("orca output too large", "bad_output")
}

struct TooLarge;

/// Reads a pipe to its end, or stops with `TooLarge` once it passes `max` bytes. A read error
/// ends the stream like EOF (Node's stream does the same for our purposes).
async fn read_capped<R: AsyncRead + Unpin>(mut r: R, max: usize) -> Result<Vec<u8>, TooLarge> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match r.read(&mut chunk).await {
            Ok(0) | Err(_) => return Ok(buf),
            Ok(n) => {
                if buf.len() + n > max {
                    return Err(TooLarge);
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
}

async fn read_pipe<R: AsyncRead + Unpin>(p: Option<R>, max: usize) -> Result<Vec<u8>, TooLarge> {
    match p {
        Some(p) => read_capped(p, max).await,
        None => Ok(Vec::new()),
    }
}

/// The `PATH` (or `Path`) entries of a Windows env, as `resolve_windows_command` reads them.
fn win_path_dirs(env: &EnvMap) -> impl Iterator<Item = &str> {
    env.get("PATH")
        .or_else(|| env.get("Path"))
        .map_or("", String::as_str)
        .split(';')
        .filter(|d| !d.is_empty())
}

impl OrcaCli {
    pub fn new(command: impl Into<String>, timeout: Duration, env: &EnvMap) -> Self {
        let command = command.into();
        let win = if cfg!(windows) {
            Some(resolve_windows_command(&command, env, &|p| {
                Path::new(p).exists()
            }))
        } else {
            None
        };
        Self::with_resolution(command, timeout, win).with_env(env.clone())
    }

    /// `OrcaCli::new(resolve_orca_command(env), timeout, env)`.
    pub fn from_env(env: &EnvMap, timeout: Duration) -> Self {
        Self::new(resolve_orca_command(env), timeout, env)
    }

    /// A runner with an explicit Windows resolution (tests force one on any host).
    pub(crate) fn with_resolution(
        command: String,
        timeout: Duration,
        win: Option<ResolvedCommand>,
    ) -> Self {
        Self {
            command,
            timeout,
            win,
            env: Arc::new(EnvMap::new()),
            max_output: MAX_OUTPUT,
        }
    }

    fn with_env(mut self, env: EnvMap) -> Self {
        self.env = Arc::new(env);
        self
    }

    /// The program to spawn: absolute as given, else found on the env's PATH. None means
    /// `not_found` without a spawn: spawned bare, std would fall back to its own search path
    /// (`/bin:/usr/bin`, or the app and system folders on Windows).
    fn locate(&self, program: &str) -> Option<String> {
        if node_is_absolute(program) {
            return Some(program.to_string());
        }
        if cfg!(windows) && win32_has_ext(program) {
            // `orca.exe` or `orca.cmd` by name: `find_command` keeps a name with an extension
            // as is, so look it up on PATH here, as Node's spawn would.
            return win_path_dirs(&self.env)
                .map(|d| win32_join(d, program))
                .find(|f| Path::new(f).is_file());
        }
        find_command(program, &self.env).map(|p| p.to_string_lossy().into_owned())
    }

    /// The command as given (before any Windows resolution).
    pub fn command(&self) -> &str {
        &self.command
    }

    /// The runner's default timeout.
    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Test hook: a smaller per-stream output cap than [`MAX_OUTPUT`].
    #[doc(hidden)]
    pub fn with_max_output(mut self, max: usize) -> Self {
        self.max_output = max;
        self
    }

    async fn exec(&self, args: &[String], timeout: Duration) -> Result<Value, BackendError> {
        let plan = spawn_plan(&self.command, self.win.as_ref(), args)?;
        let program = self.locate(&plan.program).ok_or_else(|| self.not_found())?;
        let mut std_cmd = std::process::Command::new(&program);
        std_cmd
            .args(&plan.args)
            .env_clear()
            .envs(self.env.iter())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std_cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| self.spawn_error(e))?;
        // Right after the spawn (see `win_job` for the window before this line).
        let job = win_job::Job::assign(&child);
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let max = self.max_output;

        let work = async {
            let (out, err) = tokio::try_join!(read_pipe(stdout, max), read_pipe(stderr, max))?;
            Ok::<_, TooLarge>((out, err, child.wait().await))
        };
        let outcome = tokio::time::timeout(timeout, work).await;
        // The readers are dropped with `work`, never joined: a grandchild may hold the pipes.
        // Every way out but the two failures below drops `job`, which keeps its processes.
        let failure = match outcome {
            Ok(Ok((out, err, status))) => {
                let status =
                    status.map_err(|e| BackendError::with_code(e.to_string(), "spawn_error"))?;
                return parse_output(
                    &String::from_utf8_lossy(&out),
                    &String::from_utf8_lossy(&err),
                    status.code(),
                );
            }
            Ok(Err(TooLarge)) => too_large(),
            Err(_elapsed) => timeout_error(args),
        };
        if let Some(job) = job {
            // Kills the child and everything it started (a `.cmd` shim's `orca-real.exe`), so
            // the pipes close and the reader threads end.
            job.terminate();
        }
        let _ = child.start_kill();
        let _ = tokio::time::timeout(REAP_WAIT, child.wait()).await;
        Err(failure)
    }

    fn not_found(&self) -> BackendError {
        BackendError::with_code(
            format!("Orca CLI \"{}\" not found on PATH", self.command),
            "not_found",
        )
    }

    fn spawn_error(&self, e: std::io::Error) -> BackendError {
        match e.kind() {
            std::io::ErrorKind::NotFound => self.not_found(),
            // std refusing a batch-file argument it cannot escape safely (CVE-2024-24576). Only
            // for a `.cmd`/`.bat` shim: an `.exe` install's InvalidInput (a NUL in an argument)
            // is a plain spawn error. `win` is None off Windows.
            std::io::ErrorKind::InvalidInput if self.win.as_ref().is_some_and(|w| w.via_cmd) => {
                unsafe_for_cmd()
            }
            _ => BackendError::with_code(e.to_string(), "spawn_error"),
        }
    }
}

#[async_trait]
impl OrcaRunner for OrcaCli {
    async fn run(&self, args: &[String]) -> Result<Value, BackendError> {
        self.exec(args, self.timeout).await
    }

    async fn run_with_timeout(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> Result<Value, BackendError> {
        self.exec(args, timeout).await
    }
}

/// The Windows Job Object around one `orca` child.
///
/// A `.cmd` shim runs `cmd.exe`, which starts the real `orca` as a grandchild. Killing only our
/// child leaves the grandchild running with our pipes, so the reader threads stay parked. The
/// child is put in a job of its own right after the spawn; on a timeout or an over-cap stream
/// the job is terminated (`TerminateJobObject`), which ends our own child and every process it
/// started, and nothing else.
///
/// - **The race window.** Between `spawn` and `AssignProcessToJobObject` the child already
///   runs. A process it starts in that window (microseconds; cmd.exe has to parse the script
///   first) is not in the job and is only killed the old way, which is not at all.
/// - **No kill on a normal end.** The job has `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (so a crash of
///   ours closes it and ends the tree), but every other way out (success, an error exit, a
///   dropped call) first clears the limits and then closes the handle. A process the CLI leaves
///   behind on purpose (say, an Orca app it launched) keeps running. `BREAKAWAY_OK` also lets a
///   process that asks to leave the job do so.
/// - A dropped (cancelled) call keeps the old behaviour: tokio's `kill_on_drop` kills only the
///   direct child.
/// - If the job cannot be made or assigned (an old Windows that forbids nested jobs), the call
///   runs without one, as before.
#[cfg(windows)]
mod win_job {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub(super) struct Job(HANDLE);

    // SAFETY: a job handle is a kernel handle that may be used from any thread; `Job` is its
    // only owner and closes it exactly once, in `drop`.
    unsafe impl Send for Job {}

    fn set_limits(job: HANDLE, flags: u32) -> bool {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = flags;
        // SAFETY: `info` is a valid, fully initialised struct of the size we pass.
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        }
    }

    impl Job {
        /// A new job with `child` in it, or None (the call then runs without a job).
        pub(super) fn assign(child: &tokio::process::Child) -> Option<Job> {
            let process = child.raw_handle()?;
            // SAFETY: no security attributes, no name: an anonymous job that only we hold.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            // From here on, dropping `job` clears the limits and closes the handle.
            let job = Job(handle);
            if !set_limits(
                handle,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK,
            ) {
                return None;
            }
            // SAFETY: both handles are open: the job is ours, and `child` (not yet reaped)
            // owns its process handle for the duration of this call.
            if unsafe { AssignProcessToJobObject(handle, process as HANDLE) } == 0 {
                return None;
            }
            Some(job)
        }

        /// Ends every process in the job: our child and what it started.
        pub(super) fn terminate(self) {
            // SAFETY: the handle is open until `drop`, which runs right after.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // Disarm first: closing must never kill a process that is still running.
            set_limits(self.0, 0);
            // SAFETY: we own the handle and close it once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// No Job Object off Windows: the runner kills only its own child there.
#[cfg(not(windows))]
mod win_job {
    pub(super) struct Job;

    impl Job {
        pub(super) fn assign(_child: &tokio::process::Child) -> Option<Job> {
            None
        }

        pub(super) fn terminate(self) {}
    }
}

/// The TS `close` handler: stdout must be `{ ok, result?, error? }`.
pub fn parse_output(stdout: &str, stderr: &str, code: Option<i32>) -> Result<Value, BackendError> {
    let code_text = code.map_or("null".to_string(), |c| c.to_string());
    let exited = || format!("orca exited with {code_text}");
    let parsed: Value = match serde_json::from_str(trim(stdout)) {
        Ok(v) => v,
        Err(_) => {
            // JS `oneLine(stderr || stdout) || ...`: the raw stderr decides the branch.
            let line = one_line(if stderr.is_empty() { stdout } else { stderr });
            let msg = if line.is_empty() { exited() } else { line };
            return Err(BackendError::with_code(msg, "bad_output"));
        }
    };
    // A non-object reply is read as `{}` (TS would throw a TypeError in the handler).
    let empty = serde_json::Map::new();
    let obj = parsed.as_object().unwrap_or(&empty);
    if obj.get("ok") == Some(&Value::Bool(false)) || code != Some(0) {
        let error = obj.get("error").and_then(Value::as_object);
        let field = |k: &str| error.and_then(|e| e.get(k)).filter(|v| !v.is_null());
        let message = match field("message") {
            Some(m) => jsval::string(m),
            None => {
                let line = one_line(stderr);
                if line.is_empty() {
                    exited()
                } else {
                    line
                }
            }
        };
        let code = field("code").map_or("orca_error".to_string(), jsval::string);
        return Err(BackendError::with_code(message, code));
    }
    Ok(obj.get("result").cloned().unwrap_or(Value::Null))
}

/// TS `oneLine`: whitespace collapsed and trimmed, then the first 300 UTF-16 units.
pub fn one_line(s: &str) -> String {
    slice_utf16(&collapse_ws(s), 300).to_string()
}

/// Is an Orca app running whose CLI answers? True only when `result.runtime.reachable` is
/// exactly `true`; any error is false. Callers must build the runner with [`PROBE_TIMEOUT`]
/// (TS `createOrcaRunner(undefined, 3000)`): this function uses the runner's own timeout.
pub async fn probe_orca(runner: &dyn OrcaRunner) -> bool {
    match runner.run(&["status".to_string()]).await {
        Ok(v) => v.pointer("/runtime/reachable") == Some(&Value::Bool(true)),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::{argv, FakeRunner};
    use serde_json::json;

    fn env(pairs: &[(&str, &str)]) -> EnvMap {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn err(r: Result<Value, BackendError>) -> (String, String) {
        let e = r.expect_err("expected an error");
        (e.code.unwrap_or_default(), e.message)
    }

    #[test]
    fn resolve_orca_command_follows_orca() {
        let wsl = env(&[("ORCA_CLI_COMMAND", " orca-wsl ")]);
        assert_eq!(resolve_orca_command_for(&wsl, false), "orca-wsl");
        assert_eq!(resolve_orca_command_for(&wsl, true), "orca-wsl");
        assert_eq!(resolve_orca_command_for(&EnvMap::new(), false), "orca");
        assert_eq!(resolve_orca_command_for(&EnvMap::new(), true), "orca-ide");
        let blank = env(&[("ORCA_CLI_COMMAND", "  ")]);
        assert_eq!(resolve_orca_command_for(&blank, false), "orca");
        assert_eq!(
            resolve_orca_command(&EnvMap::new()),
            if cfg!(target_os = "linux") {
                "orca-ide"
            } else {
                "orca"
            }
        );
    }

    #[test]
    fn parse_output_vectors() {
        assert_eq!(
            parse_output("  {\"ok\":true,\"result\":{\"a\":1}}\n", "", Some(0)).unwrap(),
            json!({"a": 1})
        );
        assert_eq!(
            parse_output("{\"ok\":true}", "", Some(0)).unwrap(),
            Value::Null
        );
        assert_eq!(parse_output("5", "", Some(0)).unwrap(), Value::Null);
        assert_eq!(
            err(parse_output("{\"ok\":true,\"result\":1}", "warn", Some(1))),
            ("orca_error".into(), "warn".into())
        );
        assert_eq!(
            err(parse_output(
                "{\"ok\":false,\"error\":{\"message\":7,\"code\":\"x\"}}",
                "",
                Some(1)
            )),
            ("x".into(), "7".into())
        );
        assert_eq!(
            err(parse_output("", "", None)),
            ("bad_output".into(), "orca exited with null".into())
        );
        assert_eq!(
            err(parse_output("{", "", Some(0))),
            ("bad_output".into(), "{".into())
        );
        // Whitespace-only stderr wins the `||` but collapses to "": no fallback to stdout.
        assert_eq!(
            err(parse_output("x", "   ", Some(1))),
            ("bad_output".into(), "orca exited with 1".into())
        );
        // A null message or code falls back like `??`.
        assert_eq!(
            err(parse_output(
                "{\"ok\":false,\"error\":{\"message\":null,\"code\":null}}",
                " a \n b ",
                Some(0)
            )),
            ("orca_error".into(), "a b".into())
        );
        // A non-object error is ignored.
        assert_eq!(
            err(parse_output(
                "{\"ok\":false,\"error\":\"boom\"}",
                "",
                Some(4)
            )),
            ("orca_error".into(), "orca exited with 4".into())
        );
    }

    #[test]
    fn one_line_cuts_at_300_utf16_units() {
        assert_eq!(one_line(&"a".repeat(400)), "a".repeat(300));
        assert_eq!(one_line(&"😀".repeat(200)), "😀".repeat(150));
        assert_eq!(
            one_line(&format!("a{}", "😀".repeat(200))),
            format!("a{}", "😀".repeat(149))
        );
        assert_eq!(one_line("  some\n  error  "), "some error");
    }

    fn cmd(file: &str, via_cmd: bool) -> ResolvedCommand {
        ResolvedCommand {
            file: file.into(),
            via_cmd,
        }
    }

    #[test]
    fn spawn_plan_appends_json_and_uses_the_resolved_file() {
        let args = argv(&["terminal", "send", "--text=a&b"]);
        let plan = spawn_plan("orca", None, &args).unwrap();
        assert_eq!(plan.program, "orca");
        assert_eq!(
            plan.args,
            argv(&["terminal", "send", "--text=a&b", "--json"])
        );

        let exe = cmd("C:\\bin\\orca.exe", false);
        let plan = spawn_plan("orca", Some(&exe), &args).unwrap();
        assert_eq!(plan.program, "C:\\bin\\orca.exe");
        assert_eq!(plan.args.last().unwrap(), "--json");

        let shim = cmd("C:\\my bin\\orca.cmd", true);
        let safe = argv(&["search", "--query=한글 (ok), yes?", "--path=C:\\a b\\c\\"]);
        let plan = spawn_plan("orca", Some(&shim), &safe).unwrap();
        assert_eq!(plan.program, "C:\\my bin\\orca.cmd");
        assert_eq!(
            plan.args,
            argv(&[
                "search",
                "--query=한글 (ok), yes?",
                "--path=C:\\a b\\c\\",
                "--json"
            ])
        );
    }

    #[test]
    fn spawn_plan_refuses_cmd_metacharacters_for_a_shim_only() {
        let shim = cmd("orca.cmd", true);
        for bad in [
            "a&b", "a\"b", "50%", "a|b", "a<b", "a>b", "a^b", "a!", "a\nb", "a\rb", "a`b",
        ] {
            let args = argv(&["terminal", "send", &format!("--text={bad}")]);
            assert_eq!(
                err(spawn_plan("orca", Some(&shim), &args).map(|_| Value::Null)),
                ("unsafe_for_cmd".into(), UNSAFE_FOR_CMD.into()),
                "{bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_shim_refusal_never_spawns() {
        // The program does not exist: had we spawned, the error would be `not_found`.
        let runner = OrcaCli::with_resolution(
            "no-such-orca-od-test".into(),
            ORCA_TIMEOUT,
            Some(cmd("no-such-orca-od-test.cmd", true)),
        );
        let args = argv(&["terminal", "send", "--text=a&b"]);
        assert_eq!(
            err(runner.run(&args).await),
            ("unsafe_for_cmd".into(), UNSAFE_FOR_CMD.into())
        );
    }

    #[test]
    fn invalid_input_is_unsafe_for_cmd_only_for_a_shim() {
        let e = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "nul byte found");
        let shim =
            OrcaCli::with_resolution("orca".into(), ORCA_TIMEOUT, Some(cmd("orca.cmd", true)));
        assert_eq!(
            err(Err(shim.spawn_error(e()))),
            ("unsafe_for_cmd".into(), UNSAFE_FOR_CMD.into())
        );
        let exe =
            OrcaCli::with_resolution("orca".into(), ORCA_TIMEOUT, Some(cmd("orca.exe", false)));
        assert_eq!(
            err(Err(exe.spawn_error(e()))),
            ("spawn_error".into(), "nul byte found".into())
        );
        let unix = OrcaCli::with_resolution("orca".into(), ORCA_TIMEOUT, None);
        assert_eq!(err(Err(unix.spawn_error(e()))).0, "spawn_error");
        let missing = std::io::Error::new(std::io::ErrorKind::NotFound, "x");
        assert_eq!(
            err(Err(unix.spawn_error(missing))),
            (
                "not_found".into(),
                "Orca CLI \"orca\" not found on PATH".into()
            )
        );
    }

    #[test]
    fn timeout_message_follows_js() {
        assert_eq!(
            timeout_error(&argv(&["status"])).message,
            "orca status  timed out"
        );
        assert_eq!(timeout_error(&[]).message, "orca undefined  timed out");
        assert_eq!(
            timeout_error(&argv(&["terminal", "wait", "x"])).message,
            "orca terminal wait timed out"
        );
    }

    #[test]
    fn unsafe_for_cmd_text_is_verbatim() {
        assert_eq!(
            UNSAFE_FOR_CMD,
            "Windows의 orca.cmd로는 줄바꿈이나 \" % & | < > ^ ! 문자를 안전하게 보낼 수 없습니다. ORCA_CLI_COMMAND에 orca.exe 경로를 지정해 주세요"
        );
    }

    #[tokio::test]
    async fn probe_needs_reachable_exactly_true() {
        let yes = FakeRunner::new(|_| {
            Ok(json!({"app": {"running": true}, "runtime": {"reachable": true}}))
        });
        assert!(probe_orca(yes.as_ref()).await);
        assert_eq!(yes.calls(), vec![argv(&["status"])]);

        let no = FakeRunner::new(|_| Ok(json!({"runtime": {"reachable": false}})));
        assert!(!probe_orca(no.as_ref()).await);
        let truthy = FakeRunner::new(|_| Ok(json!({"runtime": {"reachable": 1}})));
        assert!(!probe_orca(truthy.as_ref()).await);
        let empty = FakeRunner::ok();
        assert!(!probe_orca(empty.as_ref()).await);
        let down = FakeRunner::new(|_| Err(BackendError::with_code("x", "not_found")));
        assert!(!probe_orca(down.as_ref()).await);
    }

    #[tokio::test]
    async fn the_default_run_with_timeout_calls_run() {
        struct Plain;
        #[async_trait]
        impl OrcaRunner for Plain {
            async fn run(&self, args: &[String]) -> Result<Value, BackendError> {
                Ok(json!(args))
            }
        }
        let args = argv(&["terminal", "wait"]);
        assert_eq!(
            Plain
                .run_with_timeout(&args, Duration::from_secs(65))
                .await
                .unwrap(),
            json!(["terminal", "wait"])
        );
    }

    #[tokio::test]
    async fn the_fake_records_the_timeout_override() {
        let fake = FakeRunner::ok();
        let args = argv(&["terminal", "wait"]);
        assert_eq!(fake.run(&args).await.unwrap(), json!({}));
        assert_eq!(
            fake.run_with_timeout(&args, Duration::from_secs(65))
                .await
                .unwrap(),
            json!({})
        );
        assert_eq!(fake.calls(), vec![args.clone(), args]);
        assert_eq!(fake.timeouts(), vec![None, Some(Duration::from_secs(65))]);
    }
}
