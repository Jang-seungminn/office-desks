// Writes crates/od-core/tests/golden/*.json from the real TS code. The Rust tests
// deserialize and re-serialize each file, so wire shapes stay identical to the bridge.
// Run: npm run golden
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHire } from '../src/hire.js';
import { charBytes, KEY_BYTES, keyBytes } from '../src/keys.js';
import type { AwardBoard, BackendInfo, HireRequest, OfficeDesk, OrgChart, ServerMessage, UsageSnapshot } from '../src/model.js';
import { composerState, screenSupport } from '../src/screen.js';
import { cleanTitle, orcaDeskName, toSnapshot } from '../src/stateMapper.js';

const root = new URL('../../', import.meta.url);
const outDir = new URL('crates/od-core/tests/golden/', root);
mkdirSync(fileURLToPath(outDir), { recursive: true });

const load = (name: string) => JSON.parse(readFileSync(new URL(`bridge/test/fixtures/${name}`, root), 'utf8'));
const ps = load('worktree-ps.json');
const terms = load('terminal-list.json');

function write(name: string, value: unknown): void {
  writeFileSync(new URL(`${name}.json`, outDir), JSON.stringify(value, null, 2) + '\n');
}

const snapshot = toSnapshot(ps.worktrees, terms.terminals, 1_700_000_000_000);
// toSnapshot leaves changes/stats/model/effort/subagentsRunning for later stages to fill; fill them
// on one desk and agent so the golden covers the populated shapes too.
const populated = structuredClone(snapshot);
if (populated.desks[0]) {
  populated.desks[0].changes = { files: 3, added: 42, deleted: 7 };
  populated.desks[0].pr = { number: 17, url: 'https://github.com/o/r/pull/17', title: 'Add office', state: 'open' };
  if (populated.desks[1]) populated.desks[1].pr = { number: null, url: null, title: null, state: null };
  const agent = populated.desks[0].agents[0];
  if (agent) {
    agent.subagentsRunning = 2;
    agent.model = 'claude-opus-4-5';
    agent.effort = 'high';
    agent.stats = {
      instructions: 12,
      instructionsToday: 4,
      toolCalls: 230,
      toolCallsToday: 51,
      subagents: 3,
      hiredAt: '2026-10-01T09:30:00.000Z',
    };
  }
}
const withError = { desks: [], updatedAt: 1_700_000_000_000, error: 'orca 연결 실패' };

const backend: BackendInfo = {
  name: 'native',
  capabilities: {
    usage: true,
    search: true,
    board: false,
    hire: true,
    changes: true,
    transcripts: true,
    focus: false,
    repos: true,
    stop: true,
    remove: false,
  },
};

const usage: UsageSnapshot = {
  providers: [
    {
      provider: 'claude',
      windows: [
        { key: 'session', label: '5시간', usedPercent: 37.5, resetsAt: 1_700_003_600_000, resetDescription: 'in 1h' },
        { key: 'weekly', label: '주간', usedPercent: 12, resetsAt: null, resetDescription: null },
      ],
    },
    { provider: 'codex', windows: [] },
  ],
  updatedAt: 1_700_000_000_000,
};

const org: OrgChart = {
  departments: [
    { id: 'dept-1', name: '개발팀', theme: 'dev', repoIds: ['repoA', 'repoB'] },
    { id: 'dept-2', name: '디자인', theme: 'design', repoIds: [] },
    { id: 'dept-3', name: '리서치', theme: 'research', repoIds: ['repoC'] },
    { id: 'dept-4', name: '운영', theme: 'ops', repoIds: [] },
    { id: 'dept-5', name: '기타', theme: 'etc', repoIds: [] },
  ],
};

const award = (date: string, score: number) => ({
  date,
  agentId: 'tab1:leaf1',
  deskId: 'repoA::/Users/me/proj/office_desks',
  name: 'office_desks',
  repo: 'office_desks',
  repoId: 'repoA',
  agentType: 'claude',
  instructions: 5,
  toolCalls: score - 50,
  score,
});
const awards: AwardBoard = { leader: award('2026-10-05', 120), hall: [award('2026-10-04', 200), award('2026-10-03', 90)] };
const noAwards: AwardBoard = { leader: null, hall: [] };

write('snapshot', snapshot);
write('snapshot-populated', populated);
write('snapshot-error', withError);

const messages: Record<string, ServerMessage> = {
  'msg-backend': { type: 'backend', backend },
  'msg-snapshot': { type: 'snapshot', snapshot: populated },
  'msg-usage': { type: 'usage', usage },
  'msg-org': { type: 'org', org },
  'msg-awards': { type: 'awards', awards },
  'msg-awards-empty': { type: 'awards', awards: noAwards },
};
for (const [name, msg] of Object.entries(messages)) write(name, msg);
// --- Task 2: pure helpers ---

// toSnapshot: each case carries its raw Orca input so the Rust test can feed the same rows.
// The native backend names desks by the path's basename (see backend/native.ts).
const nativeName = (w: { path?: string; branch?: string; displayName?: string; repo?: string }) => path.basename(w.path ?? '') || orcaDeskName(w);
const nativeWorktrees = structuredClone(ps.worktrees);
nativeWorktrees[1].path = '/Users/me/secretary/'; // Windows paths split differently per platform; keep this golden portable
delete nativeWorktrees[3].path;
const longPreview = `${'가나다라 '.repeat(40)}end`;
const edgeWorktrees = [
  { worktreeId: 'x::y', agents: [{}] },
  { worktreeId: 'r::/a', unread: true, comment: ' ', preview: longPreview, lastActivityAt: 1_700_000_001_000, isMainWorktree: true, parentWorktreeId: 'r::/p' },
  { worktreeId: 'r::/vault', repo: 'vault', displayName: 'main', branch: 'refs/heads/main' },
  { worktreeId: 'r::/named', repo: 'vault', displayName: 'Custom', branch: 'refs/heads/main', workspaceStatus: 'done' },
  { worktreeId: 'r::/nothing' },
  { worktreeId: '', repo: 'dropped' },
  { worktreeId: 'r::/arch', isArchived: true },
  { worktreeId: 'r::/ws', lastActivityAt: 'yesterday', isActive: 1, comment: '  keep  ', preview: '  a \n\t b  ' },
  {
    worktreeId: 'r::/agents',
    agents: [
      { paneKey: '', agentType: 'codex', state: 'permission', toolName: 'Edit', toolInput: 'x' },
      { paneKey: 'tab9:leaf9', state: 'blocked' },
      { paneKey: 'tab9:leaf9', state: 'idle', toolName: 'Bash' },
      { paneKey: 'tabA:leafA', state: 'working', toolName: 'Monitor', toolInput: `${'long input '.repeat(10)}`, prompt: 'p', lastAssistantMessage: 'm', stateStartedAt: 1_700_000_002_000 },
      { paneKey: 'tabB:leafB', state: 'working', toolName: 'ToolSearch', toolInput: 'a\nb' },
      { paneKey: 'tabC:leafC', state: 'nonsense' },
      { paneKey: 'tabD:leafD', state: 'waiting' },
    ],
  },
  ...[null, false, true, 17, 'https://github.com/o/r/pull/9', 'PR #12 ', 'pull 12 3', 'http://x/1', 'no digits', [], {}, { number: 5, url: 'https://u/5', title: 'T', state: 'open' }, { prNumber: '8', htmlUrl: 'https://h/8' }, { id: 'x8', url: 'http://insecure', htmlUrl: 'https://h/ignored' }, { number: 'abc', prNumber: 3 }].map(
    (pr, i) => ({ worktreeId: `r::/pr${i}`, linkedPR: pr }),
  ),
  // Order checks against ICU localeCompare: case, punctuation, digits, non-ASCII.
  ...['b::/x', 'B::/x', 'a::/Z', 'a::/z', 'a::/_z', 'a::/-z', 'a::/1', 'a::/10', 'a::/2', 'a::/ab', 'a::/aB', 'a::/Ab', 'a::/한글', 'a::/é', 'a::/e', 'a::/f'].map((id) => ({ worktreeId: id })),
];
const edgeTerminals = [
  { handle: 'h9', tabId: 'tab9', leafId: 'leaf9', title: '⠂ spinner only ⠂' },
  { handle: 'h9b', tabId: 'tab9', leafId: 'leaf9', title: '  ✳ later wins  ' },
  { handle: 'hA', tabId: 'tabA', leafId: 'leafA', title: '⠂ ' },
  { handle: 'hB', tabId: 'tabB', title: 'no leaf' },
  { handle: '', tabId: 'tabC', leafId: 'leafC' },
  { tabId: 'tabD', leafId: 'leafD' },
  { handle: 'hE', tabId: 'tabE', leafId: 'leafE', title: '한글 제목' },
];
const mapperCases = [
  { name: 'fixtures', worktrees: ps.worktrees, terminals: terms.terminals, now: 123, deskName: null },
  { name: 'fixtures-native-desk-name', worktrees: nativeWorktrees, terminals: terms.terminals, now: 123, deskName: 'native' },
  { name: 'edge', worktrees: edgeWorktrees, terminals: edgeTerminals, now: 1_700_000_000_000, deskName: null },
  { name: 'edge-native-desk-name', worktrees: edgeWorktrees, terminals: edgeTerminals, now: 1_700_000_000_000, deskName: 'native' },
  { name: 'empty', worktrees: [], terminals: [], now: 0, deskName: null },
].map((c) => ({
  ...c,
  expected: toSnapshot(c.worktrees, c.terminals, c.now, c.deskName ? { deskName: nativeName } : {}),
}));
write('mapper-snapshots', mapperCases);

write(
  'mapper-clean-title',
  [undefined, '', '✳ command context logging', '◑ Orca 터미널 대시보드 프로젝트', '⠂ ', '  plain  ', '123 numbers', '…', 'ⓐ circled', '\u0301 mark first', '😀 emoji'].map((input) => ({ input: input ?? null, expected: cleanTitle(input) })),
);

// composerState for every captured screen plus the vitest inline screens.
const rule = '─'.repeat(60);
const screens: { name: string; lines: string[]; agentType: string }[] = [];
const screenRoot = new URL('bridge/test/fixtures/screens/', root);
for (const version of readdirSync(fileURLToPath(screenRoot))) {
  for (const file of readdirSync(fileURLToPath(new URL(`${version}/`, screenRoot))).filter((f) => f.endsWith('.txt'))) {
    screens.push({ name: `${version}/${file}`, lines: readFileSync(new URL(`${version}/${file}`, screenRoot), 'utf8').split('\n'), agentType: 'claude' });
  }
}
screens.push(
  { name: 'inline composer', lines: ['⏺ Done.', '', `${rule} command context logging ─`, '❯ ', rule, '  ⏵⏵ auto mode on · 1 shell'], agentType: 'claude' },
  { name: 'inline multi-line draft', lines: ['x', rule, '❯ first line', '  second line', rule, 'footer'], agentType: 'claude' },
  { name: 'inline usage dialog', lines: ['Settings  Status  Config  Usage', '', 'Current session  ███░░ 12% used', 'Esc to cancel'], agentType: 'claude' },
  { name: 'inline permission dialog', lines: ['Bash command', '  rm -rf build', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'], agentType: 'claude' },
  { name: 'inline other agent', lines: ['anything'], agentType: 'codex' },
  { name: 'inline blank', lines: ['', ''], agentType: 'claude' },
  { name: 'inline empty', lines: [], agentType: 'claude' },
  { name: 'inline heavy rules', lines: ['━'.repeat(8), '❯', '━'.repeat(8)], agentType: 'claude' },
  { name: 'inline short rule', lines: ['─'.repeat(7), '❯ x', '─'.repeat(7)], agentType: 'claude' },
  { name: 'inline prompt at top', lines: ['❯ x', rule], agentType: 'claude' },
  { name: 'inline draft too long', lines: [rule, '❯ x', ...Array(12).fill('  more'), rule], agentType: 'claude' },
  { name: 'inline draft 11 lines', lines: [rule, '❯ x', ...Array(10).fill('  more'), rule], agentType: 'claude' },
  { name: 'inline indented', lines: ['  ' + rule, '  ❯ hi   ', '  ' + rule], agentType: 'claude' },
  { name: 'inline prompt glued', lines: [rule, '❯hi', rule], agentType: 'claude' },
);
write('screen-composer', screens.map((c) => ({ ...c, expected: composerState(c.lines, c.agentType) })));
write(
  'screen-support',
  [['claude', '2.1.288'], ['claude', '2.2.0'], ['claude', '2.10'], ['claude', '2.1'], ['claude', '2'], ['claude', 'v2.1.0'], ['claude', ''], ['claude', null], ['codex', '0.118.0'], ['codex', null]].map(([agentType, version]) => ({
    agentType,
    version,
    expected: screenSupport(agentType as string, version as string | null),
  })),
);

write('keys', {
  keys: Object.fromEntries(Object.keys(KEY_BYTES).map((k) => [k, keyBytes(k)])),
  rejected: ['constructor', '__proto__', 'toString', 'F1', '', 'Enter', 'ctrl-d'].map((k) => ({ key: k, expected: keyBytes(k) })),
  chars: ['a', 'Z', '한', ' ', '!', '~', '5', '€', '😀', '\x1b', '\n', '\t', '\x7f', 'ab', '', '한글', 'é', '\u0301', '\u00a0', '\u200b'].map((ch) => ({ ch, expected: charBytes(ch) })),
});

// validateHire: every case in hire.test.ts plus the remaining branches. Desks are complete so Rust can deserialize them.
const deskOf = (id: string, repoId: string, name: string): OfficeDesk => ({
  id, repoId, isMain: false, parentId: null, name, repo: repoId, branch: name, path: `/p/${name}`, status: 'inactive', workspaceStatus: null,
  comment: '', preview: '', isActive: false, unread: false, lastActivityAt: null, changes: null, pr: null, agents: [],
});
const hireDesks = [deskOf('r1::/p/main', 'r1', 'main'), deskOf('r1::/p/feat', 'r1', 'feat')];
const hireBodies: { name: string; body: HireRequest }[] = [
  { name: 'new worktree, trimmed prompt', body: { repoId: 'r1', name: 'fix-login', agent: 'claude', prompt: ' --help me ', baseBranch: 'origin/main' } },
  { name: 'new worktree, minimal', body: { repoId: 'r1', name: 'x', agent: 'claude' } },
  { name: 'new worktree, empty base and blank prompt', body: { repoId: 'r1', name: 'x', agent: 'gemini', baseBranch: '', prompt: '   ' } },
  { name: 'agent in existing worktree', body: { deskId: 'r1::/p/feat', agent: 'codex', prompt: 'go' } },
  { name: 'agent in existing worktree, no prompt', body: { deskId: 'r1::/p/feat', agent: 'codex' } },
  { name: 'unknown repo', body: { repoId: 'nope', name: 'x', agent: 'claude' } },
  { name: 'no repo or desk', body: { name: 'x', agent: 'claude' } },
  { name: 'dash name', body: { repoId: 'r1', name: '--fresh', agent: 'claude' } },
  { name: 'space name', body: { repoId: 'r1', name: 'a b', agent: 'claude' } },
  { name: 'missing name', body: { repoId: 'r1', agent: 'claude' } },
  { name: 'name 60 chars', body: { repoId: 'r1', name: 'a'.repeat(60), agent: 'claude' } },
  { name: 'name 61 chars', body: { repoId: 'r1', name: 'a'.repeat(61), agent: 'claude' } },
  { name: 'name with trailing newline', body: { repoId: 'r1', name: 'ok\n', agent: 'claude' } },
  { name: 'name with dots', body: { repoId: 'r1', name: 'v1.2_x-y', agent: 'claude' } },
  { name: 'duplicate name', body: { repoId: 'r1', name: 'feat', agent: 'claude' } },
  { name: 'unknown agent', body: { repoId: 'r1', name: 'ok', agent: 'bash -c x' } },
  { name: 'every known agent: cursor', body: { repoId: 'r1', name: 'ok', agent: 'cursor' } },
  { name: 'dash base branch', body: { repoId: 'r1', name: 'ok', agent: 'claude', baseBranch: '-x' } },
  { name: 'slash base branch', body: { repoId: 'r1', name: 'ok', agent: 'claude', baseBranch: 'release/1.0' } },
  { name: 'base branch 121 chars', body: { repoId: 'r1', name: 'ok', agent: 'claude', baseBranch: 'a'.repeat(121) } },
  { name: 'unknown desk', body: { deskId: 'r1::/elsewhere', agent: 'claude' } },
  { name: 'unknown desk, unknown agent', body: { deskId: 'r1::/elsewhere', agent: 'nope' } },
  { name: 'prompt 8000', body: { deskId: 'r1::/p/feat', agent: 'claude', prompt: 'a'.repeat(8000) } },
  { name: 'prompt 8001', body: { deskId: 'r1::/p/feat', agent: 'claude', prompt: 'a'.repeat(8001) } },
  { name: 'prompt 8000 Korean', body: { deskId: 'r1::/p/feat', agent: 'claude', prompt: '가'.repeat(8000) } },
  { name: 'prompt 4001 astral (8002 UTF-16 units)', body: { deskId: 'r1::/p/feat', agent: 'claude', prompt: '😀'.repeat(4001) } },
];
write('hire', {
  desks: hireDesks,
  cases: hireBodies.map((c) => {
    const r = validateHire(c.body, hireDesks);
    return { ...c, expected: 'error' in r ? { error: r.error } : { spec: r } };
  }),
});
console.log(`golden: wrote ${3 + Object.keys(messages).length + 7} files to ${fileURLToPath(outDir)}`);
