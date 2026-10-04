# M1: Typed OfficeBackend Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every raw `orca [...]` argument list in the bridge with calls on one typed `OfficeBackend` interface, implemented by `OrcaBackend` (real Orca) and `DemoBackend` (`npm run demo`), with no user-visible behavior change.

**Architecture:** `bridge/src/backend/types.ts` defines the interface and backend-neutral errors. `OrcaBackend` (`bridge/src/backend/orca.ts`) owns everything Orca-specific that is currently spread across `server.ts`, `poller.ts`, `usage.ts` and `hire.ts`:
- argument building
- terminal-list caching
- the `agent_prompt_blocked` retry map
- the "single space clears a comment" hack
- session lookup through `orca search`

`DemoBackend` extends `OrcaBackend` over the existing fake runner and moves the `DEMO` branches out of `server.ts` into backend capabilities. The poller takes a plain snapshot source. `server.ts` only talks to `backend.*`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node 22, vitest, tsx. All commands run from the repo root.

**Spec:** `docs/superpowers/specs/2026-10-04-native-backend-tui-design.md` (section "M1")

## Global Constraints

- **No behavior change.** Every HTTP endpoint keeps its status codes, JSON shapes and Korean messages. The one exception is `/api/send` and `/api/send/retry`, which now answer `{ ok: true }` without the unused `result` field (the web never reads it).
- **Cross-platform.** The code must run on macOS and Windows: npm scripts only, no shell-joined arguments. CI runs `typecheck`, `test` and `build` on `macos-latest` and `windows-latest`.
- **Imports.** Use the ESM `.js` suffix (`import ... from './types.js'`). Match the surrounding style: 2-space indent, single quotes, short "why" comments only.
- **Demo selection.**
  - `OFFICE_DESKS_DEMO=1` still selects demo mode; `bin/office-desks.mjs` and `npm run demo` stay untouched.
  - New: `OFFICE_DESKS_BACKEND=orca|demo` overrides it.
  - Any other value fails at startup with a clear message.
- **File layout.** `orcaCli.ts`, `stateMapper.ts`, `sessionResolver.ts` and `usage.ts#toUsage` stay where they are, as the Orca adapter's helpers. Their existing tests stay unchanged.
- **Web.** No changes to `web/` in M1. Capabilities are only used server-side; showing them to the web is M2.

## Review Focus

1. **Retrying a refused prompt.**
   - After a 409 `agent_busy`, `/api/send/retry` with that `requestId` must re-send the *original* prompt with `--retry-request=<id> --wait-submit=10`.
   - If Orca refuses again with a new id, retrying that new id must still re-send the original prompt.
   - Pinned in Task 2, test "chains a re-blocked retry to the original prompt".
2. **Clearing a board comment.** Saving an empty comment must send `--comment= ` (a single space), not `--comment=`. Otherwise Orca rejects or ignores it and the old comment stays. Pinned in Task 2, `setBoard` test.
3. **Hiring into an existing worktree with a first prompt.**
   - The prompt must be typed only after `terminal wait` reports `satisfied`.
   - If it doesn't, the user gets the warning instead of a lost prompt.
   - Pinned in Task 2, the two `hire` tests.
4. **Demo mode keeps its office alive.**
   - The demo office must still show rotating states, model and effort badges, fake change counts, usage bars, and the chat panel.
   - Hire, search, changes and board must stay disabled.
   - Pinned in Task 5, `DemoBackend` tests, plus the manual check in Task 6.
5. **Orca down at startup.** When `worktree ps` throws, the poller must keep the last desks and surface the error string, exactly as today. Pinned in Task 3, poller test "keeps last desks on error".

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `bridge/src/backend/types.ts` | create | `OfficeBackend`, `BackendCapabilities`, `HireSpec`, `HireResult`, `ConversationHit`, `KeyInput`, `BackendError`, `BackendBusyError` |
| `bridge/src/backend/orca.ts` | create | `orcaHireArgs()`, `OrcaBackend` |
| `bridge/src/backend/demo.ts` | create | `DemoBackend` (extends `OrcaBackend` over `createDemoRunner()`) |
| `bridge/src/backend/index.ts` | create | `createBackend(env, verify)` |
| `bridge/src/hire.ts` | modify | `planHire` → `validateHire` (validation only, returns `HireSpec`) |
| `bridge/src/orcaCli.ts` | modify | `OrcaCliError extends BackendError` |
| `bridge/src/poller.ts` | modify | takes `source: () => Promise<OfficeSnapshot>`; terminal cache removed |
| `bridge/src/usage.ts` | modify | `fetchUsage` removed (lives in `OrcaBackend.usage`) |
| `bridge/src/server.ts` | modify | all Orca calls → `backend.*`; `DEMO` branches → capabilities |
| `bridge/test/orcaBackend.test.ts` | create | OrcaBackend against a recording fake runner |
| `bridge/test/demoBackend.test.ts` | create | DemoBackend capabilities and enrichment; `createBackend` selection |
| `bridge/test/hire.test.ts` | modify | `validateHire` + `orcaHireArgs` |
| `bridge/test/poller.test.ts` | modify | source-function poller; terminal-cache test moves to orcaBackend test |

---

### Task 1: Backend types and backend-neutral hire validation

**Files:**
- Create: `bridge/src/backend/types.ts`
- Create: `bridge/src/backend/orca.ts` (only `orcaHireArgs` for now)
- Modify: `bridge/src/hire.ts`
- Modify: `bridge/src/orcaCli.ts:21-28`
- Modify: `bridge/src/server.ts` (the `/api/hire` handler, ~line 428-447)
- Test: `bridge/test/hire.test.ts`

**Interfaces:**
- Produces:
  - Every type in `backend/types.ts`, exactly as written below.
  - `validateHire(body: HireRequest, desks: OfficeDesk[]): HireSpec | { error: string }` and `KNOWN_AGENTS` from `hire.ts`.
  - `orcaHireArgs(spec: HireSpec): string[]` from `backend/orca.ts`.

- [ ] **Step 1: Write the failing test.** Replace the contents of `bridge/test/hire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { orcaHireArgs } from '../src/backend/orca.js';
import { validateHire } from '../src/hire.js';
import type { OfficeDesk } from '../src/model.js';

const desks = [{ id: 'r1::/p/main', repoId: 'r1', name: 'main' }, { id: 'r1::/p/feat', repoId: 'r1', name: 'feat' }] as OfficeDesk[];

describe('validateHire', () => {
  it('accepts a new worktree and trims the prompt', () => {
    expect(validateHire({ repoId: 'r1', name: 'fix-login', agent: 'claude', prompt: ' --help me ', baseBranch: 'origin/main' }, desks)).toEqual({
      kind: 'worktree',
      repoId: 'r1',
      name: 'fix-login',
      agent: 'claude',
      baseBranch: 'origin/main',
      prompt: '--help me',
    });
  });

  it('accepts another agent in an existing worktree', () => {
    expect(validateHire({ deskId: 'r1::/p/feat', agent: 'codex', prompt: 'go' }, desks)).toEqual({
      kind: 'agent',
      deskId: 'r1::/p/feat',
      agent: 'codex',
      prompt: 'go',
    });
    expect(validateHire({ deskId: 'r1::/p/feat', agent: 'codex' }, desks)).toMatchObject({ prompt: null });
  });

  it('rejects unknown repos/worktrees/agents and unsafe names', () => {
    const bad = [
      { repoId: 'nope', name: 'x', agent: 'claude' },
      { repoId: 'r1', name: '--fresh', agent: 'claude' },
      { repoId: 'r1', name: 'a b', agent: 'claude' },
      { repoId: 'r1', name: 'feat', agent: 'claude' },
      { repoId: 'r1', name: 'ok', agent: 'bash -c x' },
      { repoId: 'r1', name: 'ok', agent: 'claude', baseBranch: '-x' },
      { deskId: 'r1::/elsewhere', agent: 'claude' },
    ];
    for (const b of bad) expect('error' in validateHire(b, desks)).toBe(true);
  });
});

describe('orcaHireArgs', () => {
  it('builds a new-worktree command with --flag=value only', () => {
    expect(orcaHireArgs({ kind: 'worktree', repoId: 'r1', name: 'fix-login', agent: 'claude', baseBranch: 'origin/main', prompt: '--help me' })).toEqual([
      'worktree', 'create', '--repo=id:r1', '--name=fix-login', '--no-parent', '--agent=claude', '--base-branch=origin/main', '--prompt=--help me',
    ]);
    expect(orcaHireArgs({ kind: 'worktree', repoId: 'r1', name: 'x', agent: 'claude', baseBranch: null, prompt: null })).toEqual([
      'worktree', 'create', '--repo=id:r1', '--name=x', '--no-parent', '--agent=claude',
    ]);
  });

  it('opens a terminal running the agent in an existing worktree (prompt is sent later)', () => {
    expect(orcaHireArgs({ kind: 'agent', deskId: 'r1::/p/feat', agent: 'codex', prompt: 'go' })).toEqual([
      'terminal', 'create', '--worktree=id:r1::/p/feat', '--command=codex', '--title=codex',
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npm test -w bridge -- hire`
Expected: FAIL with `Failed to resolve import "../src/backend/orca.js"`.

- [ ] **Step 3: Create `bridge/src/backend/types.ts`.**

```ts
import type { OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot } from '../model.js';

// What the bridge needs from whatever runs the agents (Orca today, our own PTY host later).
// server.ts and the poller only ever talk to this interface.

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: string = 'backend_error',
  ) {
    super(message);
  }
}

/** The agent can't take a prompt right now; the same prompt may be retried with this id. */
export class BackendBusyError extends BackendError {
  constructor(readonly requestId: string) {
    super('agent can not take a prompt right now', 'agent_busy');
  }
}

export interface BackendCapabilities {
  /** Plan usage limits (5-hour / weekly). */
  usage: boolean;
  /** Full-text search over conversations. */
  search: boolean;
  /** Edit a worktree's board status and comment. */
  board: boolean;
  /** Create worktrees and start agents. */
  hire: boolean;
  /** git change counts and diffs for desks. */
  changes: boolean;
  /** The bridge reads transcripts for model/effort/stats; false when the backend fills them itself. */
  transcripts: boolean;
}

/** A validated request to start work (see hire.ts). */
export type HireSpec =
  | { kind: 'agent'; deskId: string; agent: string; prompt: string | null }
  | { kind: 'worktree'; repoId: string; name: string; agent: string; baseBranch: string | null; prompt: string | null };

export interface HireResult {
  /** Set when the agent started but its first prompt could not be delivered. */
  warning?: string;
}

export interface ConversationHit {
  agent: string;
  title: string;
  cwd: string;
  updatedAt: string | null;
  /** Matched text with [[highlights]]. */
  snippet: string;
  role: string | null;
  filePath: string | null;
  resumeCommand: string | null;
}

/** Raw bytes to type, or the terminal's own Enter. */
export type KeyInput = { bytes: string } | { enter: true };

export interface OfficeBackend {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
  /** Desks and agents as the backend knows them, before git/transcript enrichment. */
  snapshot(): Promise<OfficeSnapshot>;
  /** The rendered screen, one string per row. */
  readScreen(handle: string): Promise<string[]>;
  /** Type a prompt and submit it. Throws BackendBusyError when the agent can't take it now. */
  sendPrompt(handle: string, text: string): Promise<void>;
  /** Re-send a prompt refused with BackendBusyError. Throws BackendBusyError again if still busy. */
  retryPrompt(requestId: string): Promise<void>;
  /** Terminal of a refused prompt that can still be retried, or null. */
  blockedHandle(requestId: string): string | null;
  sendKeys(handle: string, input: KeyInput): Promise<void>;
  /** Bring a terminal to the front of the host app. */
  focus(handle: string): Promise<void>;
  hire(spec: HireSpec): Promise<HireResult>;
  /** An empty comment clears it. */
  setBoard(deskId: string, update: { workspaceStatus?: string; comment?: string }): Promise<void>;
  /** Transcript file of the agent's current session, or null. May search. */
  findSession(desk: OfficeDesk, agent: OfficeAgent): Promise<string | null>;
  /** Last known transcript file for an agent, without searching. */
  cachedSession(agentId: string): string | null;
  searchConversations(query: string): Promise<ConversationHit[]>;
  usage(): Promise<UsageSnapshot | null>;
}
```

- [ ] **Step 4: Create `bridge/src/backend/orca.ts` with the argument builder only.**

```ts
import type { HireSpec } from './types.js';

/** Orca argv for a validated hire. Values only ever go in as --flag=value. */
export function orcaHireArgs(spec: HireSpec): string[] {
  if (spec.kind === 'agent') {
    return ['terminal', 'create', `--worktree=id:${spec.deskId}`, `--command=${spec.agent}`, `--title=${spec.agent}`];
  }
  const args = ['worktree', 'create', `--repo=id:${spec.repoId}`, `--name=${spec.name}`, '--no-parent', `--agent=${spec.agent}`];
  if (spec.baseBranch) args.push(`--base-branch=${spec.baseBranch}`);
  if (spec.prompt) args.push(`--prompt=${spec.prompt}`);
  return args;
}
```

- [ ] **Step 5: Replace `planHire` in `bridge/src/hire.ts` with `validateHire`.** Keep `KNOWN_AGENTS`, `NAME`, `BRANCH` and `MAX_PROMPT` exactly as they are. Replace the header comment, `HirePlan` and `planHire` with:

```ts
import type { HireSpec } from './backend/types.js';
import type { HireRequest, OfficeDesk } from './model.js';

// Validation for starting work from the UI. Names/branches can't start with '-', and only
// repos/worktrees the backend already reports qualify. The backend turns the spec into commands.

export const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'omp', 'grok', 'cursor'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const MAX_PROMPT = 8000;

export function validateHire(body: HireRequest, desks: OfficeDesk[]): HireSpec | { error: string } {
  if (!KNOWN_AGENTS.includes(body.agent)) return { error: '지원하지 않는 에이전트입니다' };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > MAX_PROMPT) return { error: '첫 지시가 너무 깁니다' };

  if (body.deskId !== undefined) {
    const desk = desks.find((d) => d.id === body.deskId);
    if (!desk) return { error: '알 수 없는 워크트리입니다' };
    return { kind: 'agent', deskId: desk.id, agent: body.agent, prompt: prompt || null };
  }

  const repo = desks.find((d) => d.repoId === body.repoId);
  if (!repo) return { error: '알 수 없는 프로젝트입니다' };
  if (!NAME.test(body.name ?? '')) return { error: '이름은 영문·숫자로 시작하고 영문·숫자·. _ - 만 쓸 수 있어요 (60자 이내)' };
  if (desks.some((d) => d.repoId === body.repoId && d.name === body.name)) return { error: '같은 이름의 워크트리가 이미 있어요' };
  if (body.baseBranch && !BRANCH.test(body.baseBranch)) return { error: '기준 브랜치 이름이 올바르지 않아요' };
  return { kind: 'worktree', repoId: repo.repoId, name: body.name!, agent: body.agent, baseBranch: body.baseBranch || null, prompt: prompt || null };
}
```

- [ ] **Step 6: Make `OrcaCliError` a `BackendError`** in `bridge/src/orcaCli.ts`. Add the import at the top:

```ts
import { BackendError } from './backend/types.js';
```

Then replace the class (lines 21-28) with:

```ts
export class OrcaCliError extends BackendError {
  constructor(message: string, code: string = 'orca_cli_error') {
    super(message, code);
  }
}
```

- [ ] **Step 7: Keep `server.ts` compiling.**
  - Change the import `import { planHire } from './hire.js';` to `import { validateHire } from './hire.js';`.
  - Add `import { orcaHireArgs } from './backend/orca.js';`.
  - In the `/api/hire` handler, replace everything from `const plan = planHire(...)` through the `if (plan.promptAfter) { ... }` block with the code below. It is the same logic, now driven by the spec. Task 4 moves it into the backend.

```ts
    const spec = validateHire(body, poller.current.desks);
    if ('error' in spec) return json(res, 400, { error: spec.error });
    const result = (await orca(orcaHireArgs(spec))) as { terminal?: { handle?: string }; handle?: string };
    if (spec.kind === 'agent' && spec.prompt) {
      // The agent's TUI needs a moment; Orca can wait for it to be idle before we type.
      const handle = result?.terminal?.handle ?? result?.handle;
      if (handle) {
        const wait = (await orca(['terminal', 'wait', `--terminal=${handle}`, '--for=tui-idle', '--timeout-ms=60000'])) as {
          wait?: { satisfied?: boolean };
        };
        if (wait?.wait?.satisfied) await orca(['terminal', 'send', `--terminal=${handle}`, `--text=${spec.prompt}`, '--enter']);
        else return json(res, 200, { ok: true, warning: '에이전트는 띄웠지만 준비가 늦어 첫 지시는 보내지 못했어요. 패널에서 보내 주세요' });
      }
    }
```

- [ ] **Step 8: Run the tests and the typecheck.**

Run: `npm test -w bridge && npm run typecheck -w bridge`
Expected: all tests PASS (including the 5 hire tests); `tsc` prints nothing.

- [ ] **Step 9: Commit.**

```bash
git add bridge/src/backend bridge/src/hire.ts bridge/src/orcaCli.ts bridge/src/server.ts bridge/test/hire.test.ts
git commit -m "Backend seam: OfficeBackend types, backend-neutral hire validation"
```

---

### Task 2: OrcaBackend

**Files:**
- Modify: `bridge/src/backend/orca.ts`
- Test: `bridge/test/orcaBackend.test.ts`

**Interfaces:**
- Consumes:
  - `OfficeBackend` and the related types, `BackendBusyError`, `BackendError` (Task 1).
  - `OrcaRunner` and `OrcaCliError` from `orcaCli.ts`.
  - `toSnapshot`, `OrcaWorktreeRow`, `OrcaTerminalRow` from `stateMapper.ts`.
  - `SessionResolver` and `SessionVerifier` from `sessionResolver.ts`.
  - `toUsage` from `usage.ts`.
- Produces: `class OrcaBackend implements OfficeBackend` with constructor `(orca: OrcaRunner, verify?: SessionVerifier, now?: () => number)`. Its `name` is `'orca'` and every capability is `true`.

- [ ] **Step 1: Write the failing tests.** Create `bridge/test/orcaBackend.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { OrcaBackend } from '../src/backend/orca.js';
import { BackendBusyError } from '../src/backend/types.js';
import type { OfficeAgent, OfficeDesk } from '../src/model.js';
import { OrcaCliError, type OrcaRunner } from '../src/orcaCli.js';

/** Records every argv; answers via the handler. */
function fake(handler: (args: string[]) => unknown = () => ({})): { orca: OrcaRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    orca: async (args) => {
      calls.push(args);
      const r = handler(args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('OrcaBackend.snapshot', () => {
  it('maps worktree ps and lists terminals only when stale or when an unknown pane appears', async () => {
    let now = 0;
    let panes = ['t1:l1'];
    const { orca, calls } = fake((args) =>
      args[0] === 'worktree'
        ? { worktrees: [{ worktreeId: 'r::/a', agents: panes.map((p) => ({ paneKey: p, state: 'working' })) }] }
        : { terminals: panes.map((p) => ({ handle: `h-${p}`, tabId: p.split(':')[0], leafId: p.split(':')[1] })) },
    );
    const backend = new OrcaBackend(orca, undefined, () => now);
    const lists = () => calls.filter((c) => c.join(' ') === 'terminal list').length;

    await backend.snapshot();
    now = 1500;
    await backend.snapshot();
    now = 3000;
    await backend.snapshot();
    expect(lists()).toBe(1);

    panes = ['t1:l1', 't2:l2']; // a new agent appears
    now = 4500;
    const s = await backend.snapshot();
    expect(lists()).toBe(2);
    expect(s.desks[0].agents[1].terminalHandle).toBe('h-t2:l2');

    now = 4500 + 16_000; // stale
    await backend.snapshot();
    expect(lists()).toBe(3);
  });
});

describe('OrcaBackend input', () => {
  it('sends prompts, keys and focus with --flag=value text', async () => {
    const { orca, calls } = fake();
    const b = new OrcaBackend(orca);
    await b.sendPrompt('term_1', '--help\nme');
    await b.sendKeys('term_1', { bytes: '\x1b[A' });
    await b.sendKeys('term_1', { enter: true });
    await b.focus('term_1');
    expect(calls).toEqual([
      ['terminal', 'send', '--terminal', 'term_1', '--text=--help\nme', '--enter'],
      ['terminal', 'send', '--terminal', 'term_1', '--text=\x1b[A'],
      ['terminal', 'send', '--terminal', 'term_1', '--enter'],
      ['terminal', 'switch', '--terminal', 'term_1'],
    ]);
  });

  it('reads the screen tail', async () => {
    const { orca } = fake(() => ({ terminal: { tail: ['a', 'b'] } }));
    expect(await new OrcaBackend(orca).readScreen('term_1')).toEqual(['a', 'b']);
    const { orca: empty } = fake(() => ({}));
    expect(await new OrcaBackend(empty).readScreen('term_1')).toEqual([]);
  });
});

describe('OrcaBackend blocked prompts', () => {
  const blocked = (id: string) => new OrcaCliError(`Agent can not take a prompt (request ID: ${id})`, 'agent_prompt_blocked');

  it('turns agent_prompt_blocked into BackendBusyError and retries the same prompt', async () => {
    let refuse = true;
    const { orca, calls } = fake(() => (refuse ? blocked('aaaaaaaa-1111') : {}));
    const b = new OrcaBackend(orca);
    const err = await b.sendPrompt('term_1', 'hello').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendBusyError);
    expect((err as BackendBusyError).requestId).toBe('aaaaaaaa-1111');
    expect(b.blockedHandle('aaaaaaaa-1111')).toBe('term_1');

    refuse = false;
    await b.retryPrompt('aaaaaaaa-1111');
    expect(calls.at(-1)).toEqual([
      'terminal', 'send', '--terminal', 'term_1', '--text=hello', '--enter', '--retry-request=aaaaaaaa-1111', '--wait-submit=10',
    ]);
    expect(b.blockedHandle('aaaaaaaa-1111')).toBeNull();
  });

  it('chains a re-blocked retry to the original prompt', async () => {
    let next = 'aaaaaaaa-1111';
    const { orca, calls } = fake(() => (next ? blocked(next) : {}));
    const b = new OrcaBackend(orca);
    await b.sendPrompt('term_1', 'hello').catch(() => undefined);
    next = 'bbbbbbbb-2222';
    const again = await b.retryPrompt('aaaaaaaa-1111').catch((e: unknown) => e);
    expect((again as BackendBusyError).requestId).toBe('bbbbbbbb-2222');
    next = '';
    await b.retryPrompt('bbbbbbbb-2222');
    expect(calls.at(-1)).toEqual([
      'terminal', 'send', '--terminal', 'term_1', '--text=hello', '--enter', '--retry-request=bbbbbbbb-2222', '--wait-submit=10',
    ]);
  });

  it('forgets blocked prompts after 10 minutes and rethrows other errors', async () => {
    let now = 0;
    let refuse: Error = blocked('aaaaaaaa-1111');
    const { orca } = fake(() => refuse);
    const b = new OrcaBackend(orca, undefined, () => now);
    await b.sendPrompt('term_1', 'one').catch(() => undefined);
    now = 10 * 60_000 + 1;
    refuse = blocked('bbbbbbbb-2222');
    await b.sendPrompt('term_1', 'two').catch(() => undefined);
    expect(b.blockedHandle('aaaaaaaa-1111')).toBeNull();
    expect(b.blockedHandle('bbbbbbbb-2222')).toBe('term_1');

    refuse = new OrcaCliError('boom', 'orca_error');
    await expect(b.sendPrompt('term_1', 'x')).rejects.toThrow('boom');
    await expect(b.retryPrompt('nope')).rejects.toThrow();
  });
});

describe('OrcaBackend hire', () => {
  it('waits for the new agent TUI before typing the first prompt', async () => {
    const { orca, calls } = fake((args) =>
      args[1] === 'create' ? { terminal: { handle: 'term_9' } } : args[1] === 'wait' ? { wait: { satisfied: true } } : {},
    );
    expect(await new OrcaBackend(orca).hire({ kind: 'agent', deskId: 'r::/a', agent: 'claude', prompt: 'go' })).toEqual({});
    expect(calls).toEqual([
      ['terminal', 'create', '--worktree=id:r::/a', '--command=claude', '--title=claude'],
      ['terminal', 'wait', '--terminal=term_9', '--for=tui-idle', '--timeout-ms=60000'],
      ['terminal', 'send', '--terminal=term_9', '--text=go', '--enter'],
    ]);
  });

  it('warns instead of typing when the TUI never became idle', async () => {
    const { orca, calls } = fake((args) => (args[1] === 'create' ? { handle: 'term_9' } : { wait: { satisfied: false } }));
    const r = await new OrcaBackend(orca).hire({ kind: 'agent', deskId: 'r::/a', agent: 'claude', prompt: 'go' });
    expect(r.warning).toMatch(/첫 지시는 보내지 못했어요/);
    expect(calls.some((c) => c[1] === 'send')).toBe(false);
  });

  it('passes a new worktree prompt to Orca directly', async () => {
    const { orca, calls } = fake();
    await new OrcaBackend(orca).hire({ kind: 'worktree', repoId: 'r1', name: 'x', agent: 'codex', baseBranch: null, prompt: 'go' });
    expect(calls).toEqual([['worktree', 'create', '--repo=id:r1', '--name=x', '--no-parent', '--agent=codex', '--prompt=go']]);
  });
});

describe('OrcaBackend board, search, usage, sessions', () => {
  it('clears a comment with a single space (Orca has no empty comment)', async () => {
    const { orca, calls } = fake();
    const b = new OrcaBackend(orca);
    await b.setBoard('r::/a', { workspaceStatus: 'in-review', comment: '' });
    await b.setBoard('r::/a', { comment: 'hi' });
    expect(calls).toEqual([
      ['worktree', 'set', '--worktree=id:r::/a', '--workspace-status=in-review', '--comment= '],
      ['worktree', 'set', '--worktree=id:r::/a', '--comment=hi'],
    ]);
  });

  it('maps conversation search hits', async () => {
    const { orca, calls } = fake(() => ({
      hits: [
        { agent: 'claude', title: 'Fix', cwd: '/p/a', updatedAt: '2026-10-01', evidence: { snippet: 'x [[y]]', role: 'user' }, source: { filePath: '/f.jsonl' }, resumeCommand: 'claude -r 1' },
        {},
      ],
    }));
    expect(await new OrcaBackend(orca).searchConversations('y')).toEqual([
      { agent: 'claude', title: 'Fix', cwd: '/p/a', updatedAt: '2026-10-01', snippet: 'x [[y]]', role: 'user', filePath: '/f.jsonl', resumeCommand: 'claude -r 1' },
      { agent: '', title: '', cwd: '', updatedAt: null, snippet: '', role: null, filePath: null, resumeCommand: null },
    ]);
    expect(calls[0]).toEqual(['search', '--query=y', '--scope=conversation', '--limit=30']);
  });

  it('reads usage from account list', async () => {
    const { orca } = fake(() => ({ rateLimits: { claude: { provider: 'claude', status: 'ok', session: { usedPercent: 50 } } } }));
    const u = await new OrcaBackend(orca).usage();
    expect(u?.providers).toEqual([{ provider: 'claude', windows: [expect.objectContaining({ key: 'session', usedPercent: 50 })] }]);
  });

  it('finds sessions through orca search and caches them', async () => {
    const { orca } = fake(() => ({ hits: [{ cwd: '/p/a', source: { presence: 'present', filePath: '/s.jsonl' } }] }));
    const b = new OrcaBackend(orca);
    const desk = { id: 'r::/p/a', path: '/p/a' } as OfficeDesk;
    const agent = { id: 'tab:leaf', agentType: 'claude', prompt: 'add pixel assets please', lastMessage: null, terminalTitle: null } as OfficeAgent;
    expect(b.cachedSession('tab:leaf')).toBeNull();
    expect(await b.findSession(desk, agent)).toBe('/s.jsonl');
    expect(b.cachedSession('tab:leaf')).toBe('/s.jsonl');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npm test -w bridge -- orcaBackend`
Expected: FAIL with `OrcaBackend is not a constructor` (or "does not provide an export named 'OrcaBackend'").

- [ ] **Step 3: Implement `OrcaBackend`.** Replace `bridge/src/backend/orca.ts` with the following. `orcaHireArgs` is kept as it was.

```ts
import type { OfficeAgent, OfficeDesk, OfficeSnapshot, UsageSnapshot } from '../model.js';
import type { OrcaCliError, OrcaRunner } from '../orcaCli.js';
import { SessionResolver, type SessionVerifier } from '../sessionResolver.js';
import { toSnapshot, type OrcaTerminalRow, type OrcaWorktreeRow } from '../stateMapper.js';
import { toUsage } from '../usage.js';
import {
  BackendBusyError,
  BackendError,
  type BackendCapabilities,
  type ConversationHit,
  type HireResult,
  type HireSpec,
  type KeyInput,
  type OfficeBackend,
} from './types.js';

/** Terminal rows only change when terminals open/close or retitle: refresh them sparingly. */
const TERMINALS_MAX_AGE_MS = 15_000;
const BLOCKED_TTL_MS = 10 * 60_000;

/** Orca argv for a validated hire. Values only ever go in as --flag=value. */
export function orcaHireArgs(spec: HireSpec): string[] {
  if (spec.kind === 'agent') {
    return ['terminal', 'create', `--worktree=id:${spec.deskId}`, `--command=${spec.agent}`, `--title=${spec.agent}`];
  }
  const args = ['worktree', 'create', `--repo=id:${spec.repoId}`, `--name=${spec.name}`, '--no-parent', `--agent=${spec.agent}`];
  if (spec.baseBranch) args.push(`--base-branch=${spec.baseBranch}`);
  if (spec.prompt) args.push(`--prompt=${spec.prompt}`);
  return args;
}

interface OrcaSearchHit {
  agent?: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  evidence?: { snippet?: string; role?: string };
  source?: { filePath?: string };
  resumeCommand?: string;
}

/** Everything the office needs, through the Orca CLI. Every argv is built here. */
export class OrcaBackend implements OfficeBackend {
  readonly name: string = 'orca';
  readonly capabilities: BackendCapabilities = { usage: true, search: true, board: true, hire: true, changes: true, transcripts: true };
  private terminals: { rows: OrcaTerminalRow[]; at: number } | null = null;
  /**
   * Orca refuses a prompt while the agent can't take one (mid-transition, dialog, …) and hands
   * back a request id; the exact same command plus that id may be retried later.
   */
  private blocked = new Map<string, { args: string[]; at: number }>();
  private readonly sessions: SessionResolver;

  constructor(
    private readonly orca: OrcaRunner,
    verify?: SessionVerifier,
    private readonly now: () => number = Date.now,
  ) {
    this.sessions = new SessionResolver(orca, verify, now);
  }

  async snapshot(): Promise<OfficeSnapshot> {
    const ps = (await this.orca(['worktree', 'ps'])) as { worktrees?: OrcaWorktreeRow[] };
    const worktrees = ps?.worktrees ?? [];
    return toSnapshot(worktrees, await this.terminalRows(worktrees), this.now());
  }

  /** Cached `terminal list`, refreshed when stale or when an agent shows up in a pane we don't know. */
  private async terminalRows(worktrees: OrcaWorktreeRow[]): Promise<OrcaTerminalRow[]> {
    const known = new Set((this.terminals?.rows ?? []).map((t) => `${t.tabId}:${t.leafId}`));
    const unknownPane = worktrees.some((w) => (w.agents ?? []).some((a) => a.paneKey && !known.has(a.paneKey)));
    const stale = !this.terminals || this.now() - this.terminals.at > TERMINALS_MAX_AGE_MS;
    if (stale || unknownPane) {
      const r = (await this.orca(['terminal', 'list'])) as { terminals?: OrcaTerminalRow[] };
      this.terminals = { rows: r?.terminals ?? [], at: this.now() };
    }
    return this.terminals!.rows;
  }

  async readScreen(handle: string): Promise<string[]> {
    const r = (await this.orca(['terminal', 'read', '--terminal', handle, '--screen'])) as { terminal?: { tail?: string[] } };
    return r?.terminal?.tail ?? [];
  }

  sendPrompt(handle: string, text: string): Promise<void> {
    return this.deliver(['terminal', 'send', '--terminal', handle, `--text=${text}`, '--enter']);
  }

  retryPrompt(requestId: string): Promise<void> {
    const pending = this.blocked.get(requestId);
    if (!pending) return Promise.reject(new BackendError('다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요', 'not_found'));
    return this.deliver([...pending.args, `--retry-request=${requestId}`, '--wait-submit=10'], requestId);
  }

  blockedHandle(requestId: string): string | null {
    return this.blocked.get(requestId)?.args[3] ?? null;
  }

  private async deliver(args: string[], retryOf?: string): Promise<void> {
    try {
      await this.orca(args);
      if (retryOf) this.blocked.delete(retryOf);
    } catch (err) {
      const e = err as OrcaCliError;
      const requestId = /request ID:\s*([0-9a-f-]{8,64})/i.exec(e.message)?.[1] ?? retryOf;
      if ((e.code === 'agent_prompt_blocked' || /agent_prompt_blocked/.test(e.message)) && requestId) {
        // A re-blocked retry keeps pointing at the original prompt, never at the retry argv.
        const base = retryOf ? this.blocked.get(retryOf)?.args : args;
        if (base) this.blocked.set(requestId, { args: base, at: this.now() });
        for (const [id, p] of this.blocked) if (this.now() - p.at > BLOCKED_TTL_MS) this.blocked.delete(id);
        throw new BackendBusyError(requestId);
      }
      throw err;
    }
  }

  async sendKeys(handle: string, input: KeyInput): Promise<void> {
    // `--text=value` so text starting with `--` can never be parsed as another flag.
    await this.orca(['terminal', 'send', '--terminal', handle, ...('enter' in input ? ['--enter'] : [`--text=${input.bytes}`])]);
  }

  async focus(handle: string): Promise<void> {
    await this.orca(['terminal', 'switch', '--terminal', handle]);
  }

  async hire(spec: HireSpec): Promise<HireResult> {
    const result = (await this.orca(orcaHireArgs(spec))) as { terminal?: { handle?: string }; handle?: string };
    // A new worktree gets its prompt from Orca itself; a new terminal needs us to type it.
    if (spec.kind !== 'agent' || !spec.prompt) return {};
    const handle = result?.terminal?.handle ?? result?.handle;
    if (!handle) return {};
    // The agent's TUI needs a moment; Orca can wait for it to be idle before we type.
    const wait = (await this.orca(['terminal', 'wait', `--terminal=${handle}`, '--for=tui-idle', '--timeout-ms=60000'])) as {
      wait?: { satisfied?: boolean };
    };
    if (!wait?.wait?.satisfied) return { warning: '에이전트는 띄웠지만 준비가 늦어 첫 지시는 보내지 못했어요. 패널에서 보내 주세요' };
    await this.orca(['terminal', 'send', `--terminal=${handle}`, `--text=${spec.prompt}`, '--enter']);
    return {};
  }

  async setBoard(deskId: string, update: { workspaceStatus?: string; comment?: string }): Promise<void> {
    const args = ['worktree', 'set', `--worktree=id:${deskId}`];
    if (update.workspaceStatus !== undefined) args.push(`--workspace-status=${update.workspaceStatus}`);
    // Orca can't clear a comment; a single space is the closest (shown as empty everywhere).
    if (update.comment !== undefined) args.push(`--comment=${update.comment || ' '}`);
    await this.orca(args);
  }

  findSession(desk: OfficeDesk, agent: OfficeAgent): Promise<string | null> {
    return this.sessions.resolve(desk, agent);
  }

  cachedSession(agentId: string): string | null {
    return this.sessions.cached(agentId);
  }

  async searchConversations(query: string): Promise<ConversationHit[]> {
    const r = (await this.orca(['search', `--query=${query}`, '--scope=conversation', '--limit=30'])) as { hits?: OrcaSearchHit[] };
    return (r?.hits ?? []).map((h) => ({
      agent: String(h.agent ?? ''),
      title: String(h.title ?? ''),
      cwd: h.cwd ?? '',
      updatedAt: h.updatedAt ?? null,
      snippet: String(h.evidence?.snippet ?? ''),
      role: h.evidence?.role ?? null,
      filePath: h.source?.filePath ?? null,
      resumeCommand: h.resumeCommand ?? null,
    }));
  }

  async usage(): Promise<UsageSnapshot | null> {
    const r = (await this.orca(['account', 'list'])) as { rateLimits?: Record<string, unknown> };
    return toUsage(r?.rateLimits);
  }
}
```

- [ ] **Step 4: Run the tests.**

Run: `npm test -w bridge -- orcaBackend`
Expected: PASS (13 tests).

If "finds sessions through orca search" fails, read `searchKey` in `bridge/src/sessionResolver.ts`. The agent's `prompt` must be at least 6 characters; the test uses `'add pixel assets please'`. Do not change `SessionResolver`.

- [ ] **Step 5: Run the full bridge suite and the typecheck.**

Run: `npm test -w bridge && npm run typecheck -w bridge`
Expected: all PASS, `tsc` silent.

- [ ] **Step 6: Commit.**

```bash
git add bridge/src/backend/orca.ts bridge/test/orcaBackend.test.ts
git commit -m "Backend seam: OrcaBackend owns every Orca argv"
```

---

### Task 3: Poller takes a snapshot source; server polls, resolves sessions and reads usage through the backend

**Files:**
- Modify: `bridge/src/poller.ts`
- Modify: `bridge/src/usage.ts` (remove `fetchUsage` and its `OrcaRunner` import)
- Modify: `bridge/src/server.ts` (construction at lines 33-46, `enrichFromTranscripts`, every `sessions.*`, `refreshUsage`)
- Test: `bridge/test/poller.test.ts`

**Interfaces:**
- Consumes: `OrcaBackend` (Task 2).
- Produces: `new OfficePoller(source: () => Promise<OfficeSnapshot>, intervalMs?, enrich?)`.
  - `now` is removed from the constructor because it was only used for terminal caching.
  - The server now holds a `backend: OfficeBackend` constant. Tasks 4 and 5 rely on it.

- [ ] **Step 1: Rewrite the poller test.** Replace `bridge/test/poller.test.ts`. The terminal-cache test now lives in `orcaBackend.test.ts`.

```ts
import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../src/model.js';
import { OfficePoller } from '../src/poller.js';

const office = (n: number): OfficeSnapshot => ({ desks: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, agents: [] }) as never), updatedAt: Date.now(), error: null });

describe('OfficePoller', () => {
  it('notifies only on change and keeps last desks on error', async () => {
    let fail = false;
    const poller = new OfficePoller(async () => {
      if (fail) throw new Error('orca down');
      return office(1);
    });
    const seen: string[] = [];
    poller.onChange((s) => seen.push(s.error ?? `desks:${s.desks.length}`));

    await poller.refresh();
    await poller.refresh();
    expect(seen).toEqual(['desks:1']);

    fail = true;
    await poller.refresh();
    expect(seen).toEqual(['desks:1', 'orca down']);
    expect(poller.current.desks).toHaveLength(1);
  });

  it('runs enrichment before change detection and shares an in-flight poll', async () => {
    let polls = 0;
    const poller = new OfficePoller(
      async () => {
        polls++;
        return office(1);
      },
      1500,
      async (s) => {
        s.desks[0].name = 'enriched';
      },
    );
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(polls).toBe(1);
    expect(poller.current.desks[0].name).toBe('enriched');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `npm test -w bridge -- poller`
Expected: FAIL. The current poller calls `source(['worktree','ps'])`, gets a snapshot object without `worktrees`, and reports `desks:0` instead of `desks:1`.

- [ ] **Step 3: Simplify `bridge/src/poller.ts`.**
  - Replace the imports with `import type { OfficeSnapshot } from './model.js';`.
  - Delete `TERMINALS_MAX_AGE_MS`, the `terminals` field, the `now` constructor parameter and the `terminalRows` method.
  - Replace the class doc comment, the constructor and `poll()` with:

```ts
/**
 * The backend has no event stream, so poll its snapshot and only notify listeners when the
 * office actually changed (updatedAt is ignored in the comparison).
 */
export class OfficePoller {
  private snapshot: OfficeSnapshot = { desks: [], updatedAt: 0, error: null };
  private lastKey = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<(s: OfficeSnapshot) => void>();
  private idle = false;

  constructor(
    private readonly source: () => Promise<OfficeSnapshot>,
    private readonly intervalMs = 1500,
    /** Adds data the backend doesn't have (e.g. running subagents) before change detection. */
    private readonly enrich?: (s: OfficeSnapshot) => Promise<void>,
  ) {}
```

```ts
  private async poll(): Promise<void> {
    let next: OfficeSnapshot;
    try {
      next = await this.source();
      if (this.enrich) await this.enrich(next).catch(() => undefined);
    } catch (err) {
      // Keep the last known office on screen and surface the error.
      next = { ...this.snapshot, updatedAt: Date.now(), error: (err as Error).message };
    }
    const key = JSON.stringify({ desks: next.desks, error: next.error });
    this.snapshot = next;
    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const fn of this.listeners) fn(next);
    }
  }
```

Keep `IDLE_INTERVAL_MS`, `setIdle`, `current`, `onChange`, `start`, `stop` and `refresh` unchanged. Also change the `IDLE_INTERVAL_MS` comment to: `/** With nobody watching, check rarely (each Orca check spawns a CLI process). */`

- [ ] **Step 4: Remove `fetchUsage` from `bridge/src/usage.ts`.** Delete the `fetchUsage` function and the `import type { OrcaRunner } ...` line. `toUsage` stays.

- [ ] **Step 5: Wire the backend into `server.ts`.**
  - Add the imports `import { OrcaBackend } from './backend/orca.js';` and `import type { OfficeBackend } from './backend/types.js';`.
  - Remove the imports of `fetchUsage` and `SessionResolver`.
  - Replace the block from `const orca = DEMO ? ...` through the end of the `new SessionResolver(...)` call (lines ~33-46) with:

```ts
const orca = DEMO ? createDemoRunner() : createOrcaRunner();
// Only accept a session whose transcript actually contains what we searched for.
const backend: OfficeBackend = new OrcaBackend(orca, async (filePath, key) => {
  const t = await readTranscript(filePath);
  if (key.title) return t.title?.toLowerCase() === key.title.toLowerCase() || t.messages.length > 0;
  const needle = key.phrase.slice(0, 40);
  return t.messages.some((m) => m.role !== 'tool' && m.text.replace(/\s+/g, ' ').includes(needle));
});
const commands = new CommandCatalog();
const poller = new OfficePoller(() => backend.snapshot(), 1500, async (s) => {
  await enrichFromTranscripts(s.desks);
  updateAwards(s.desks);
});
```

  - Then replace session and usage access everywhere in `server.ts`:
    - every `sessions.resolve(` with `backend.findSession(`;
    - every `sessions.cached(` with `backend.cachedSession(`.

    Use your editor's find. Expect 5 `resolve` sites (`conversation()`, `/api/conversation/image`, `/api/local-image`, `/api/answer`, `enrichFromTranscripts`) and 2 `cached` sites (`enrichFromTranscripts`, `/api/search`).
  - In `refreshUsage`, replace `const next = await fetchUsage(orca);` with:

```ts
    const next = await backend.usage();
    if (!next) return;
```

- [ ] **Step 6: Verify.**

Run: `npm test -w bridge && npm run typecheck -w bridge && grep -n "sessions\.\|fetchUsage" bridge/src/server.ts`
Expected: tests PASS, `tsc` silent, and `grep` prints nothing.

- [ ] **Step 7: Commit.**

```bash
git add bridge/src/poller.ts bridge/src/usage.ts bridge/src/server.ts bridge/test/poller.test.ts
git commit -m "Backend seam: poller, sessions and usage go through OrcaBackend"
```

---

### Task 4: Every server endpoint goes through the backend

**Files:**
- Modify: `bridge/src/server.ts` (`readScreen`, the `blockedPrompts`/`deliver` block at ~200-235, `/api/search`, `/api/send`, `/api/send/retry`, `/api/keys`, `/api/answer`, `/api/queue`, `/api/hire`, `/api/worktree`, `/api/focus`, the error handler)

**Interfaces:**
- Consumes: `backend.readScreen`, `sendPrompt`, `retryPrompt`, `blockedHandle`, `sendKeys`, `focus`, `hire`, `setBoard` and `searchConversations`, plus `BackendBusyError` and `BackendError`.
- Produces: a `server.ts` whose only remaining use of the runner is `new OrcaBackend(orca, …)`.

This task is a pure rewiring with no new logic, so it has no new unit test. The orcaBackend tests from Task 2 pin the argv. This task is verified by the typecheck, by `grep`, and by the manual demo check in Task 6.

- [ ] **Step 1: Replace `readScreen` and `deliver`.**
  - Change the `readScreen` helper body to `return backend.readScreen(handle);`.
  - Delete `blockedPrompts`, `BLOCKED_TTL_MS` and the old `deliver` together with their doc comment. Keep `answering`.
  - Add this helper in their place:

```ts
/** Submit a prompt; a busy agent becomes a 409 the panel can retry by request id. */
async function deliver(res: ServerResponse, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (err) {
    if (!(err instanceof BackendBusyError)) throw err;
    return json(res, 409, {
      code: 'agent_busy',
      requestId: err.requestId,
      error: '에이전트가 지금 새 메시지를 받을 수 없는 상태예요 (질문·권한 확인 중이거나 화면 전환 중). 잠시 후 다시 보내기를 눌러 주세요',
    });
  }
  void poller.refresh();
  return json(res, 200, { ok: true });
}
```

  - Update the imports:
    - `import { BackendBusyError, type BackendError, type OfficeBackend } from './backend/types.js';`
    - `import { createOrcaRunner, resolveOrcaCommand } from './orcaCli.js';` (`OrcaCliError` is no longer used here).

- [ ] **Step 2: `/api/send` and `/api/send/retry`.**
  - In `/api/send`, replace the last two lines (`const args = [...]` and `return deliver(res, args);`) with:

```ts
    return deliver(res, () => backend.sendPrompt(body.terminalHandle, prompt));
```

  - Replace the body of `/api/send/retry` after `readJson` with:

```ts
    const requestId = typeof body.requestId === 'string' ? body.requestId : '';
    if (!knownHandle(backend.blockedHandle(requestId))) return json(res, 404, { error: '다시 보낼 메시지를 찾지 못했습니다. 새로 보내주세요' });
    return deliver(res, () => backend.retryPrompt(requestId));
```

- [ ] **Step 3: Key input.**
  - In `/api/keys`, replace the `await orca([...])` line with:

```ts
    await backend.sendKeys(body.terminalHandle, body.key === 'enter' ? { enter: true } : { bytes });
```

  - In `/api/answer`, replace the `press` callback body with:

```ts
            await backend.sendKeys(handle, key === 'enter' ? { enter: true } : { bytes: keyBytes(key)! });
```

  - In `/api/queue`, replace the loop's `await orca([...])` with:

```ts
      await backend.sendKeys(body.terminalHandle, { bytes: keyBytes(key)! });
```

- [ ] **Step 4: Hire, board, focus.**
  - In `/api/hire`, replace everything from `const result = (await orca(orcaHireArgs(spec)))` through the end of the `if (spec.kind === 'agent' && spec.prompt) { ... }` block with:

```ts
    const result = await backend.hire(spec);
    if (result.warning) return json(res, 200, { ok: true, warning: result.warning });
```

    Then remove the `orcaHireArgs` import.
  - In `/api/worktree`, replace the argument building with a validated update object. Keep the validation messages identical:

```ts
    const update: { workspaceStatus?: string; comment?: string } = {};
    if (body.workspaceStatus !== undefined) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(body.workspaceStatus)) return json(res, 400, { error: 'invalid status' });
      update.workspaceStatus = body.workspaceStatus;
    }
    if (body.comment !== undefined) {
      const c = String(body.comment).replace(/\s+/g, ' ').trim();
      if (c.length > 200) return json(res, 400, { error: '코멘트는 200자까지 쓸 수 있어요' });
      update.comment = c;
    }
    if (!Object.keys(update).length) return json(res, 400, { error: 'nothing to change' });
    await backend.setBoard(desk.id, update);
```

  - In `/api/focus`, replace the `await orca([...])` line with `await backend.focus(body.terminalHandle);`.

- [ ] **Step 5: Search.** In `/api/search`, replace the `orca([...search...])` call and its type with:

```ts
    const hits = await backend.searchConversations(q);
    const results: SearchResult[] = hits.map((h) => {
```

Inside the map, keep the deskId/agentId loop but use `h.filePath`:

```ts
        const a = d.agents.find((x) => h.filePath && backend.cachedSession(x.id) === h.filePath);
```

and build the result from the already-normalized fields:

```ts
      return {
        title: h.title,
        agent: h.agent,
        project: path.basename(h.cwd),
        updatedAt: h.updatedAt,
        snippet: h.snippet,
        role: h.role,
        deskId,
        agentId,
        resumeCommand: agentId ? null : h.resumeCommand,
      };
```

- [ ] **Step 6: Error handler.** In `createServer`, change `code: (err as OrcaCliError).code` to `code: (err as BackendError).code`.

- [ ] **Step 7: Verify.**

Run: `npm run typecheck -w bridge && npm test -w bridge && grep -nE "orca\(|OrcaCliError|blockedPrompts" bridge/src/server.ts`
Expected: `tsc` silent, tests PASS, and `grep` prints nothing.

- [ ] **Step 8: Commit.**

```bash
git add bridge/src/server.ts
git commit -m "Backend seam: server endpoints call OfficeBackend only"
```

---

### Task 5: DemoBackend, backend selection, capabilities replace `DEMO` branches

**Files:**
- Create: `bridge/src/backend/demo.ts`
- Create: `bridge/src/backend/index.ts`
- Modify: `bridge/src/server.ts` (construction, `enrichFromTranscripts`, `/api/changes`/`/api/diff`, `/api/search`, `/api/hire`, `/api/worktree`, the `DEMO` constant)
- Test: `bridge/test/demoBackend.test.ts`

**Interfaces:**
- Consumes: `OrcaBackend` (Task 2), and `createDemoRunner` and `demoEnrichment` from `bridge/src/demo.ts` (unchanged).
- Produces:
  - `class DemoBackend extends OrcaBackend` with constructor `(verify?: SessionVerifier)`.
  - `createBackend(env: NodeJS.ProcessEnv, verify?: SessionVerifier): OfficeBackend`.

- [ ] **Step 1: Write the failing tests.** Create `bridge/test/demoBackend.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DemoBackend } from '../src/backend/demo.js';
import { createBackend } from '../src/backend/index.js';

describe('DemoBackend', () => {
  it('only offers what the demo can fake', () => {
    expect(new DemoBackend().capabilities).toEqual({ usage: true, search: false, board: false, hire: false, changes: false, transcripts: false });
  });

  it('fills model, effort, stats and change counts itself', async () => {
    const s = await new DemoBackend().snapshot();
    const p1 = s.desks.flatMap((d) => d.agents).find((a) => a.id === 'p1:leaf');
    expect(p1).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh', subagentsRunning: 2 });
    expect(p1?.stats?.instructions).toBeGreaterThan(0);
    const withAgents = s.desks.filter((d) => d.agents.length);
    expect(withAgents.every((d) => d.changes && d.changes.files > 0)).toBe(true);
    expect(s.desks.filter((d) => !d.agents.length).every((d) => d.changes === null)).toBe(true);
  });

  it('serves demo usage and a demo screen', async () => {
    const b = new DemoBackend();
    expect((await b.usage())?.providers[0].provider).toBe('claude');
    expect((await b.readScreen('demo_p1')).length).toBeGreaterThan(0);
  });
});

describe('createBackend', () => {
  it('picks orca by default, demo via OFFICE_DESKS_DEMO or OFFICE_DESKS_BACKEND', () => {
    expect(createBackend({}).name).toBe('orca');
    expect(createBackend({ OFFICE_DESKS_DEMO: '1' }).name).toBe('demo');
    expect(createBackend({ OFFICE_DESKS_BACKEND: 'demo' }).name).toBe('demo');
    expect(createBackend({ OFFICE_DESKS_BACKEND: 'orca', OFFICE_DESKS_DEMO: '1' }).name).toBe('orca');
    expect(() => createBackend({ OFFICE_DESKS_BACKEND: 'tmux' })).toThrow(/OFFICE_DESKS_BACKEND/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `npm test -w bridge -- demoBackend`
Expected: FAIL with `Failed to resolve import "../src/backend/demo.js"`.

- [ ] **Step 3: Create `bridge/src/backend/demo.ts`.**

```ts
import { createDemoRunner, demoEnrichment } from '../demo.js';
import type { OfficeSnapshot } from '../model.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { OrcaBackend } from './orca.js';
import type { BackendCapabilities } from './types.js';

/** `npm run demo`: the Orca backend over a fake Orca, plus the data real transcripts and git would add. */
export class DemoBackend extends OrcaBackend {
  override readonly name: string = 'demo';
  override readonly capabilities: BackendCapabilities = { usage: true, search: false, board: false, hire: false, changes: false, transcripts: false };

  constructor(verify?: SessionVerifier) {
    super(createDemoRunner(), verify);
  }

  override async snapshot(): Promise<OfficeSnapshot> {
    const s = await super.snapshot();
    for (const a of s.desks.flatMap((d) => d.agents)) Object.assign(a, demoEnrichment(a.id));
    for (const [i, d] of s.desks.entries()) d.changes = d.agents.length ? { files: (i % 4) + 1, added: 12 + i * 37, deleted: i * 9 } : null;
    return s;
  }
}
```

- [ ] **Step 4: Create `bridge/src/backend/index.ts`.**

```ts
import { createOrcaRunner } from '../orcaCli.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { DemoBackend } from './demo.js';
import { OrcaBackend } from './orca.js';
import type { OfficeBackend } from './types.js';

/** OFFICE_DESKS_BACKEND wins; OFFICE_DESKS_DEMO (set by `--demo`) means demo; otherwise Orca. */
export function createBackend(env: NodeJS.ProcessEnv, verify?: SessionVerifier): OfficeBackend {
  const kind = env.OFFICE_DESKS_BACKEND?.trim() || (env.OFFICE_DESKS_DEMO ? 'demo' : 'orca');
  if (kind === 'demo') return new DemoBackend(verify);
  if (kind === 'orca') return new OrcaBackend(createOrcaRunner(), verify);
  throw new Error(`Unknown OFFICE_DESKS_BACKEND "${kind}" (use orca or demo)`);
}
```

- [ ] **Step 5: Run the new tests.**

Run: `npm test -w bridge -- demoBackend`
Expected: PASS (4 tests).

- [ ] **Step 6: Switch `server.ts` to `createBackend` and capabilities.**
  - **Construction.** Replace `const DEMO = Boolean(process.env.OFFICE_DESKS_DEMO);`, the `const orca = ...` line and the `new OrcaBackend(orca, …)` call with:

```ts
// Only accept a session whose transcript actually contains what we searched for.
const backend: OfficeBackend = createBackend(process.env, async (filePath, key) => {
  const t = await readTranscript(filePath);
  if (key.title) return t.title?.toLowerCase() === key.title.toLowerCase() || t.messages.length > 0;
  const needle = key.phrase.slice(0, 40);
  return t.messages.some((m) => m.role !== 'tool' && m.text.replace(/\s+/g, ' ').includes(needle));
});
// Sample awards and org chart for the demo office (not a backend concern).
const DEMO = backend.name === 'demo';
```

  - **Imports.**
    - Remove the imports of `createDemoRunner`, `demoEnrichment`, `OrcaBackend` and `createOrcaRunner`.
    - Keep `createDemoAwards` and `demoOrg` from `./demo.js`, and `resolveOrcaCommand` from `./orcaCli.js`.
    - Add `import { createBackend } from './backend/index.js';`.
  - **`enrichFromTranscripts`.** Replace its first lines (the two `DEMO` statements and the `if (DEMO) { ... return; }` block) with:

```ts
  if (backend.capabilities.changes) for (const d of desks) d.changes = cachedChanges(d);
  if (!backend.capabilities.transcripts) return;
```

  - **`/api/changes` and `/api/diff`.** Change `if (!desk || DEMO)` to `if (!desk || !backend.capabilities.changes)`.
  - **`/api/search`.** Change `if (DEMO) return json(res, 200, { results: [] });` to `if (!backend.capabilities.search) return json(res, 200, { results: [] });`.
  - **`/api/hire`.** Change `if (DEMO) return json(res, 400, ...)` to `if (!backend.capabilities.hire) return json(res, 400, { error: '데모 모드에서는 만들 수 없어요' });`.
  - **`/api/worktree`.** Change `if (!desk || DEMO)` to `if (!desk || !backend.capabilities.board)`.
  - **Startup log.** Replace the `server.listen` callback's message with:

```ts
  console.log(`[office-desks] bridge on http://${HOST}:${PORT} (${DEMO ? 'DEMO data' : `${backend.name} backend, orca cli: ${resolveOrcaCommand()}`})`);
```

- [ ] **Step 7: Verify.**

Run: `npm run typecheck -w bridge && npm test -w bridge && grep -nE "DEMO\b" bridge/src/server.ts`
Expected:
- `tsc` is silent and the tests PASS.
- `grep` shows only the `const DEMO = backend.name === 'demo'` line and its uses:
  - the awards file (`new AwardBook(DEMO ? ...)`)
  - `ORG_FILE`
  - the `loadOrg` callback
  - the startup log

- [ ] **Step 8: Commit.**

```bash
git add bridge/src/backend/demo.ts bridge/src/backend/index.ts bridge/src/server.ts bridge/test/demoBackend.test.ts
git commit -m "Backend seam: DemoBackend and createBackend replace DEMO branches"
```

---

### Task 6: End-to-end verification

**Files:** none, unless a regression is found. In that case fix it in the file that caused it and commit with a message that names the regression.

- [ ] **Step 1: Run the full workspace checks, exactly as CI does.**

Run: `npm run typecheck && npm test && npm run build`
Expected: both workspaces typecheck, all bridge and web tests PASS, and the build writes `web/dist` and `bridge/dist` without errors.

- [ ] **Step 2: Check the demo in a browser.**

Run: `npm run demo` (in the background), then open `http://127.0.0.1:4317` with the `/browse` skill. Check the following:
1. The office shows the 3 demo repos. Desks show model and effort tags and fake +/− change counts. Characters change state about every 8s.
2. The usage bar at the bottom shows 5시간 62% / 주간 21% / Fable 주간 9%.
3. Clicking the `rate-limit` claude agent (p5) opens the chat with the demo transcript and the AskUserQuestion card.
4. The terminal view of a waiting agent shows the demo permission dialog.
5. Search (`⌘K`) returns no results without an error. "새 작업" (hire) shows `데모 모드에서는 만들 수 없어요`.

Stop the demo server afterwards.

- [ ] **Step 3: Regression-check against the real Orca.** Orca is running on this machine, so this check is possible.

Run: `npm start` (in the background), open `http://127.0.0.1:4317`, and confirm:
1. Real worktrees and agents appear with live states.
2. An agent's chat opens.
3. A short prompt sent to an idle agent arrives.
4. The usage bar shows real values.

Stop the server. If Orca is not available, write that down in the hand-off report instead of skipping silently.

- [ ] **Step 4: Confirm the seam is complete.**

Run: `grep -rnE "orca\(\[|OrcaRunner" bridge/src --include=*.ts | grep -v "^bridge/src/backend/\|^bridge/src/orcaCli.ts\|^bridge/src/sessionResolver.ts\|^bridge/src/demo.ts"`
Expected: no output. The only raw Orca argv are left in the adapter files.
