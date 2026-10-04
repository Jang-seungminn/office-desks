# M2: NativeBackend — Office Desks without Orca — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm start` without Orca running opens a working office. From the web you can:
- register a local git repo as a project;
- create a worktree with a Claude agent, or add an agent to an existing worktree;
- watch the agent's live state, read its conversation and send it prompts, keys and question answers.

The agents run in PTYs that the bridge owns itself.

**Architecture:** A new `NativeBackend` implements the M1 `OfficeBackend` seam. It is built from small single-purpose modules under `bridge/src/native/`:
- `env.ts`: environment scrubbing.
- `ptyHost.ts`: `node-pty` processes, each feeding a headless xterm screen.
- `registry.ts`: a JSON file with projects and board metadata.
- `worktrees.ts`: `git worktree` via the existing `runGit`.
- `hooks.ts`: Claude Code `--settings` hooks and a reducer from hook events to agent state.

Agent state comes from the hooks, with a screen-based fallback. A pure-JS relay script (`bridge/hook-relay.mjs`) POSTs each hook to the bridge.

`createBackend` becomes async:
- it picks Orca when `orca status` answers;
- it falls back to native otherwise;
- `--backend` / `OFFICE_DESKS_BACKEND` overrides the choice.

The web learns the backend's capabilities over the WebSocket. It hides what the backend can't do and offers project registration.

**Tech Stack:**
- Node 22+, TypeScript ESM (`.js` import suffixes), vitest.
- `node-pty@1.1.0`, which ships darwin-x64/arm64 and win32-x64/arm64 prebuilds.
- `@xterm/headless@^6`.
- Claude Code 2.1.x hooks (`--settings <file>`, `--session-id <uuid>`).

**Spec:** `docs/superpowers/specs/2026-10-04-native-backend-tui-design.md` (sections "M2" and "Orca 기능 → 자체 구현 매핑"). The spec section numbers M1–M4 are the roadmap. This plan covers M2 only. The TUI is M3.

## Verified Facts (spikes run 2026-10-04 on macOS, Claude Code 2.1.289)

- `node-pty@1.1.0` installs under npm 11 with install scripts blocked, and loads from `prebuilds/`. However, `prebuilds/darwin-*/spawn-helper` lands **without the execute bit**, and every spawn then fails with `posix_spawnp failed`. Running `chmod +x` on it fixes this.
- Spawning `claude --session-id <uuid> --settings <file>` in a PTY, piping its output into `@xterm/headless`, and piping `term.onData` back into the PTY renders the normal Claude screen. `composerState()` sees the `❯` composer.
- Hook command `node "<relay>"`, configured through `--settings`, receives JSON on stdin. Observed payloads:
  - `SessionStart`: `{session_id, transcript_path, cwd, hook_event_name, source, model}`
  - `UserPromptSubmit`: `{…, prompt}`
  - `Stop`: `{…, effort, last_assistant_message}`
- Submitting a prompt works as `'\x1b[200~' + text + '\x1b[201~'`, then about 400 ms later `'\r'`. A multi-line prompt arrives as one message.
- **Environment.** If the bridge was started from inside a Claude Code session, the inherited `CLAUDE_CODE_CHILD_SESSION` and related markers make the child print "Transcript saving is off", and no transcript gets written. Started inside Orca, `ORCA_*` variables leak Orca's agent hooks into our child.
- **Trust.** Claude trusts each directory separately (`~/.claude.json` → `projects[path].hasTrustDialogAccepted`). A fresh `git worktree add` path shows "Quick safety check … ❯ No, exit / Yes, I trust this folder", and **no hook fires until it is answered**. The default choice is "No, exit".

## Global Constraints

- **Cross-platform (required).** macOS and Windows; npm scripts only; never shell-joined arguments; CI runs typecheck, test and build on `macos-latest` and `windows-latest`.
- **No regression for Orca users.** The Orca and demo backends behave exactly as before. The only exception is wording: user-visible "Orca" text that no longer holds for every backend becomes neutral or backend-supplied.
- **Bind address.** The bridge binds only to `127.0.0.1`. The hook endpoint requires a per-agent random token, compared in constant time.
- **Only `claude` gets hooks.** Other `KNOWN_AGENTS` are spawned as plain commands. They count as stateless: shown as `done` while their composer looks ready, `waiting` while a menu shows.
- **Agent lifetime.** Agents live only as long as the bridge process. On SIGINT/SIGTERM every PTY is killed. Session resume is M4.
- **State location.** Native state lives in `officeHome()`, which is `OFFICE_DESKS_HOME` or else `~/.office-desks`:
  - `state.json` holds registered repos and board metadata.
  - `agents/<id>.json` holds per-agent Claude settings and is deleted on exit.
  - `worktrees/<repo>/<name>/` holds the worktrees.
  - `awards.json` and `org.json` follow the same home.
- **Dependencies.** Pin `node-pty` exactly to `1.1.0` and use `@xterm/headless` `^6.0.0`. Add both to the **root** `package.json` (npx installs the root package) and to `bridge/package.json`.
- **Style.** Imports use the `.js` suffix; 2-space indent, single quotes; short "why" comments only; Korean UI text in the same voice as the existing UI.
- **Process discipline for anything that starts servers or agents.** Use a port other than 4317, record the PID you started, and stop only that PID. Never `pkill`, `killall` or pattern kills. The user runs real agents on this machine.

## Review Focus

1. **Hiring into a fresh worktree with a first prompt.** The trust dialog appears and no hook fires. The agent must show as `waiting` (screen override). Once the user answers "Yes" through the web's terminal keys, `SessionStart` arrives and the queued first prompt is typed exactly once. Pinned in Task 6: "delivers the pending first prompt once, on SessionStart".
2. **Bridge started from inside Claude Code or Orca.** The child must not inherit session markers or `ORCA_*`. User auth and config variables (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) must survive. Pinned in Task 3 `agentEnv` tests.
3. **`spawn-helper` without the execute bit (npx install).** The first spawn must still work after we chmod it. If chmod is impossible, the error message tells the user the exact command. Pinned in Task 3 `ensureSpawnHelper` test.
4. **The hook endpoint receiving forged or replayed requests.** A wrong token or unknown agent returns 404 and changes nothing. Pinned in Task 6 "rejects a wrong token" and in Task 7's server check.
5. **First run with no projects.** The office must tell the user how to start ("➕ 새 작업 → 프로젝트 추가"). Registering a path that isn't a git repo shows a clear Korean error. Pinned in Task 4 (`resolveRepo` rejects a non-repo), Task 2 (UI) and Task 8 (end to end from an empty `OFFICE_DESKS_HOME`).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `bridge/src/model.ts` | modify | `BackendCapabilities` and `BackendInfo` move here, since the web imports model; `ServerMessage` gains `backend` |
| `bridge/src/backend/types.ts` | modify | re-export the capabilities; add `messages`, `addRepo`, `hook`, `dispose` |
| `bridge/src/backend/orca.ts` | modify | new capabilities and messages; `terminal_not_writable` becomes a friendly `BackendError` |
| `bridge/src/backend/demo.ts` | modify | new capabilities and messages |
| `bridge/src/home.ts` | create | `officeHome(env)` |
| `bridge/src/awards.ts`, `bridge/src/org.ts` | modify | default file under `officeHome()` |
| `bridge/src/native/env.ts` | create | `agentEnv(base, extra)` scrubbing |
| `bridge/src/native/ptyHost.ts` | create | `PtyHost`, `ensureSpawnHelper`, `resolveSpawn` |
| `bridge/src/native/registry.ts` | create | `Registry` (`state.json`) |
| `bridge/src/native/worktrees.ts` | create | `parsePorcelain`, `listWorktrees`, `resolveRepo`, `addWorktree`, `worktreeDest` |
| `bridge/src/native/hooks.ts` | create | `hookSettings`, `relayScript`, `HookState`, `applyHook` |
| `bridge/hook-relay.mjs` | create | plain JS stdin → POST relay (shipped as-is, not compiled) |
| `bridge/src/backend/native.ts` | create | `NativeBackend` |
| `bridge/src/backend/index.ts` | modify | async `createBackend`, `probeOrca`, `createNativeBackend` |
| `bridge/src/server.ts` | modify | `backend` WS message; `/hook/:id`; `/api/repos`; dispose on signals; 409 for `terminal_not_writable` |
| `bin/office-desks.mjs` | modify | `--backend`, help text |
| `package.json`, `bridge/package.json` | modify | dependencies; `files` adds `bridge/hook-relay.mjs` |
| `README.md` | modify | "Orca 없이 쓰기" section; dev-mode note |
| `web/src/backend.ts` | create | the current `BackendInfo` with a change subscription |
| `web/src/api.ts`, `web/src/main.ts`, `web/src/panel.ts`, `web/src/hireDialog.ts`, `web/src/officeScene.ts` | modify | consume capabilities, project registration, neutral wording |
| tests | create/modify | `bridge/test/{orcaBackend,demoBackend,env,ptyHost,registry,worktrees,hooks,hookRelay,nativeBackend,createBackend}.test.ts` |

---

### Task 1: Backend interface v2 (capabilities, messages, lifecycle) and a friendly "not writable"

**Files:**
- Modify: `bridge/src/model.ts`, `bridge/src/backend/types.ts`, `bridge/src/backend/orca.ts`, `bridge/src/backend/demo.ts`, `bridge/src/server.ts`
- Test: `bridge/test/orcaBackend.test.ts`, `bridge/test/demoBackend.test.ts`

**Interfaces:**
- Produces, in `bridge/src/model.ts`:

```ts
export interface BackendCapabilities {
  usage: boolean; search: boolean; board: boolean; hire: boolean; changes: boolean; transcripts: boolean;
  focus: boolean; repos: boolean;
}
export interface BackendInfo { name: string; capabilities: BackendCapabilities }
```

  `ServerMessage` gains `| { type: 'backend'; backend: BackendInfo }`.
- Produces, in `bridge/src/backend/types.ts`:
  - `export type { BackendCapabilities } from '../model.js'`
  - `export interface BackendMessages { noSession: string; hireDisabled: string }`
  - `OfficeBackend` gains:
    - `readonly messages: BackendMessages`
    - `addRepo(repoPath: string): Promise<void>`
    - `hook(agentId: string, token: string, payload: unknown): boolean`
    - `dispose(): Promise<void>`

- [ ] **Step 1: Write the failing tests.** Append to `bridge/test/orcaBackend.test.ts`:

```ts
describe('OrcaBackend v2', () => {
  it('turns terminal_not_writable into a friendly error with a stable code', async () => {
    const { orca } = fake(() => new OrcaCliError('terminal_not_writable Terminal prompt request ID: 1fe4f207-0a7f-487d-8c7e-d7f040e56dd6. Re-issue …', 'terminal_not_writable'));
    const b = new OrcaBackend(orca, undefined, Date.now, 'darwin');
    const sent = await b.sendPrompt('term_1', 'hi').catch((e: unknown) => e);
    expect(sent).toMatchObject({ code: 'terminal_not_writable' });
    expect((sent as Error).message).toMatch(/입력할 수 없어요/);
    await expect(b.sendKeys('term_1', { enter: true })).rejects.toMatchObject({ code: 'terminal_not_writable' });
  });

  it('declares what Orca can do and refuses native-only calls', async () => {
    const b = new OrcaBackend(fake().orca);
    expect(b.capabilities).toEqual({ usage: true, search: true, board: true, hire: true, changes: true, transcripts: true, focus: true, repos: false });
    expect(b.messages.noSession).toMatch(/Agent Session History/);
    expect(b.hook('x', 'y', {})).toBe(false);
    await expect(b.addRepo('/tmp')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(b.dispose()).resolves.toBeUndefined();
  });
});
```

In `bridge/test/demoBackend.test.ts`, change the capabilities expectation to the following, and add an assertion that `new DemoBackend().messages.hireDisabled` is `'데모 모드에서는 만들 수 없어요'`:

```ts
{ usage: true, search: false, board: false, hire: false, changes: false, transcripts: false, focus: false, repos: false }
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npm test -w bridge -- orcaBackend demoBackend`
Expected: FAIL. The capabilities objects lack `focus`/`repos`, `messages` is undefined, and `hook is not a function`.

- [ ] **Step 3: Implement.**
  - **`model.ts`.** Add `BackendCapabilities` and `BackendInfo` exactly as listed under Interfaces, each property with the one-line doc comment that `types.ts` has today. Extend `ServerMessage`.
  - **`types.ts`.** Delete the local `BackendCapabilities` interface and replace it with `import type { BackendCapabilities } from '../model.js'; export type { BackendCapabilities };`. Add `BackendMessages` and the four members to `OfficeBackend`, each with a doc comment:
    - `messages`: user-facing text that depends on the backend.
    - `addRepo`: register a local git repo as a project, for `capabilities.repos`.
    - `hook`: an agent hook event from a backend-spawned agent; returns `false` if unknown or unauthorized.
    - `dispose`: stop everything the backend started; called once on shutdown.
  - **`orca.ts`.**
    - Capabilities gain `focus: true, repos: false`.
    - Add the field:

      ```ts
      readonly messages: BackendMessages = {
        noSession: 'Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)',
        hireDisabled: '이 백엔드에서는 새 작업을 만들 수 없어요',
      };
      ```

    - Add these methods:
      - `addRepo` returns `Promise.reject(new BackendError('Orca에서는 Orca 앱에서 프로젝트를 추가해 주세요', 'unsupported'))`.
      - `hook` returns `false`.
      - `dispose` is `async () => {}`.
    - Add a module-level helper and use it in `deliver` (after the `agent_prompt_blocked` branch, replacing the final `throw err`) and in `sendKeys` (wrap the call in try/catch and `throw notWritable(err)`):

```ts
const NOT_WRITABLE = '이 에이전트 터미널에 입력할 수 없어요 (터미널이 끊겼거나 Orca 화면에 붙어 있지 않음). Orca에서 터미널을 다시 연 뒤 보내 주세요';

/** Orca refuses input to a terminal whose process is gone or detached; say so in words. */
function notWritable(err: unknown): unknown {
  const e = err as OrcaCliError;
  return e?.code === 'terminal_not_writable' || /terminal_not_writable/.test(e?.message ?? '') ? new BackendError(NOT_WRITABLE, 'terminal_not_writable') : err;
}
```

  - **`demo.ts`.** Capabilities gain `focus: false, repos: false`. Add `override readonly messages: BackendMessages = { ...` with `noSession` copied from Orca's and `hireDisabled: '데모 모드에서는 만들 수 없어요' }`.
  - **`server.ts`.**
    - Replace the hard-coded no-session string in `conversation()` with `backend.messages.noSession`.
    - Replace the `/api/hire` disabled string with `backend.messages.hireDisabled`.
    - In `wss.on('connection')`, send `{ type: 'backend', backend: { name: backend.name, capabilities: backend.capabilities } }` first, before `snapshot`.
    - In the API error handler, compute the status as follows, keeping the existing 400 cases first:

      ```ts
      (err as BackendError).code === 'terminal_not_writable' ? 409 : 502
      ```

    - Change the startup log to:

      ```ts
      `[office-desks] bridge on http://${HOST}:${PORT} (${DEMO ? 'DEMO data' : backend.name === 'orca' ? `orca backend, orca cli: ${resolveOrcaCommand()}` : `${backend.name} backend`})`
      ```

- [ ] **Step 4: Run the tests.**

Run: `npm test -w bridge && npm run typecheck -w bridge`
Expected: all PASS. The web typecheck may now fail, because `ServerMessage` gained a case the web does not handle yet. Task 2 handles it. Run `npm run typecheck -w web` and confirm any failure is only about the unhandled `backend` message, or that there is no failure at all.

- [ ] **Step 5: Commit.**

```bash
git add bridge/src/model.ts bridge/src/backend bridge/src/server.ts bridge/test/orcaBackend.test.ts bridge/test/demoBackend.test.ts
git commit -m "Backend v2: capabilities (focus, repos), messages, lifecycle; friendly terminal_not_writable"
```

---

### Task 2: Web consumes backend capabilities; project registration UI; neutral wording

**Files:**
- Create: `web/src/backend.ts`
- Modify: `web/src/api.ts`, `web/src/main.ts`, `web/src/panel.ts`, `web/src/hireDialog.ts`, `web/src/officeScene.ts`

**Interfaces:**
- Consumes: `BackendInfo` and `BackendCapabilities` from `bridge/src/model` (Task 1), and the WS message `{ type: 'backend' }`.
- Consumes `POST /api/repos {path}`, which Task 7 adds. Until then it 404s, which is fine for this task.
- Produces, in `web/src/backend.ts`: `backendInfo(): BackendInfo`, `setBackendInfo(b: BackendInfo): void`.

The web has no DOM test harness, and existing web tests are pure functions only. This task is verified by `typecheck`, `build`, and the end-to-end check in Task 8. Keep logic out of DOM code where it is cheap.

- [ ] **Step 1: Create `web/src/backend.ts`.**

```ts
import type { BackendInfo } from '../../bridge/src/model';

// What the connected bridge's backend can do. Until the bridge says otherwise, assume Orca
// (the first backend), so nothing flickers away for existing users.
let info: BackendInfo = {
  name: 'orca',
  capabilities: { usage: true, search: true, board: true, hire: true, changes: true, transcripts: true, focus: true, repos: false },
};

export function backendInfo(): BackendInfo {
  return info;
}

export function setBackendInfo(next: BackendInfo): void {
  info = next;
}
```

- [ ] **Step 2: Update `api.ts`.**
  - Add a sixth parameter, `onBackend: (b: BackendInfo) => void = () => {}`, to `connectOffice`.
  - Dispatch `else if (msg.type === 'backend') onBackend(msg.backend);`.
  - Import `BackendInfo` in the existing type import.

- [ ] **Step 3: Update `main.ts`.**
  - Import `{ backendInfo, setBackendInfo }` from `./backend`.
  - Pass a sixth callback to `connectOffice`:

```ts
  (b) => {
    setBackendInfo(b);
    renderStatus();
    if (snapshot) {
      scene.setSnapshot(snapshot);
      panel.refresh(snapshot);
    }
  },
```

  - In `renderStatus()`:
    - Render the `data-search` button only when `backendInfo().capabilities.search`.
    - Render the `data-hire` button only when `backendInfo().capabilities.hire`.
    - Replace `⚠️ Orca 오류` with `` ⚠️ ${backendInfo().name === 'orca' ? 'Orca' : '백엔드'} 오류 ``.
  - In the `keydown` handler, make the ⌘/Ctrl+K branch also require `backendInfo().capabilities.search`, and otherwise fall through.

- [ ] **Step 4: Update `panel.ts`.**
  - Import `backendInfo` from `./backend`.
  - Where the header renders (the code that builds `statusSelect(...)` and the `data-comment-row`): when `!backendInfo().capabilities.board`, render neither the status select nor the comment row/edit link. Locate those spots with `grep -n "statusSelect\|data-comment-row" web/src/panel.ts`.
  - In the method that sets `this.focusBtn.disabled = !handle;`, add `this.focusBtn.hidden = !backendInfo().capabilities.focus;`.
  - Change these strings:

    | Old | New |
    |---|---|
    | `'✅ Orca에 저장했습니다'` | `'✅ 저장했습니다'` |
    | placeholder `워크트리 코멘트 (Orca 카드에 표시)` | `워크트리 코멘트` |
    | title `Orca 보드 상태` | `보드 상태` |

- [ ] **Step 5: Update `officeScene.ts`.** Replace the empty-office text (`'Orca 워크트리를 기다리는 중…'`) with:

```ts
backendInfo().capabilities.repos ? '프로젝트가 없어요 — 아래 ➕ 새 작업에서 git 저장소를 추가하세요' : 'Orca 워크트리를 기다리는 중…'
```

Import `backendInfo` from `./backend`.

- [ ] **Step 6: Update `hireDialog.ts` with project registration.**
  - Import `backendInfo` from `./backend`.
  - In `open()`:
    - Compute `const canAddRepo = backendInfo().capabilities.repos && !target;`.
    - When `canAddRepo`, render this block above the project `<label>`:

```html
<fieldset class="add-repo"><legend>프로젝트 추가</legend>
  <label>git 저장소 경로<input name="repoPath" placeholder="/Users/me/code/my-app" /></label>
  <button type="button" data-add-repo>추가</button>
</fieldset>
```

    - When `repos.length === 0 && !target`, render no project `<select>`, name or base-branch fields and no submit button. Show only the add-repo fieldset (if `canAddRepo`) and a `<p class="muted">먼저 프로젝트를 추가하세요.</p>`.
  - After `this.el.hidden = false;`, wire the button:

```ts
    this.el.querySelector('[data-add-repo]')?.addEventListener('click', () => void this.addRepo(form));
```

  - Add the method:

```ts
  private async addRepo(form: HTMLFormElement): Promise<void> {
    const input = form.querySelector<HTMLInputElement>('input[name=repoPath]')!;
    const msg = form.querySelector<HTMLElement>('.msg')!;
    const repoPath = input.value.trim();
    if (!repoPath) return;
    msg.textContent = '프로젝트를 확인하는 중…';
    try {
      await postJson('/api/repos', { path: repoPath });
      msg.textContent = '✅ 추가했어요. 잠시 후 목록에 나타납니다';
      input.value = '';
      // The office poll picks the new repo up; reopen so the select lists it.
      setTimeout(() => this.open(), 1600);
    } catch (err) {
      msg.textContent = `⚠️ ${(err as Error).message}`;
    }
  }
```

  - Keep the `.msg` element in the zero-repo layout too, so feedback has somewhere to go. The `<div class="row">` with `.msg` and a close button stays in every layout; only the submit button is omitted when there are no repos.

- [ ] **Step 7: Verify.**

Run: `npm run typecheck && npm test && npm run build`
Expected: both workspaces typecheck, all tests pass, and the web build succeeds.

- [ ] **Step 8: Commit.**

```bash
git add web/src
git commit -m "Web: follow backend capabilities, add projects from the hire dialog, neutral wording"
```

---

### Task 3: Agent environment scrub and the PTY host

**Files:**
- Create: `bridge/src/native/env.ts`, `bridge/src/native/ptyHost.ts`
- Modify: `package.json`, `bridge/package.json` (dependencies), `package-lock.json` (via `npm install`)
- Test: `bridge/test/env.test.ts`, `bridge/test/ptyHost.test.ts`

**Interfaces:**
- Produces:
  - `agentEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string>`
  - `resolveSpawn(file: string, args: string[], platform?: NodeJS.Platform, resolveWin?: typeof resolveWindowsCommand): { file: string; args: string[] }`
  - `ensureSpawnHelper(root?: string, platform?: NodeJS.Platform, arch?: string): void`
  - The `PtyHost` class:

```ts
export interface PtyOptions { file: string; args: string[]; cwd: string; env: Record<string, string>; cols?: number; rows?: number }
export class PtyHost {
  spawn(id: string, opts: PtyOptions): void;
  has(id: string): boolean;
  write(id: string, data: string): void;       // throws BackendError(code 'terminal_not_writable') if id is gone
  screenLines(id: string): string[];           // [] if unknown
  onExit(fn: (id: string, exitCode: number) => void): () => void;
  kill(id: string): void;
  dispose(): Promise<void>;                     // kills all, resolves when all exited or after 2s
}
```

- [ ] **Step 1: Add the dependencies.**
  - In the root `package.json` `dependencies`, add `"node-pty": "1.1.0"` and `"@xterm/headless": "^6.0.0"`. Add the same two to `bridge/package.json` `dependencies`.
  - Run `npm install` from the repo root.
  - Expected: `package-lock.json` updates. npm 11 may print an `install-scripts` warning; that is fine, because prebuilds are used.

- [ ] **Step 2: Write the failing tests.**

`bridge/test/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { agentEnv } from '../src/native/env.js';

describe('agentEnv', () => {
  it('drops Claude session markers and Orca variables but keeps user auth and config', () => {
    const env = agentEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 's',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ATTENDED: '1',
        CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
        CLAUDE_CODE_EXECPATH: '/x',
        CLAUDE_CODE_MESSAGING_SOCKET: '/s',
        CLAUDE_CODE_MESSAGING_TOKEN: 't',
        CLAUDE_PID: '9',
        CLAUDE_EFFORT: 'high',
        ORCA_AGENT_HOOK_TOKEN: 'secret',
        ORCA_TERMINAL_HANDLE: 'term_1',
        CODEX_HOME: '/Users/me/Library/Application Support/orca/codex-runtime-home/home',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
        ANTHROPIC_API_KEY: 'key',
        UNDEFINED_ONE: undefined,
      },
      { OFFICE_DESKS_HOOK_URL: 'http://127.0.0.1:1/hook/a?token=t' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
      ANTHROPIC_API_KEY: 'key',
      OFFICE_DESKS_HOOK_URL: 'http://127.0.0.1:1/hook/a?token=t',
    });
  });

  it('keeps a CODEX_HOME the user chose', () => {
    expect(agentEnv({ CODEX_HOME: '/Users/me/.codex' }).CODEX_HOME).toBe('/Users/me/.codex');
  });
});
```

`bridge/test/ptyHost.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSpawnHelper, PtyHost, resolveSpawn } from '../src/native/ptyHost.js';

const ECHO = "process.stdin.setEncoding('utf8');process.stdout.write('ready\\r\\n');process.stdin.on('data',d=>process.stdout.write('got:'+d.trim()+'\\r\\n'))";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('PtyHost', () => {
  let host: PtyHost | null = null;
  afterEach(async () => {
    await host?.dispose();
    host = null;
  });

  it('runs a program in a PTY, renders its screen, takes input and reports exit', async () => {
    host = new PtyHost();
    const exits: string[] = [];
    host.onExit((id) => exits.push(id));
    host.spawn('a1', { file: process.execPath, args: ['-e', ECHO], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
    await until(() => host!.screenLines('a1').some((l) => l.includes('ready')));
    host.write('a1', 'hello\r');
    await until(() => host!.screenLines('a1').some((l) => l.includes('got:hello')));
    host.kill('a1');
    await until(() => exits.includes('a1'));
    expect(host.has('a1')).toBe(false);
    expect(() => host!.write('a1', 'x')).toThrow(expect.objectContaining({ code: 'terminal_not_writable' }));
    expect(host.screenLines('a1')).toEqual([]);
  }, 15_000);
});

describe('resolveSpawn', () => {
  it('runs a Windows .cmd shim through cmd.exe and refuses arguments cmd.exe would reinterpret', () => {
    const shim = () => ({ file: 'C:\\npm\\claude.cmd', viaCmd: true });
    expect(resolveSpawn('claude', ['--session-id', 'u'], 'win32', shim)).toEqual({ file: 'cmd.exe', args: ['/d', '/c', 'C:\\npm\\claude.cmd', '--session-id', 'u'] });
    expect(() => resolveSpawn('claude', ['a&b'], 'win32', shim)).toThrow();
    expect(resolveSpawn('claude', ['x'], 'win32', () => ({ file: 'C:\\c\\claude.exe', viaCmd: false }))).toEqual({ file: 'C:\\c\\claude.exe', args: ['x'] });
    expect(resolveSpawn('claude', ['x'], 'darwin')).toEqual({ file: 'claude', args: ['x'] });
  });
});

describe('ensureSpawnHelper', () => {
  it.skipIf(process.platform === 'win32')('makes a prebuilt spawn-helper executable', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'od-pty-'));
    const dir = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`);
    mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, 'spawn-helper');
    writeFileSync(helper, '');
    chmodSync(helper, 0o644);
    ensureSpawnHelper(root);
    expect(statSync(helper).mode & 0o111).not.toBe(0);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail.**

Run: `npm test -w bridge -- env ptyHost`
Expected: FAIL with `Failed to resolve import "../src/native/env.js"`.

- [ ] **Step 4: Implement `bridge/src/native/env.ts`.**

```ts
// The environment a spawned agent gets. If the bridge itself runs inside Claude Code or Orca,
// their per-session markers must not leak: a child that inherits CLAUDE_CODE_CHILD_SESSION
// stops saving its transcript, and ORCA_* would route its hooks into Orca. User settings such
// as CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_OAUTH_TOKEN must pass through untouched.

const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]);

function dropped(key: string, value: string): boolean {
  if (SESSION_MARKERS.has(key) || key.startsWith('CLAUDE_CODE_MESSAGING_') || key.startsWith('ORCA_')) return true;
  // Orca points Codex at its own runtime home; a user's own CODEX_HOME stays.
  return key === 'CODEX_HOME' && /codex-runtime-home/.test(value);
}

export function agentEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !dropped(k, v)) env[k] = v;
  return { ...env, ...extra };
}
```

- [ ] **Step 5: Implement `bridge/src/native/ptyHost.ts`.**

```ts
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import xtermHeadless from '@xterm/headless';
import * as pty from 'node-pty';
import { BackendError } from '../backend/types.js';
import { resolveWindowsCommand, unsafeForCmdShim } from '../orcaCli.js';

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

const COLS = 120;
const ROWS = 40;
const GONE = '이 에이전트 터미널은 이미 종료됐어요';

/**
 * node-pty's prebuilt spawn-helper can arrive without its execute bit (npm 11 skips install
 * scripts), and then every spawn fails with "posix_spawnp failed". Fix it before first use.
 */
export function ensureSpawnHelper(
  root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json')),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform === 'win32') return;
  for (const dir of [path.join(root, 'prebuilds', `${platform}-${arch}`), path.join(root, 'build', 'Release')]) {
    const helper = path.join(dir, 'spawn-helper');
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        throw new Error(`node-pty's spawn-helper is not executable. Run: chmod +x "${helper}"`);
      }
    }
  }
}

/** Windows: a .cmd shim (npm-installed CLIs) must run through cmd.exe, which re-parses arguments. */
export function resolveSpawn(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  resolveWin: typeof resolveWindowsCommand = resolveWindowsCommand,
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file, args };
  const r = resolveWin(file);
  if (!r.viaCmd) return { file: r.file, args };
  if (args.some(unsafeForCmdShim)) throw new BackendError(`${file}.cmd로는 이 인자를 안전하게 넘길 수 없어요`, 'unsafe_for_cmd');
  return { file: 'cmd.exe', args: ['/d', '/c', r.file, ...args] };
}

export interface PtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

interface Session {
  proc: pty.IPty;
  term: HeadlessTerminal;
}

/** Agent processes in pseudo-terminals, each mirrored into a headless xterm we can read like a screen. */
export class PtyHost {
  private sessions = new Map<string, Session>();
  private exitListeners = new Set<(id: string, exitCode: number) => void>();

  constructor() {
    ensureSpawnHelper();
  }

  spawn(id: string, opts: PtyOptions): void {
    const cols = opts.cols ?? COLS;
    const rows = opts.rows ?? ROWS;
    const { file, args } = resolveSpawn(opts.file, opts.args);
    const term = new Terminal({ cols, rows, allowProposedApi: true });
    const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: opts.env });
    proc.onData((d) => term.write(d));
    // TUIs query the terminal (cursor position, device attributes) and wait for the answer.
    term.onData((d) => {
      if (this.sessions.get(id)?.proc === proc) proc.write(d);
    });
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.proc !== proc) return;
      this.sessions.delete(id);
      term.dispose();
      for (const fn of this.exitListeners) fn(id, exitCode);
    });
    this.sessions.set(id, { proc, term });
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) throw new BackendError(GONE, 'terminal_not_writable');
    s.proc.write(data);
  }

  screenLines(id: string): string[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    const buf = s.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < s.term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
    return lines;
  }

  onExit(fn: (id: string, exitCode: number) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  kill(id: string): void {
    this.sessions.get(id)?.proc.kill();
  }

  async dispose(): Promise<void> {
    if (!this.sessions.size) return;
    const done = new Promise<void>((resolve) => {
      const off = this.onExit(() => {
        if (!this.sessions.size) {
          off();
          resolve();
        }
      });
    });
    for (const s of this.sessions.values()) s.proc.kill();
    await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  }
}
```

If `tsc` rejects `import xtermHeadless from '@xterm/headless'` under NodeNext, use `import * as xtermHeadless from '@xterm/headless'` instead, and `const { Terminal } = (xtermHeadless as { default?: typeof xtermHeadless }).default ?? xtermHeadless;`. Whatever form you use must also work at runtime under tsx and under the compiled `dist`. Verify with `npm run build -w bridge && node -e "import('./bridge/dist/native/ptyHost.js').then(m=>console.log(typeof m.PtyHost))"`, which must print `function`.

- [ ] **Step 6: Run the tests.**

Run: `npm test -w bridge -- env ptyHost`
Expected: PASS. The `ensureSpawnHelper` test is skipped on Windows.

- [ ] **Step 7: Run the full suite, the typecheck and the dist import check.** Commit only if all three pass.

```bash
npm test -w bridge && npm run typecheck -w bridge && npm run build -w bridge && node -e "import('./bridge/dist/native/ptyHost.js').then(m=>console.log(typeof m.PtyHost))"
```

- [ ] **Step 8: Commit.**

```bash
git add package.json package-lock.json bridge/package.json bridge/src/native/env.ts bridge/src/native/ptyHost.ts bridge/test/env.test.ts bridge/test/ptyHost.test.ts
git commit -m "Native: agent env scrub and PTY host (node-pty + headless xterm)"
```

---

### Task 4: Office home, project registry and git worktrees

**Files:**
- Create: `bridge/src/home.ts`, `bridge/src/native/registry.ts`, `bridge/src/native/worktrees.ts`
- Modify: `bridge/src/awards.ts`, `bridge/src/org.ts` (default file under `officeHome()`)
- Test: `bridge/test/registry.test.ts`, `bridge/test/worktrees.test.ts`

**Interfaces:**
- Produces:
  - `officeHome(env?: NodeJS.ProcessEnv): string`
  - Registry types and class:

```ts
export interface RepoRecord { id: string; path: string; name: string }
export interface DeskMeta { workspaceStatus?: string; comment?: string }
export class Registry {
  constructor(file: string);
  load(): Promise<void>;                    // missing file → empty
  get repos(): RepoRecord[];
  addRepo(repo: RepoRecord): Promise<void>; // same id twice → no duplicate
  meta(deskId: string): DeskMeta;
  setMeta(deskId: string, patch: DeskMeta): Promise<void>; // '' comment clears it
}
```

  - Worktree types and functions:

```ts
export interface WorktreeInfo { path: string; branch: string; head: string; isMain: boolean }
export function parsePorcelain(out: string): WorktreeInfo[];          // bare/prunable entries skipped
export function listWorktrees(repoPath: string, git?: GitRunner): Promise<WorktreeInfo[]>;
export function resolveRepo(dir: string, git?: GitRunner): Promise<RepoRecord>; // main worktree path, id = sha1(path) first 12 hex
export function addWorktree(repoPath: string, dest: string, branch: string, base: string | null, git?: GitRunner): Promise<void>;
export function worktreeDest(home: string, repoName: string, name: string): string;
```

- [ ] **Step 1: Write the failing tests.**

`bridge/test/registry.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { officeHome } from '../src/home.js';
import { Registry } from '../src/native/registry.js';

describe('officeHome', () => {
  it('honors OFFICE_DESKS_HOME, else ~/.office-desks', () => {
    expect(officeHome({ OFFICE_DESKS_HOME: '/tmp/od' })).toBe('/tmp/od');
    expect(officeHome({})).toBe(path.join(os.homedir(), '.office-desks'));
  });
});

describe('Registry', () => {
  it('persists repos and desk metadata atomically and reloads them', async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'od-reg-')), 'state.json');
    const r = new Registry(file);
    await r.load();
    expect(r.repos).toEqual([]);
    await r.addRepo({ id: 'abc', path: '/p/app', name: 'app' });
    await r.addRepo({ id: 'abc', path: '/p/app', name: 'app' });
    await r.setMeta('abc::/p/app', { workspaceStatus: 'in-review', comment: 'hi' });
    await r.setMeta('abc::/p/app', { comment: '' });

    const again = new Registry(file);
    await again.load();
    expect(again.repos).toEqual([{ id: 'abc', path: '/p/app', name: 'app' }]);
    expect(again.meta('abc::/p/app')).toEqual({ workspaceStatus: 'in-review' });
    expect(again.meta('nope')).toEqual({});
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
  });
});
```

`bridge/test/worktrees.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorktree, listWorktrees, parsePorcelain, resolveRepo, worktreeDest } from '../src/native/worktrees.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function scratchRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-git-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

describe('parsePorcelain', () => {
  it('reads main and linked worktrees, skipping bare ones', () => {
    const out = 'worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w/feat\nHEAD bbb\nbranch refs/heads/feat\n\nworktree /w/det\nHEAD ccc\ndetached\n\nworktree /bare\nbare\n\n';
    expect(parsePorcelain(out)).toEqual([
      { path: '/r', branch: 'main', head: 'aaa', isMain: true },
      { path: '/w/feat', branch: 'feat', head: 'bbb', isMain: false },
      { path: '/w/det', branch: '', head: 'ccc', isMain: false },
    ]);
  });
});

describe('git worktrees', () => {
  it('resolves a repo from any folder inside it, adds a worktree and lists it', async () => {
    const repo = scratchRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'x');
    const rec = await resolveRepo(repo);
    expect(rec).toMatchObject({ path: repo, name: path.basename(repo) });
    expect(rec.id).toMatch(/^[0-9a-f]{12}$/);

    const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'od-home-')));
    const dest = worktreeDest(home, rec.name, 'fix-login');
    expect(dest).toBe(path.join(home, 'worktrees', rec.name, 'fix-login'));
    await addWorktree(repo, dest, 'fix-login', null);
    const list = await listWorktrees(repo);
    expect(list.map((w) => [path.normalize(w.path), w.branch, w.isMain])).toEqual([
      [path.normalize(repo), 'main', true],
      [path.normalize(dest), 'fix-login', false],
    ]);
    // Resolving from inside a linked worktree still names the main checkout.
    expect((await resolveRepo(dest)).path).toBe(rec.path);
  });

  it('rejects a folder that is not a git repository with a readable error', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-nogit-'));
    await expect(resolveRepo(dir)).rejects.toMatchObject({ code: 'not_a_repo' });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npm test -w bridge -- registry worktrees`
Expected: FAIL with `Failed to resolve import "../src/home.js"`.

- [ ] **Step 3: Implement `bridge/src/home.ts`.**

```ts
import os from 'node:os';
import path from 'node:path';

/** Where Office Desks keeps its files. OFFICE_DESKS_HOME lets tests and trials use a fresh one. */
export function officeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.OFFICE_DESKS_HOME?.trim() || path.join(os.homedir(), '.office-desks');
}
```

Then change the default file location in `awards.ts` and `org.ts` while keeping their signatures. The `home` parameter becomes optional with no default:
- `awardsFile(home?: string)` returns `home ? path.join(home, '.office-desks', 'awards.json') : path.join(officeHome(), 'awards.json')`.
- `orgFile` follows the same pattern with `org.json`.

Existing tests that pass a `home` keep working.

- [ ] **Step 4: Implement `bridge/src/native/registry.ts`.**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Projects the user registered and the board fields Orca would otherwise keep (status, comment).

export interface RepoRecord {
  id: string;
  /** The repo's main checkout. */
  path: string;
  name: string;
}

export interface DeskMeta {
  workspaceStatus?: string;
  comment?: string;
}

interface RegistryData {
  version: 1;
  repos: RepoRecord[];
  desks: Record<string, DeskMeta>;
}

export class Registry {
  private data: RegistryData = { version: 1, repos: [], desks: {} };

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<RegistryData>;
      this.data = { version: 1, repos: Array.isArray(parsed.repos) ? parsed.repos : [], desks: parsed.desks ?? {} };
    } catch {
      this.data = { version: 1, repos: [], desks: {} };
    }
  }

  get repos(): RepoRecord[] {
    return this.data.repos;
  }

  async addRepo(repo: RepoRecord): Promise<void> {
    if (this.data.repos.some((r) => r.id === repo.id)) return;
    this.data.repos.push(repo);
    await this.save();
  }

  meta(deskId: string): DeskMeta {
    return this.data.desks[deskId] ?? {};
  }

  async setMeta(deskId: string, patch: DeskMeta): Promise<void> {
    const next = { ...this.meta(deskId), ...patch };
    if (!next.comment) delete next.comment;
    this.data.desks[deskId] = next;
    await this.save();
  }

  /** Write a temp file and rename it, so a crash never leaves half a file behind. */
  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.file);
  }
}
```

- [ ] **Step 5: Implement `bridge/src/native/worktrees.ts`.**

```ts
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BackendError } from '../backend/types.js';
import { runGit, type GitRunner } from '../gitInfo.js';
import type { RepoRecord } from './registry.js';

// Worktrees straight from git: list them, create one per task, and identify a repo by its main checkout.

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

/** `git worktree list --porcelain`: blank-line separated records, the main worktree first. */
export function parsePorcelain(out: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ');
      if (line) fields.set(sp < 0 ? line : line.slice(0, sp), sp < 0 ? '' : line.slice(sp + 1));
    }
    const wt = fields.get('worktree');
    if (!wt || fields.has('bare')) continue;
    list.push({
      path: wt,
      branch: (fields.get('branch') ?? '').replace(/^refs\/heads\//, ''),
      head: fields.get('HEAD') ?? '',
      isMain: list.length === 0,
    });
  }
  return list;
}

export async function listWorktrees(repoPath: string, git: GitRunner = runGit): Promise<WorktreeInfo[]> {
  return parsePorcelain(await git(repoPath, ['worktree', 'list', '--porcelain']));
}

/** The repo that `dir` belongs to, named after its main checkout (also from inside a linked worktree). */
export async function resolveRepo(dir: string, git: GitRunner = runGit): Promise<RepoRecord> {
  let main: WorktreeInfo | undefined;
  try {
    main = (await listWorktrees(dir, git))[0];
  } catch {
    main = undefined;
  }
  if (!main) throw new BackendError(`git 저장소가 아니에요: ${dir}`, 'not_a_repo');
  const repoPath = path.normalize(main.path);
  const id = createHash('sha1').update(process.platform === 'win32' ? repoPath.toLowerCase() : repoPath).digest('hex').slice(0, 12);
  return { id, path: repoPath, name: path.basename(repoPath) };
}

export async function addWorktree(repoPath: string, dest: string, branch: string, base: string | null, git: GitRunner = runGit): Promise<void> {
  await git(repoPath, ['worktree', 'add', '-b', branch, dest, ...(base ? [base] : [])]);
}

export function worktreeDest(home: string, repoName: string, name: string): string {
  return path.join(home, 'worktrees', repoName.replace(/[^A-Za-z0-9._-]/g, '_'), name);
}
```

Note that `git worktree list` prints forward slashes on Windows. `path.normalize` turns them into backslashes, and the worktree test compares normalized paths.

- [ ] **Step 6: Run the tests.**

Run: `npm test -w bridge -- registry worktrees awards org`
Expected: PASS.

- [ ] **Step 7: Run the full suite and the typecheck, then commit.**

```bash
npm test -w bridge && npm run typecheck -w bridge
git add bridge/src/home.ts bridge/src/awards.ts bridge/src/org.ts bridge/src/native/registry.ts bridge/src/native/worktrees.ts bridge/test/registry.test.ts bridge/test/worktrees.test.ts
git commit -m "Native: office home, project registry and git worktrees"
```

---

### Task 5: Claude hooks — settings, relay script, event reducer

**Files:**
- Create: `bridge/src/native/hooks.ts`, `bridge/hook-relay.mjs`
- Modify: `package.json` (`files` adds `"bridge/hook-relay.mjs"`)
- Test: `bridge/test/hooks.test.ts`, `bridge/test/hookRelay.test.ts`

**Interfaces:**
- Produces:

```ts
export const HOOK_EVENTS: readonly string[];  // SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop
export function relayScript(): string;        // absolute path of bridge/hook-relay.mjs (works from src/ and dist/)
export function hookSettings(relay: string, node?: string): { hooks: Record<string, { matcher?: string; hooks: { type: 'command'; command: string }[] }[]> };
export interface HookState {
  rawState: string;            // fed to stateMapper.mapAgentState: 'unknown' | 'working' | 'waiting' | 'done'
  toolName: string | null; toolInput: string | null; prompt: string | null; lastMessage: string | null;
  since: number; started: boolean; sessionId: string | null; transcriptPath: string | null;
}
export function initialHookState(now: number): HookState;
export function applyHook(s: HookState, payload: Record<string, unknown>, now: number): HookState;
```

- [ ] **Step 1: Write the failing tests.**

`bridge/test/hooks.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyHook, hookSettings, initialHookState, relayScript } from '../src/native/hooks.js';

describe('hookSettings', () => {
  it('runs the relay with this node for every event, matching all tools', () => {
    const s = hookSettings('C:\\od\\bridge\\hook-relay.mjs', 'C:\\Program Files\\nodejs\\node.exe');
    const cmd = '"C:/Program Files/nodejs/node.exe" "C:/od/bridge/hook-relay.mjs"';
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']);
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }]);
  });

  it('points at the shipped relay script', () => {
    expect(existsSync(relayScript())).toBe(true);
  });
});

describe('applyHook', () => {
  const t0 = initialHookState(1000);

  it('follows a turn: start → prompt → tool → done', () => {
    let s = applyHook(t0, { hook_event_name: 'SessionStart', session_id: 'sid', transcript_path: '/p/sid.jsonl', source: 'startup' }, 2000);
    expect(s).toMatchObject({ rawState: 'done', started: true, sessionId: 'sid', transcriptPath: '/p/sid.jsonl', since: 2000 });
    s = applyHook(s, { hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }, 3000);
    expect(s).toMatchObject({ rawState: 'working', prompt: 'fix the bug', toolName: null, since: 3000 });
    s = applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests' } }, 4000);
    expect(s).toMatchObject({ rawState: 'working', toolName: 'Bash', toolInput: 'npm test', since: 3000 });
    s = applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 5000);
    expect(s).toMatchObject({ rawState: 'working', toolName: null });
    s = applyHook(s, { hook_event_name: 'Stop', last_assistant_message: 'All green.' }, 6000);
    expect(s).toMatchObject({ rawState: 'done', lastMessage: 'All green.', since: 6000 });
  });

  it('waits on a permission notification, but an idle reminder means done', () => {
    const working = applyHook(t0, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }, 2000);
    expect(applyHook(working, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 3000).rawState).toBe('waiting');
    expect(applyHook(working, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Edit' }, 3000).rawState).toBe('waiting');
    expect(applyHook(working, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, 3000).rawState).toBe('done');
  });

  it('ignores unknown events and malformed fields', () => {
    expect(applyHook(t0, { hook_event_name: 'SubagentStop' }, 2000)).toEqual(t0);
    expect(applyHook(t0, { hook_event_name: 'PreToolUse', tool_name: 42, tool_input: 'x' }, 2000)).toMatchObject({ toolName: null, toolInput: null });
  });
});
```

`bridge/test/hookRelay.test.ts`:

```ts
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { relayScript } from '../src/native/hooks.js';

function runRelay(input: string, env: Record<string, string>): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [relayScript()], { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', (code) => resolve(code));
    p.stdin.end(input);
  });
}

describe('hook-relay.mjs', () => {
  it('posts the hook JSON to OFFICE_DESKS_HOOK_URL', async () => {
    let got = '';
    const server = createServer((req, res) => {
      req.setEncoding('utf8').on('data', (d: string) => (got += d)).on('end', () => res.end());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const code = await runRelay('{"hook_event_name":"Stop"}', { OFFICE_DESKS_HOOK_URL: `http://127.0.0.1:${port}/hook/a?token=t` });
    server.close();
    expect(code).toBe(0);
    expect(JSON.parse(got)).toEqual({ hook_event_name: 'Stop' });
  });

  it('never fails the agent: no URL or an unreachable bridge still exits 0', async () => {
    expect(await runRelay('{}', { OFFICE_DESKS_HOOK_URL: '' })).toBe(0);
    expect(await runRelay('{}', { OFFICE_DESKS_HOOK_URL: 'http://127.0.0.1:9/hook/a?token=t' })).toBe(0);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npm test -w bridge -- hooks hookRelay`
Expected: FAIL with `Failed to resolve import "../src/native/hooks.js"`.

- [ ] **Step 3: Create `bridge/hook-relay.mjs`.** It is plain ESM JavaScript and is not compiled.

```js
// Claude Code hook → Office Desks bridge. Claude runs this for each hook event with the event
// JSON on stdin; we POST it to the bridge that spawned the agent. It must never block or fail
// the agent, so every error is swallowed and the exit code is always 0.
const url = process.env.OFFICE_DESKS_HOOK_URL;
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (body += d));
process.stdin.on('end', async () => {
  if (url) {
    try {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2000) });
    } catch {
      /* the bridge may be gone; the agent goes on */
    }
  }
  process.exit(0);
});
```

Add `"bridge/hook-relay.mjs"` to the root `package.json` `files` array, after `"bridge/dist"`.

- [ ] **Step 4: Implement `bridge/src/native/hooks.ts`.**

```ts
import { fileURLToPath } from 'node:url';

// Claude Code reports what it is doing through hooks. We pass them in with `--settings` so the
// user's own settings stay untouched, relay each event to the bridge, and fold the events into
// the same raw states Orca reports (see stateMapper.mapAgentState).

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'] as const;
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/** bridge/hook-relay.mjs, from both src/native/ and dist/native/. */
export function relayScript(): string {
  return fileURLToPath(new URL('../../hook-relay.mjs', import.meta.url));
}

/** Forward slashes: hook commands run in a POSIX shell (Git Bash on Windows). */
export function hookSettings(relay: string, node: string = process.execPath) {
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  const hook = { type: 'command' as const, command: `${q(node)} ${q(relay)}` };
  const hooks: Record<string, { matcher?: string; hooks: (typeof hook)[] }[]> = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ ...(TOOL_EVENTS.has(ev) ? { matcher: '*' } : {}), hooks: [hook] }];
  return { hooks };
}

export interface HookState {
  rawState: string;
  toolName: string | null;
  toolInput: string | null;
  prompt: string | null;
  lastMessage: string | null;
  since: number;
  /** SessionStart arrived: the agent is past any startup dialog and ready for a prompt. */
  started: boolean;
  sessionId: string | null;
  transcriptPath: string | null;
}

export function initialHookState(now: number): HookState {
  return { rawState: 'unknown', toolName: null, toolInput: null, prompt: null, lastMessage: null, since: now, started: false, sessionId: null, transcriptPath: null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

/** The one field of a tool call worth showing ("npm test", "src/a.ts", …). */
function toolSummary(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = str(o[k]);
    if (v) return v.slice(0, 200);
  }
  return null;
}

function isPermission(p: Record<string, unknown>): boolean {
  const type = str(p.notification_type);
  if (type) return type === 'permission_prompt';
  return /permission|approve|needs your/i.test(str(p.message) ?? '');
}

export function applyHook(s: HookState, p: Record<string, unknown>, now: number): HookState {
  const ev = str(p.hook_event_name);
  const base: HookState = {
    ...s,
    sessionId: str(p.session_id) ?? s.sessionId,
    transcriptPath: str(p.transcript_path) ?? s.transcriptPath,
  };
  const to = (rawState: string, patch: Partial<HookState> = {}): HookState => ({
    ...base,
    ...patch,
    rawState,
    since: rawState === s.rawState ? s.since : now,
  });
  switch (ev) {
    case 'SessionStart':
      return to('done', { started: true });
    case 'UserPromptSubmit':
      return to('working', { prompt: str(p.prompt) ?? s.prompt, toolName: null, toolInput: null });
    case 'PreToolUse':
      return to('working', { toolName: str(p.tool_name), toolInput: toolSummary(p.tool_input) });
    case 'PostToolUse':
      return to('working', { toolName: null, toolInput: null });
    case 'Notification':
      return isPermission(p) ? to('waiting') : to('done');
    case 'Stop':
      return to('done', { lastMessage: str(p.last_assistant_message) ?? s.lastMessage, toolName: null, toolInput: null });
    default:
      return s;
  }
}
```

- [ ] **Step 5: Run the tests.**

Run: `npm test -w bridge -- hooks hookRelay`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full suite and the typecheck, then commit.**

```bash
npm test -w bridge && npm run typecheck -w bridge
git add package.json bridge/hook-relay.mjs bridge/src/native/hooks.ts bridge/test/hooks.test.ts bridge/test/hookRelay.test.ts
git commit -m "Native: Claude hook settings, relay script and state reducer"
```

---

### Task 6: NativeBackend

**Files:**
- Create: `bridge/src/backend/native.ts`
- Test: `bridge/test/nativeBackend.test.ts`

**Interfaces:**
- Consumes:
  - `PtyHost`'s public surface. It is typed structurally here as `PtyLike`, so tests can pass a fake.
  - `agentEnv`, `Registry`, `RepoRecord`.
  - `listWorktrees`, `resolveRepo`, `addWorktree`, `worktreeDest`.
  - `hookSettings`, `relayScript`, `initialHookState`, `applyHook`, `HookState`.
  - `toSnapshot`, `OrcaWorktreeRow`, `OrcaTerminalRow` from `stateMapper.ts`.
  - `composerState` from `screen.ts`.
- Produces:

```ts
export type PtyLike = Pick<PtyHost, 'spawn' | 'has' | 'write' | 'screenLines' | 'onExit' | 'kill' | 'dispose'>;
export interface NativeDeps {
  pty: PtyLike; registry: Registry; home: string;
  /** e.g. (id, token) => `http://127.0.0.1:4317/hook/${id}?token=${token}` */
  hookUrl: (agentId: string, token: string) => string;
  git?: GitRunner; claudeProjects?: string; env?: NodeJS.ProcessEnv; now?: () => number;
  relay?: string; node?: string; sleep?: (ms: number) => Promise<void>;
}
export class NativeBackend implements OfficeBackend { constructor(deps: NativeDeps) }
```

  - `name` is `'native'`.
  - Capabilities: `{ usage: false, search: false, board: true, hire: true, changes: true, transcripts: true, focus: false, repos: true }`.
  - Agent ids are `<uuid>:main`, the `paneKey` form `toSnapshot` uses as the agent id. Terminal handles are `pty_<uuid>`.

- [ ] **Step 1: Write the failing tests.** Create `bridge/test/nativeBackend.test.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeBackend, type PtyLike } from '../src/backend/native.js';
import type { PtyOptions } from '../src/native/ptyHost.js';
import { Registry } from '../src/native/registry.js';

const READY = ['', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on'];
const TRUST = [' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];

class FakePty implements PtyLike {
  spawned: { id: string; opts: PtyOptions }[] = [];
  writes: [string, string][] = [];
  screens = new Map<string, string[]>();
  private exits = new Set<(id: string, code: number) => void>();
  spawn(id: string, opts: PtyOptions): void {
    this.spawned.push({ id, opts });
    this.screens.set(id, READY);
  }
  has(id: string): boolean {
    return this.screens.has(id);
  }
  write(id: string, data: string): void {
    this.writes.push([id, data]);
  }
  screenLines(id: string): string[] {
    return this.screens.get(id) ?? [];
  }
  onExit(fn: (id: string, code: number) => void): () => void {
    this.exits.add(fn);
    return () => this.exits.delete(fn);
  }
  kill(id: string): void {
    this.screens.delete(id);
    for (const fn of this.exits) fn(id, 0);
  }
  async dispose(): Promise<void> {
    for (const id of [...this.screens.keys()]) this.kill(id);
  }
}

const REPO = { id: 'abcdef123456', path: '/p/app', name: 'app' };
const PORCELAIN = 'worktree /p/app\nHEAD a\nbranch refs/heads/main\n\nworktree /h/worktrees/app/feat\nHEAD b\nbranch refs/heads/feat\n\n';

async function setup(git: (cwd: string, args: string[]) => Promise<string> = async () => PORCELAIN) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'od-native-'));
  const registry = new Registry(path.join(home, 'state.json'));
  await registry.load();
  await registry.addRepo(REPO);
  const pty = new FakePty();
  const gitCalls: string[][] = [];
  const backend = new NativeBackend({
    pty,
    registry,
    home,
    hookUrl: (id, token) => `http://127.0.0.1:4317/hook/${id}?token=${token}`,
    git: async (cwd, args) => {
      gitCalls.push([cwd, ...args]);
      return git(cwd, args);
    },
    claudeProjects: path.join(home, 'claude-projects'),
    env: { PATH: '/bin', CLAUDECODE: '1' },
    relay: '/r/hook-relay.mjs',
    node: '/n/node',
    sleep: async () => {},
  });
  return { backend, pty, registry, home, gitCalls };
}

const tokenOf = (pty: FakePty, i = 0) => new URL(pty.spawned[i].opts.env.OFFICE_DESKS_HOOK_URL).searchParams.get('token')!;

describe('NativeBackend snapshot', () => {
  it('lists every worktree of registered repos as desks, with board metadata', async () => {
    const { backend, registry } = await setup();
    await registry.setMeta('abcdef123456::/h/worktrees/app/feat', { workspaceStatus: 'in-review', comment: 'look' });
    const s = await backend.snapshot();
    expect(s.desks.map((d) => [d.id, d.isMain, d.branch, d.repo, d.workspaceStatus, d.comment])).toEqual([
      ['abcdef123456::/h/worktrees/app/feat', false, 'feat', 'app', 'in-review', 'look'],
      ['abcdef123456::/p/app', true, 'main', 'app', null, ''],
    ]);
  });
});

describe('NativeBackend hire and hooks', () => {
  it('spawns claude with a session id, hook settings and a scrubbed env', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const { opts } = pty.spawned[0];
    expect(opts.file).toBe('claude');
    expect(opts.cwd).toBe('/p/app');
    expect(opts.args[0]).toBe('--session-id');
    expect(opts.args[2]).toBe('--settings');
    expect(opts.env.CLAUDECODE).toBeUndefined();
    expect(opts.env.OFFICE_DESKS_HOOK_URL).toMatch(/^http:\/\/127\.0\.0\.1:4317\/hook\/[0-9a-f-]+:main\?token=[0-9a-f]{32}$/);
    const desk = (await backend.snapshot()).desks.find((d) => d.id === 'abcdef123456::/p/app')!;
    expect(desk.agents).toHaveLength(1);
    expect(desk.agents[0]).toMatchObject({ agentType: 'claude', terminalHandle: `pty_${pty.spawned[0].id}` });
  });

  it('creates a worktree for a new task, then runs the agent in it', async () => {
    const { backend, pty, gitCalls, home } = await setup();
    await backend.hire({ kind: 'worktree', repoId: 'abcdef123456', name: 'fix-login', agent: 'codex', baseBranch: 'origin/main', prompt: null });
    const dest = path.join(home, 'worktrees', 'app', 'fix-login');
    expect(gitCalls).toContainEqual(['/p/app', 'worktree', 'add', '-b', 'fix-login', dest, 'origin/main']);
    expect(pty.spawned[0].opts).toMatchObject({ file: 'codex', args: [], cwd: dest });
  });

  it('delivers the pending first prompt once, on SessionStart, even after a trust dialog', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: 'fix the login bug' });
    const id = pty.spawned[0].id;
    const agentId = `${id}:main`;
    pty.screens.set(id, TRUST);
    let s = await backend.snapshot();
    expect(s.desks[1].agents[0].state).toBe('waiting'); // the trust dialog needs the user
    expect(pty.writes).toEqual([]);

    pty.screens.set(id, READY);
    expect(backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', session_id: 's1', transcript_path: '/t/s1.jsonl' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(pty.writes).toEqual([
      [id, '\x1b[200~fix the login bug\x1b[201~'],
      [id, '\r'],
    ]);
    backend.hook(agentId, tokenOf(pty), { hook_event_name: 'SessionStart', source: 'clear' });
    await new Promise((r) => setTimeout(r, 0));
    expect(pty.writes).toHaveLength(2);
    s = await backend.snapshot();
    expect(s.desks[1].agents[0].state).toBe('done');
  });

  it('rejects a wrong token or unknown agent and changes nothing', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const agentId = `${pty.spawned[0].id}:main`;
    expect(backend.hook(agentId, 'f'.repeat(32), { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe(false);
    expect(backend.hook('nope:main', tokenOf(pty), { hook_event_name: 'UserPromptSubmit', prompt: 'x' })).toBe(false);
    expect((await backend.snapshot()).desks[1].agents[0].prompt).toBeNull();
  });

  it('maps hook events to states the office understands', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const agentId = `${pty.spawned[0].id}:main`;
    const t = tokenOf(pty);
    backend.hook(agentId, t, { hook_event_name: 'SessionStart' });
    backend.hook(agentId, t, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
    backend.hook(agentId, t, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } });
    const a = (await backend.snapshot()).desks[1].agents[0];
    expect(a).toMatchObject({ state: 'reading', rawState: 'working', prompt: 'go', activity: 'Read: src/a.ts' });
  });

  it('removes an agent whose process exited', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    pty.kill(pty.spawned[0].id);
    expect((await backend.snapshot()).desks[1].agents).toEqual([]);
  });
});

describe('NativeBackend input, board, sessions, repos', () => {
  it('pastes prompts and types keys into the PTY', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const id = pty.spawned[0].id;
    await backend.sendPrompt(`pty_${id}`, 'line one\nline two');
    await backend.sendKeys(`pty_${id}`, { bytes: '\x1b[A' });
    await backend.sendKeys(`pty_${id}`, { enter: true });
    expect(pty.writes).toEqual([
      [id, '\x1b[200~line one\nline two\x1b[201~'],
      [id, '\r'],
      [id, '\x1b[A'],
      [id, '\r'],
    ]);
    expect(await backend.readScreen(`pty_${id}`)).toEqual(READY);
    expect(backend.blockedHandle('x')).toBeNull();
    await expect(backend.retryPrompt('x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('stores the board in the registry', async () => {
    const { backend, registry } = await setup();
    await backend.setBoard('abcdef123456::/p/app', { workspaceStatus: 'todo', comment: 'c' });
    await backend.setBoard('abcdef123456::/p/app', { comment: '' });
    expect(registry.meta('abcdef123456::/p/app')).toEqual({ workspaceStatus: 'todo' });
  });

  it('finds the transcript from the hook, or by session id under the projects folder', async () => {
    const { backend, pty, home } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    const sid = pty.spawned[0].opts.args[1];
    const agentId = `${pty.spawned[0].id}:main`;
    const s = await backend.snapshot();
    const desk = s.desks[1];
    const agent = desk.agents[0];
    expect(await backend.findSession(desk, agent)).toBeNull();
    const dir = path.join(home, 'claude-projects', '-p-app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${sid}.jsonl`), '{}\n');
    expect(await backend.findSession(desk, agent)).toBe(path.join(dir, `${sid}.jsonl`));
    expect(backend.cachedSession(agentId)).toBe(path.join(dir, `${sid}.jsonl`));
  });

  it('registers a repo from any folder inside it', async () => {
    const { backend, registry } = await setup(async () => 'worktree /q/other\nHEAD a\nbranch refs/heads/main\n\n');
    await backend.addRepo('/q/other/src');
    expect(registry.repos.map((r) => r.path)).toContain(path.normalize('/q/other'));
    await expect(backend.addRepo('relative/path')).rejects.toMatchObject({ code: 'not_absolute' });
  });

  it('kills every agent on dispose', async () => {
    const { backend, pty } = await setup();
    await backend.hire({ kind: 'agent', deskId: 'abcdef123456::/p/app', agent: 'claude', prompt: null });
    await backend.dispose();
    expect(pty.screens.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npm test -w bridge -- nativeBackend`
Expected: FAIL with `Failed to resolve import "../src/backend/native.js"`.

- [ ] **Step 3: Implement `bridge/src/backend/native.ts`.**

```ts
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit, type GitRunner } from '../gitInfo.js';
import type { OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot } from '../model.js';
import { agentEnv } from '../native/env.js';
import { applyHook, hookSettings, initialHookState, relayScript, type HookState } from '../native/hooks.js';
import type { PtyHost } from '../native/ptyHost.js';
import type { Registry } from '../native/registry.js';
import { addWorktree, listWorktrees, resolveRepo, worktreeDest, type WorktreeInfo } from '../native/worktrees.js';
import { composerState } from '../screen.js';
import { toSnapshot, type OrcaTerminalRow, type OrcaWorktreeRow } from '../stateMapper.js';
import {
  BackendError,
  type BackendCapabilities,
  type BackendMessages,
  type ConversationHit,
  type HireResult,
  type HireSpec,
  type KeyInput,
  type OfficeBackend,
} from './types.js';

export type PtyLike = Pick<PtyHost, 'spawn' | 'has' | 'write' | 'screenLines' | 'onExit' | 'kill' | 'dispose'>;

export interface NativeDeps {
  pty: PtyLike;
  registry: Registry;
  home: string;
  hookUrl: (agentId: string, token: string) => string;
  git?: GitRunner;
  claudeProjects?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  relay?: string;
  node?: string;
  sleep?: (ms: number) => Promise<void>;
}

interface Agent {
  /** The PTY id; the office knows the agent as `${id}:main`, its terminal as `pty_${id}`. */
  id: string;
  deskId: string;
  agentType: string;
  token: string;
  settingsFile: string | null;
  sessionId: string | null;
  hook: HookState;
  /** First prompt from the hire dialog, typed once the agent is ready (after any trust dialog). */
  pending: string | null;
  transcript: string | null;
  lookedAt: number;
}

const WORKTREES_TTL_MS = 5000;
const PASTE_SETTLE_MS = 400;
const SESSION_RESCAN_MS = 5000;

const agentKey = (id: string) => `${id}:main`;
/** Desk ids use forward slashes on every OS (git prints them that way on Windows too). */
const slash = (p: string) => p.replace(/\\/g, '/');
const ptyId = (handle: string) => handle.replace(/^pty_/, '');

/** Office Desks running the agents itself: PTYs, git worktrees and Claude hooks, no Orca. */
export class NativeBackend implements OfficeBackend {
  readonly name: string = 'native';
  readonly capabilities: BackendCapabilities = { usage: false, search: false, board: true, hire: true, changes: true, transcripts: true, focus: false, repos: true };
  readonly messages: BackendMessages = {
    noSession: '이 에이전트의 대화 기록이 아직 없어요. 첫 지시를 보내면 생깁니다.',
    hireDisabled: '이 백엔드에서는 새 작업을 만들 수 없어요',
  };

  private agents = new Map<string, Agent>();
  private worktrees = new Map<string, { at: number; list: WorktreeInfo[] }>();
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: NativeDeps) {
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    deps.pty.onExit((id) => {
      const a = this.agents.get(id);
      this.agents.delete(id);
      if (a?.settingsFile) void rm(a.settingsFile, { force: true });
    });
  }

  async snapshot(): Promise<OfficeSnapshot> {
    const rows: OrcaWorktreeRow[] = [];
    const terminals: OrcaTerminalRow[] = [];
    for (const repo of this.deps.registry.repos) {
      let list: WorktreeInfo[];
      try {
        list = await this.worktreesOf(repo.path);
      } catch {
        continue; // a repo that moved or was deleted just has no desks
      }
      for (const wt of list) {
        const deskId = `${repo.id}::${wt.path}`;
        const meta = this.deps.registry.meta(deskId);
        const agents = [...this.agents.values()].filter((a) => a.deskId === deskId);
        for (const a of agents) terminals.push({ handle: `pty_${a.id}`, tabId: a.id, leafId: 'main', title: a.agentType });
        const states = agents.map((a) => this.rawState(a));
        rows.push({
          worktreeId: deskId,
          repoId: repo.id,
          repo: repo.name,
          path: wt.path,
          branch: wt.branch,
          displayName: path.basename(wt.path),
          isMainWorktree: wt.isMain,
          workspaceStatus: meta.workspaceStatus ?? null,
          comment: meta.comment ?? '',
          status: states.includes('waiting') ? 'permission' : states.includes('working') ? 'working' : agents.length ? 'active' : 'inactive',
          agents: agents.map((a, i) => ({
            paneKey: agentKey(a.id),
            agentType: a.agentType,
            state: states[i],
            toolName: a.hook.toolName,
            toolInput: a.hook.toolInput,
            prompt: a.hook.prompt,
            lastAssistantMessage: a.hook.lastMessage,
            stateStartedAt: a.hook.since,
          })),
        });
      }
    }
    return toSnapshot(rows, terminals, this.now());
  }

  /**
   * Hooks are the main signal; the screen covers what hooks can't see. A dialog (trust prompt,
   * permission prompt, /usage) always means the user is needed. An agent without hooks (not
   * Claude, or hooks disabled by policy) counts as done while its input box shows.
   */
  private rawState(a: Agent): string {
    const screen = composerState(this.deps.pty.screenLines(a.id), a.agentType);
    if (screen === 'menu') return 'waiting';
    if (a.hook.rawState === 'unknown') return screen === 'ready' || a.agentType !== 'claude' ? 'done' : 'unknown';
    return a.hook.rawState;
  }

  private async worktreesOf(repoPath: string): Promise<WorktreeInfo[]> {
    const hit = this.worktrees.get(repoPath);
    if (hit && this.now() - hit.at < WORKTREES_TTL_MS) return hit.list;
    const list = (await listWorktrees(repoPath, this.git)).map((w) => ({ ...w, path: slash(w.path) }));
    this.worktrees.set(repoPath, { at: this.now(), list });
    return list;
  }

  async readScreen(handle: string): Promise<string[]> {
    return this.deps.pty.screenLines(ptyId(handle));
  }

  async sendPrompt(handle: string, text: string): Promise<void> {
    await this.paste(ptyId(handle), text);
  }

  /** Bracketed paste keeps a multi-line prompt one message; Enter after the TUI took it in. */
  private async paste(id: string, text: string): Promise<void> {
    this.deps.pty.write(id, `\x1b[200~${text}\x1b[201~`);
    await this.sleep(PASTE_SETTLE_MS);
    this.deps.pty.write(id, '\r');
  }

  retryPrompt(): Promise<void> {
    return Promise.reject(new BackendError('다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요', 'not_found'));
  }

  blockedHandle(): string | null {
    return null;
  }

  async sendKeys(handle: string, input: KeyInput): Promise<void> {
    this.deps.pty.write(ptyId(handle), 'enter' in input ? '\r' : input.bytes);
  }

  async focus(): Promise<void> {}

  async hire(spec: HireSpec): Promise<HireResult> {
    let deskId: string;
    let cwd: string;
    if (spec.kind === 'agent') {
      deskId = spec.deskId;
      cwd = spec.deskId.slice(spec.deskId.indexOf('::') + 2);
    } else {
      const repo = this.deps.registry.repos.find((r) => r.id === spec.repoId);
      if (!repo) throw new BackendError('알 수 없는 프로젝트입니다', 'unknown_repo');
      cwd = worktreeDest(this.deps.home, repo.name, spec.name);
      await mkdir(path.dirname(cwd), { recursive: true });
      await addWorktree(repo.path, cwd, spec.name, spec.baseBranch, this.git);
      this.worktrees.delete(repo.path);
      deskId = `${repo.id}::${slash(cwd)}`;
    }
    await this.spawnAgent(deskId, cwd, spec.agent, spec.prompt);
    return {};
  }

  private async spawnAgent(deskId: string, cwd: string, agentType: string, prompt: string | null): Promise<void> {
    const id = randomUUID();
    const token = randomBytes(16).toString('hex');
    let args: string[] = [];
    let settingsFile: string | null = null;
    let sessionId: string | null = null;
    if (agentType === 'claude') {
      sessionId = randomUUID();
      settingsFile = path.join(this.deps.home, 'agents', `${id}.json`);
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(settingsFile, JSON.stringify(hookSettings(this.deps.relay ?? relayScript(), this.deps.node)));
      args = ['--session-id', sessionId, '--settings', settingsFile];
    }
    const env = agentEnv(this.deps.env ?? process.env, { OFFICE_DESKS_HOOK_URL: this.deps.hookUrl(agentKey(id), token) });
    this.agents.set(id, {
      id,
      deskId,
      agentType,
      token,
      settingsFile,
      sessionId,
      hook: initialHookState(this.now()),
      // Without hooks there is no reliable "ready" signal, so only Claude gets a queued first prompt.
      pending: agentType === 'claude' ? prompt : null,
      transcript: null,
      lookedAt: 0,
    });
    this.deps.pty.spawn(id, { file: agentType, args, cwd, env });
  }

  hook(agentId: string, token: string, payload: unknown): boolean {
    const a = this.agents.get(agentId.replace(/:main$/, ''));
    if (!a || !payload || typeof payload !== 'object') return false;
    const want = Buffer.from(a.token);
    const got = Buffer.from(token);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    a.hook = applyHook(a.hook, payload as Record<string, unknown>, this.now());
    if (a.hook.transcriptPath) a.transcript = a.hook.transcriptPath;
    if (a.pending && a.hook.started) {
      const prompt = a.pending;
      a.pending = null;
      void this.paste(a.id, prompt).catch(() => undefined);
    }
    return true;
  }

  async setBoard(deskId: string, update: { workspaceStatus?: string; comment?: string }): Promise<void> {
    await this.deps.registry.setMeta(deskId, update);
  }

  async findSession(_desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
    return this.cachedSession(agent.id);
  }

  /** The hook names the file; until then look for `<session-id>.jsonl` (cheap, rate-limited). */
  cachedSession(agentId: string): string | null {
    const a = this.agents.get(agentId.replace(/:main$/, ''));
    if (!a?.sessionId) return null;
    if (a.transcript && existsSync(a.transcript)) return a.transcript;
    if (this.now() - a.lookedAt < SESSION_RESCAN_MS && a.lookedAt) return null;
    a.lookedAt = this.now();
    const root = this.deps.claudeProjects ?? path.join(os.homedir(), '.claude', 'projects');
    try {
      for (const dir of readdirSync(root)) {
        const file = path.join(root, dir, `${a.sessionId}.jsonl`);
        if (existsSync(file)) return (a.transcript = file);
      }
    } catch {
      /* no projects folder yet */
    }
    return null;
  }

  async searchConversations(): Promise<ConversationHit[]> {
    return [];
  }

  async usage(): Promise<UsageSnapshot | null> {
    return null;
  }

  async addRepo(repoPath: string): Promise<void> {
    if (!path.isAbsolute(repoPath)) throw new BackendError('절대 경로를 입력해 주세요', 'not_absolute');
    await this.deps.registry.addRepo(await resolveRepo(repoPath, this.git));
  }

  async dispose(): Promise<void> {
    await this.deps.pty.dispose();
    await Promise.all([...this.agents.values()].map((a) => (a.settingsFile ? rm(a.settingsFile, { force: true }) : undefined)));
  }
}
```

There is a subtle point in "finds the transcript …". The test calls `findSession` twice within 5 s, and the second call must still find the file it just created. Make the rate limit skip only when the previous scan happened **and** less than `SESSION_RESCAN_MS` has passed *and* the call isn't a direct `findSession`. The simplest way to do that is to have `findSession` reset `lookedAt` to 0 before delegating to `cachedSession`. Implement exactly that:

```ts
async findSession(_desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
  const a = this.agents.get(agent.id.replace(/:main$/, ''));
  if (a) a.lookedAt = 0; // an explicit request may always look again
  return this.cachedSession(agent.id);
}
```

`toSnapshot` sorts desks by id. That is why the tests index the `/p/app` desk as `desks[1]` and the `/h/worktrees/…` desk as `desks[0]`. If an assertion is off because of ordering, fix the test's lookup to `find((d) => d.id === …)` rather than changing the sort.

- [ ] **Step 4: Run the tests.**

Run: `npm test -w bridge -- nativeBackend`
Expected: PASS (12 tests).

- [ ] **Step 5: Run the full suite and the typecheck, then commit.**

```bash
npm test -w bridge && npm run typecheck -w bridge
git add bridge/src/backend/native.ts bridge/test/nativeBackend.test.ts
git commit -m "NativeBackend: agents in our own PTYs with Claude hooks, git worktrees and a local board"
```

---

### Task 7: Wiring — backend selection, hook and repo endpoints, shutdown, CLI, docs

**Files:**
- Modify: `bridge/src/backend/index.ts`, `bridge/src/server.ts`, `bin/office-desks.mjs`, `README.md`
- Test: `bridge/test/demoBackend.test.ts` (the `createBackend` block moves into the new file), `bridge/test/createBackend.test.ts`

**Interfaces:**
- Produces:
  - `createBackend(env, verify?, opts: { port: number; probeOrca?: () => Promise<boolean> }): Promise<OfficeBackend>`
  - `probeOrca(run?: OrcaRunner): Promise<boolean>`
  - `createNativeBackend(env, port): Promise<NativeBackend>`

- [ ] **Step 1: Write the failing tests.** Delete the `describe('createBackend', …)` block from `bridge/test/demoBackend.test.ts`, and remove its now-unused import. Create `bridge/test/createBackend.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBackend, probeOrca } from '../src/backend/index.js';

const home = () => mkdtempSync(path.join(os.tmpdir(), 'od-cb-'));

describe('createBackend', () => {
  it('honors OFFICE_DESKS_BACKEND and OFFICE_DESKS_DEMO without probing', async () => {
    const never = async () => {
      throw new Error('should not probe');
    };
    expect((await createBackend({ OFFICE_DESKS_BACKEND: 'orca' }, undefined, { port: 1, probeOrca: never })).name).toBe('orca');
    expect((await createBackend({ OFFICE_DESKS_DEMO: '1' }, undefined, { port: 1, probeOrca: never })).name).toBe('demo');
    const native = await createBackend({ OFFICE_DESKS_BACKEND: 'native', OFFICE_DESKS_HOME: home() }, undefined, { port: 1, probeOrca: never });
    expect(native.name).toBe('native');
    await native.dispose();
    await expect(createBackend({ OFFICE_DESKS_BACKEND: 'tmux' }, undefined, { port: 1, probeOrca: never })).rejects.toThrow(/OFFICE_DESKS_BACKEND/);
  });

  it('uses Orca when it answers, otherwise runs natively', async () => {
    expect((await createBackend({}, undefined, { port: 1, probeOrca: async () => true })).name).toBe('orca');
    const native = await createBackend({ OFFICE_DESKS_HOME: home() }, undefined, { port: 1, probeOrca: async () => false });
    expect(native.name).toBe('native');
    await native.dispose();
  });
});

describe('probeOrca', () => {
  it('is true only when the Orca runtime is reachable', async () => {
    expect(await probeOrca(async () => ({ app: { running: true }, runtime: { reachable: true } }))).toBe(true);
    expect(await probeOrca(async () => ({ app: { running: true }, runtime: { reachable: false } }))).toBe(false);
    expect(
      await probeOrca(async () => {
        throw new Error('not found');
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npm test -w bridge -- createBackend`
Expected: FAIL with `probeOrca is not exported` / `createBackend(...).then is not a function` (or similar).

- [ ] **Step 3: Implement `bridge/src/backend/index.ts`.**

```ts
import path from 'node:path';
import { officeHome } from '../home.js';
import { PtyHost } from '../native/ptyHost.js';
import { Registry } from '../native/registry.js';
import { createOrcaRunner, type OrcaRunner } from '../orcaCli.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { DemoBackend } from './demo.js';
import { NativeBackend } from './native.js';
import { OrcaBackend } from './orca.js';
import type { OfficeBackend } from './types.js';

/** Is an Orca app running whose CLI answers? Then the office sits on top of it. */
export async function probeOrca(run: OrcaRunner = createOrcaRunner(undefined, 3000)): Promise<boolean> {
  try {
    const r = (await run(['status'])) as { runtime?: { reachable?: boolean } };
    return r?.runtime?.reachable === true;
  } catch {
    return false;
  }
}

export async function createNativeBackend(env: NodeJS.ProcessEnv, port: number): Promise<NativeBackend> {
  const home = officeHome(env);
  const registry = new Registry(path.join(home, 'state.json'));
  await registry.load();
  return new NativeBackend({
    pty: new PtyHost(),
    registry,
    home,
    env,
    hookUrl: (agentId, token) => `http://127.0.0.1:${port}/hook/${encodeURIComponent(agentId)}?token=${token}`,
  });
}

/**
 * OFFICE_DESKS_BACKEND (orca | native | demo) wins; OFFICE_DESKS_DEMO (`--demo`) means demo;
 * otherwise Orca when it is running, else our own native backend.
 */
export async function createBackend(
  env: NodeJS.ProcessEnv,
  verify: SessionVerifier | undefined,
  opts: { port: number; probeOrca?: () => Promise<boolean> },
): Promise<OfficeBackend> {
  const kind = env.OFFICE_DESKS_BACKEND?.trim() || (env.OFFICE_DESKS_DEMO ? 'demo' : (await (opts.probeOrca ?? probeOrca)()) ? 'orca' : 'native');
  if (kind === 'demo') return new DemoBackend(verify);
  if (kind === 'orca') return new OrcaBackend(createOrcaRunner(), verify);
  if (kind === 'native') return createNativeBackend(env, opts.port);
  throw new Error(`Unknown OFFICE_DESKS_BACKEND "${kind}" (use orca, native or demo)`);
}
```

`new PtyHost()` calls `ensureSpawnHelper()`, which on macOS chmods the real `node_modules/node-pty` helper. That is the intended behavior.

- [ ] **Step 4: Wire up `server.ts`.**
  - **Construction.** Change it to `const backend: OfficeBackend = await createBackend(process.env, <verifier unchanged>, { port: PORT });`. ESM top-level await works under tsx and `module: NodeNext`. `PORT` is declared above this line; move the construction below `PORT` if needed.
  - **Hook endpoint.** In `createServer`, right after the `isAllowedRequest` check and before the `/api/` branch, add:

```ts
    if (req.method === 'POST' && url.pathname.startsWith('/hook/')) {
      // Agent hooks from our own spawned agents (bridge/hook-relay.mjs); the per-agent token is the key.
      readJson<unknown>(req, 2 * 1024 * 1024)
        .then((payload) => {
          const ok = backend.hook(decodeURIComponent(url.pathname.slice('/hook/'.length)), url.searchParams.get('token') ?? '', payload);
          if (ok) void poller.refresh();
          res.writeHead(ok ? 204 : 404).end();
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(400).end();
        });
      return;
    }
```

  - **Repo endpoint.** In `handleApi`, after the `/api/focus` handler, add:

```ts
  if (pathname === '/api/repos') {
    const body = await readJson<{ path?: string }>(req);
    if (!backend.capabilities.repos) return json(res, 400, { error: '이 백엔드에서는 여기서 프로젝트를 추가할 수 없어요' });
    if (typeof body.path !== 'string' || !body.path.trim() || body.path.length > 1000) return json(res, 400, { error: '저장소 경로를 입력해 주세요' });
    try {
      await backend.addRepo(body.path.trim());
    } catch (err) {
      if (err instanceof BackendError) return json(res, 400, { error: err.message, code: err.code });
      throw err;
    }
    void poller.refresh();
    return json(res, 200, { ok: true });
  }
```

    `BackendError` must be a value import here. Change the backend/types import to `import { BackendBusyError, BackendError, type OfficeBackend } from './backend/types.js';`.
  - **`/api/hire`.** `NativeBackend.hire` can throw `BackendError` with code `unknown_repo`, or a git error (a branch that already exists, for example). Wrap `await backend.hire(spec)` so that a thrown `Error` returns `json(res, 400, { error: err.message })`. The current behavior falls through to 502 with the raw message; 400 with the message reads better in the dialog, and Orca's errors keep the same text.
  - **Shutdown.** At the end of the file, add:

```ts
// Native agents live in this process: stop them with it.
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    void backend.dispose().finally(() => process.exit(0));
  });
}
```

- [ ] **Step 5: Update `bin/office-desks.mjs`.**
  - Accept `--backend <orca|native|demo>`, which sets `process.env.OFFICE_DESKS_BACKEND`. Validate it the same way `--port` is validated, with an error message that lists the three values.
  - Update the help text:

```
Usage: npx office-desks [--port <n>] [--backend orca|native|demo] [--demo]

  --port <n>        port to listen on (default 4317, or OFFICE_DESKS_PORT)
  --backend <kind>  orca: on top of a running Orca app
                    native: run agents in Office Desks itself (no Orca needed)
                    demo: fake office
                    default: orca if Orca is running, otherwise native
  --demo            same as --backend demo
```

  - Change the help's first line to `office-desks — a pixel-art office for your coding agents`.
  - Remove the sentence saying that Orca must be running.

- [ ] **Step 6: Update `README.md`.** Add a section after "설치와 실행", in Korean and in the README's tone:

```markdown
## Orca 없이 쓰기 (native)

Orca가 실행 중이 아니면 Office Desks가 직접 에이전트를 띄웁니다 (`--backend native`로 강제할 수도 있어요).

1. `npm start` (또는 `npx office-desks`) → 브라우저에서 **➕ 새 작업 → 프로젝트 추가**에 git 저장소 경로를 넣습니다.
2. 새 작업을 만들면 `~/.office-desks/worktrees/<프로젝트>/<이름>`에 워크트리가 생기고 그 안에서 에이전트가 뜹니다.
3. 처음 여는 폴더면 Claude가 "이 폴더를 신뢰하나요?"를 물어요. 캐릭터를 눌러 **터미널** 탭에서 `Yes, I trust this folder`를 고르면, 적어 둔 첫 지시가 그때 전달됩니다.

- 에이전트는 Office Desks 프로세스 안에서 돕니다. 서버를 끄면 에이전트도 함께 종료됩니다.
- 상태는 Claude Code 훅으로 받습니다(사용자 설정은 건드리지 않고 `--settings`로만 추가). Codex 등 다른 에이전트는 상태 표시가 단순합니다.
- 사용량 바와 대화 검색은 아직 Orca 백엔드에서만 보입니다.
- 개발 중 `npm run dev`는 bridge 코드를 고칠 때마다 서버를 재시작하므로, native 에이전트도 그때마다 종료됩니다.
```

  Also, in the requirements table, change the Orca row's first cell to `Orca (선택)`. Change its text to say that it is needed only for the Orca backend, and that without Orca the native backend is used.

- [ ] **Step 7: Verify.**

Run: `npm run typecheck && npm test && npm run build`
Expected: everything passes.

- [ ] **Step 8: Commit.**

```bash
git add bridge/src/backend/index.ts bridge/src/server.ts bridge/test/createBackend.test.ts bridge/test/demoBackend.test.ts bin/office-desks.mjs README.md
git commit -m "Native backend wiring: auto-select, hook and repo endpoints, shutdown, --backend"
```

---

### Task 8: End-to-end verification (macOS)

**Files:** none, unless a regression is found. In that case, report it precisely and do **not** fix it in this task.

**Process rules (hard):**
- Use port **4419**.
- Use `OFFICE_DESKS_HOME` pointing at a fresh temp dir under the scratchpad.
- Use a scratch git repo under the scratchpad only.
- Record the PID of every process you start, and stop only those PIDs.
- Never use `pkill`, `killall` or pattern kills.
- When you are done, check that no `claude` process whose parent is your server PID is left: `ps -o pid,ppid,command -A | grep claude`, then check the ppid.

- [ ] **Step 1: Check the packaging.**

Run: `npm pack --dry-run 2>&1 | grep -E "hook-relay.mjs|bridge/dist/backend/native.js|bridge/dist/native/ptyHost.js"`
Expected: all three paths are listed.

- [ ] **Step 2: Start native from an empty home.**

Run in the background, from the repo root:

```bash
OFFICE_DESKS_PORT=4419 OFFICE_DESKS_BACKEND=native OFFICE_DESKS_HOME=<scratch>/odhome npm start
```

- Record the PID. Wait for `[office-desks] bridge on http://127.0.0.1:4419 (native backend)`.
- `GET /api/snapshot` returns `{desks: []}`.
- The WS first message is `{type:'backend', backend:{name:'native', capabilities:{…repos:true…}}}`. Check with a small `node -e` WebSocket client using the `ws` package from `node_modules`.
- Take a screenshot showing the empty-office hint ("프로젝트가 없어요 — …").

- [ ] **Step 3: Register a project.**
  - Create `<scratch>/demo-app` (`git init -b main`, one commit).
  - `POST /api/repos {"path":"<scratch>/demo-app"}` returns 200. Use the headers `content-type: application/json` and `host: 127.0.0.1:4419`.
  - `POST /api/repos {"path":"<scratch>"}` returns 400 with `git 저장소가 아니에요`.
  - Within about 2 s, the snapshot lists the `demo-app` desk.

- [ ] **Step 4: Hire into a new worktree with a first prompt.**
  - `POST /api/hire {"repoId":"<id>","name":"e2e-task","agent":"claude","prompt":"Reply with just the word OK."}` returns 200.
  - The worktree exists at `<scratch>/odhome/worktrees/demo-app/e2e-task`.
  - The agent shows `state: "waiting"`, and `/api/terminal?agentId=…` shows the trust dialog.
  - Answer it with `/api/keys`: `{"key":"down"}`, then `{"key":"enter"}`, to choose "Yes, I trust this folder".
  - Within about 20 s, the agent goes `typing` (or `done`).
  - `/api/conversation?agentId=…` returns `found: true` with the prompt and an assistant reply "OK".
  - The agent ends up `done`.

- [ ] **Step 5: Exercise input and the board.**
  - `POST /api/send` with the text `Reply with just the word TWO.` and the agent's handle. A second reply appears in the conversation.
  - `POST /api/worktree` with a status and a comment, then an empty comment. The snapshot reflects each change.
  - Take a screenshot of the office with the agent at its desk, and one of the panel.

- [ ] **Step 6: Shut down.**
  - Send SIGTERM to **your recorded server PID** only.
  - The server exits within about 3 s.
  - No `claude` child of it remains.
  - `<scratch>/odhome/agents/` is empty.

- [ ] **Step 7: Run the Orca regression smoke test, read-only.** Orca is running on this machine.
  - Start with `OFFICE_DESKS_PORT=4420 npm start`, with no backend env. The log must say `orca backend`, so auto-selection works.
  - The snapshot lists the real desks, and the WS `backend` message has `name: 'orca'`.
  - Send **nothing** to real agents.
  - Stop **your recorded PID**.

- [ ] **Step 8: Report.** Write the report with each step's command, the observed result, PASS/FAIL, and the screenshot paths.

---

## Self-Review Notes (for the executor)

- Windows has not been exercised end to end. The CI matrix covers the unit tests, including the ConPTY echo test in `ptyHost.test.ts`. The user will smoke-test `--backend native` on Windows at work. Known risk areas are the `cmd.exe` shim spawn and hook commands under Git Bash. Both have unit coverage of the argument building, not of a real Claude.
- Deferred to M3/M4 by the spec: the TUI, usage, conversation search, Codex hooks, session resume, and focus.
