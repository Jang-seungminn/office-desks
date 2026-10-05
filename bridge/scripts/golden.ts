// Writes crates/od-core/tests/golden/*.json from the real TS code. The Rust tests
// deserialize and re-serialize each file, so wire shapes stay identical to the bridge.
// Run: npm run golden
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentStats } from '../src/stats.js';
import { subagentInfos } from '../src/subagents.js';
import { readTranscript, resetTranscriptCache, type TranscriptResult } from '../src/transcript.js';
import { validateHire } from '../src/hire.js';
import { charBytes, KEY_BYTES, keyBytes } from '../src/keys.js';
import type { AnswerRequest, AskedQuestion, SendRequest, TerminalKey, AwardBoard, ConversationResponse, BackendInfo, HireRequest, OfficeDesk, OrgChart, ServerMessage, UsageSnapshot } from '../src/model.js';
import { composerState, screenSupport } from '../src/screen.js';

import { tmpdir } from 'node:os';
import { answerQuestions, currentQuestion, isReviewScreen, validateChoices } from '../src/answer.js';
import { AwardBook, bestToday, localDate } from '../src/awards.js';
import { frontMatter, listCommands } from '../src/commands.js';
import { sanitizeOrg } from '../src/org.js';
import { composePrompt, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, uploadPath } from '../src/uploads.js';
import { cleanTitle, orcaDeskName, toSnapshot } from '../src/stateMapper.js';

// Stats count "today" in local time; pin the zone so the goldens are the same on every machine.
process.env.TZ = 'UTC';

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
// ---- transcripts, stats, conversation responses ----
// fileId hashes the absolute path, which differs per machine: pin it to a placeholder (the Rust
// tests check the hash formula separately).
const fixturePath = (name: string) => fileURLToPath(new URL(`bridge/test/fixtures/${name}`, root));
const pin = <T extends { fileId: string | null }>(t: T): T => ({ ...t, fileId: t.fileId === null ? null : '<fileId>' });
// claude-rich.jsonl is covered by these goldens only (there is no vitest case for it).
const transcripts: Record<string, TranscriptResult> = {};
for (const [name, sidechain] of [['claude-session', false], ['codex-session', false], ['claude-rich', false], ['claude-rich', true]] as const) {
  resetTranscriptCache();
  const t = await readTranscript(fixturePath(`${name}.jsonl`), { sidechain });
  const key = sidechain ? `${name}-sidechain` : name;
  transcripts[key] = t;
  write(`transcript-${key}`, pin(t));
}
resetTranscriptCache();
write(
  'stats',
  Object.keys(transcripts).flatMap((key) =>
    ['2026-10-03T12:00:00Z', '2026-10-04T23:59:59Z', '2026-03-29T00:00:00Z', '2027-01-01T00:00:00Z'].map((nowIso) => ({
      transcript: key,
      now: nowIso,
      expected: agentStats(transcripts[key], new Date(nowIso)),
    })),
  ),
);

// Same assembly as conversation() in server.ts (the file lookup and Korean reasons live there).
const emptyConversation = (reason: string): ConversationResponse => ({
  found: false, reason, fileId: null, title: null, total: 0, after: 0, messages: [], subagents: [], questions: [], pending: [], claudeVersion: null, screenSupport: 'unknown',
});
function conversationOf(main: TranscriptResult, sub: TranscriptResult | null, agentType: string, after: number): ConversationResponse {
  const subagents = subagentInfos(main.calls, new Map([['s1', 'abc123']]));
  const t = sub ?? main;
  const from = Number.isInteger(after) && after >= 0 && after <= t.messages.length ? after : 0;
  return {
    found: true,
    fileId: t.fileId,
    title: sub ? null : t.title,
    total: t.messages.length,
    after: from,
    messages: t.messages.slice(from),
    subagents,
    questions: main.questions,
    pending: sub ? [] : main.pending,
    claudeVersion: main.claudeVersion,
    screenSupport: screenSupport(agentType, main.claudeVersion),
  };
}
const rich = transcripts['claude-rich'];
const conv = (name: string, resp: ConversationResponse, args: object) => ({ name, ...args, expected: pin(resp) });
write('conversation', [
  conv('not found', { ...emptyConversation('이 에이전트는 더 이상 사무실에 없습니다.') }, { kind: 'empty', reason: '이 에이전트는 더 이상 사무실에 없습니다.' }),
  conv('subagent missing', { ...emptyConversation('서브에이전트 기록을 찾지 못했습니다.'), subagents: subagentInfos(rich.calls, new Map([['s1', 'abc123']])) }, { kind: 'empty-subagents', reason: '서브에이전트 기록을 찾지 못했습니다.' }),
  conv('main, from start', conversationOf(rich, null, 'claude', 0), { kind: 'found', main: 'claude-rich', agentType: 'claude', after: 0 }),
  conv('main, after 3', conversationOf(rich, null, 'claude', 3), { kind: 'found', main: 'claude-rich', agentType: 'claude', after: 3 }),
  conv('after out of range', conversationOf(rich, null, 'claude', 9999), { kind: 'found', main: 'claude-rich', agentType: 'claude', after: 9999 }),
  conv('negative after', conversationOf(rich, null, 'codex', -1), { kind: 'found', main: 'claude-rich', agentType: 'codex', after: -1 }),
  conv('subagent view', conversationOf(rich, transcripts['claude-rich-sidechain'], 'claude', 1), { kind: 'found', main: 'claude-rich', sub: 'claude-rich-sidechain', agentType: 'claude', after: 1 }),
  conv('codex session', conversationOf(transcripts['codex-session'], null, 'codex', 0), { kind: 'found', main: 'codex-session', agentType: 'codex', after: 0 }),
]);


// ---- Task 10: org, awards, uploads, commands, answer ----

// sanitizeOrg: generated ids are random, so pin them to a placeholder before comparing (Rust
// checks the "d-" + 8 base-36 shape separately).
const orgInputs: { name: string; input: unknown }[] = [
  { name: 'normalised', input: { departments: [{ id: 'd-a', name: '  개발   팀 ', theme: 'dev', repoIds: ['r1', 'r2'] }, { id: 'd-a', name: '디자인', theme: 'nope', repoIds: ['r2', 'r3', 42] }] } },
  { name: 'all themes and a duplicate repo', input: { departments: ['dev', 'design', 'research', 'ops', 'etc'].map((theme, i) => ({ id: `t-${i}`, name: theme, theme, repoIds: ['same', `own${i}`, 'same'] })) } },
  { name: 'empty list', input: { departments: [] } },
  { name: 'ids', input: { departments: [{ id: 'UPPER', name: 'a' }, { id: 'ok-1\n', name: 'b' }, { id: 'a'.repeat(41), name: 'c' }, { id: 'a'.repeat(40), name: 'd' }, { id: 5, name: 'e' }, { id: 'keep-me', name: 'f' }] } },
  { name: 'repoIds filters', input: { departments: [{ id: 'x', name: 'a', repoIds: ['', 'a', 'a', 'b'.repeat(201), 'b'.repeat(200), null, {}, 'c'] }, { id: 'y', name: 'b', repoIds: 'nope' }] } },
  { name: 'astral name 10', input: { departments: [{ id: 'x', name: '😀'.repeat(10) }] } },
  { name: 'astral name 11', input: { departments: [{ id: 'x', name: '😀'.repeat(11) }] } },
  { name: 'null', input: null },
  { name: 'number', input: 5 },
  { name: 'array', input: [] },
  { name: 'departments not a list', input: { departments: 'x' } },
  { name: 'null entry', input: { departments: [null] } },
  { name: 'empty name', input: { departments: [{ name: '' }] } },
  { name: 'blank name', input: { departments: [{ name: ' \t ' }] } },
  { name: 'numeric name', input: { departments: [{ name: 5 }] } },
  { name: 'name 21', input: { departments: [{ name: 'x'.repeat(21) }] } },
  { name: 'name 20', input: { departments: [{ name: 'x'.repeat(20) }] } },
  { name: '20 departments', input: { departments: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, name: `d${i}` })) } },
  { name: '21 departments', input: { departments: Array.from({ length: 21 }, (_, i) => ({ name: `d${i}` })) } },
];
const pinIds = (v: unknown, input: unknown): unknown => {
  const out = structuredClone(v) as { departments?: { id: string }[] };
  const list = (input as { departments?: unknown } | null)?.departments;
  const given = new Set(Array.isArray(list) ? list.map((d: { id?: unknown } | null) => d?.id) : []);
  for (const d of out.departments ?? []) if (/^d-[0-9a-z]{1,8}$/.test(d.id) && !given.has(d.id)) d.id = '<generated>';
  return out;
};
write('org-sanitize', orgInputs.map((c) => ({ ...c, expected: pinIds(sanitizeOrg(c.input), c.input) })));

// Award scoring. Agents and desks are complete model objects so Rust can deserialize them.
const stat = (instructionsToday: number, toolCallsToday: number) => ({ instructions: 50, instructionsToday, toolCalls: 100, toolCallsToday, subagents: 0, hiredAt: null });
const awardAgent = (id: string, instructionsToday: number, toolCallsToday: number, over: object = {}) => ({
  id, terminalHandle: null, agentType: 'claude', terminalTitle: `${id} 작업`, subagentsRunning: 0, model: null, effort: null,
  stats: stat(instructionsToday, toolCallsToday), state: 'done', rawState: 'done', activity: '', prompt: null, lastMessage: null, since: null, ...over,
});
const awardDesk = (id: string, agents: unknown[], over: object = {}) => ({
  id: `r::/${id}`, repoId: 'r', isMain: true, parentId: null, name: id, repo: 'web', branch: 'main', path: `/${id}`, status: 'active',
  workspaceStatus: null, comment: '', preview: '', isActive: false, unread: false, lastActivityAt: null, changes: null, pr: null, agents, ...over,
}) as unknown as OfficeDesk;
const scoreCases: { name: string; desks: OfficeDesk[] }[] = [
  { name: 'best of three, idle skipped', desks: [awardDesk('w', [awardAgent('a', 3, 5), awardAgent('b', 2, 40), awardAgent('c', 0, 900)])] },
  { name: 'only idle', desks: [awardDesk('w', [awardAgent('c', 0, 900)])] },
  { name: 'no desks', desks: [] },
  { name: 'tie keeps the first', desks: [awardDesk('w', [awardAgent('a', 1, 0), awardAgent('b', 1, 0)])] },
  { name: 'across desks', desks: [awardDesk('x', [awardAgent('a', 1, 5)]), awardDesk('y', [awardAgent('b', 1, 6)], { repo: '' })] },
  { name: 'no title falls back to desk name', desks: [awardDesk('w', [awardAgent('a', 2, 2, { terminalTitle: null })])] },
  { name: 'empty title is kept', desks: [awardDesk('w', [awardAgent('a', 2, 2, { terminalTitle: '' })])] },
  { name: 'no stats', desks: [awardDesk('w', [awardAgent('a', 1, 1, { stats: null }), awardAgent('b', 1, 2)])] },
];
write('awards-score', scoreCases.map((c) => ({ ...c, date: '2026-10-03', expected: bestToday(c.desks, '2026-10-03') })));

// AwardBook: a day-by-day script (TZ is pinned to UTC above, so `new Date(iso)` has UTC local fields).
const bookDir = mkdtempSync(path.join(tmpdir(), 'od-golden-'));
const bookSteps: { now: string; desks: OfficeDesk[] }[] = [
  { now: '2026-10-03T10:00:00Z', desks: [awardDesk('w', [awardAgent('a', 3, 5)])] },
  { now: '2026-10-03T10:00:30Z', desks: [awardDesk('w', [awardAgent('b', 1, 1)])] },
  { now: '2026-10-03T11:00:00Z', desks: [awardDesk('w', [awardAgent('a', 3, 9)])] },
  { now: '2026-10-03T11:30:00Z', desks: [awardDesk('w', [awardAgent('a', 3, 2)])] },
  { now: '2026-10-03T12:00:00Z', desks: [awardDesk('w', [awardAgent('b', 4, 0)])] },
  { now: '2026-10-03T23:59:59Z', desks: [] },
  { now: '2026-10-04T00:00:00Z', desks: [] },
  { now: '2026-10-04T09:00:00Z', desks: [awardDesk('w', [awardAgent('c', 1, 1)])] },
  { now: '2026-10-05T09:00:00Z', desks: [awardDesk('w', [awardAgent('d', 2, 2)])] },
  { now: '2026-10-05T09:01:00Z', desks: [] },
];
const book = new AwardBook(path.join(bookDir, 'awards.json'));
await book.load();
write('awards-book', {
  steps: bookSteps.map((s) => {
    const changed = book.update(s.desks, new Date(s.now));
    return { ...s, expected: { changed, board: structuredClone(book.current) } };
  }),
});
// A full hall (90) and the file formats AwardBook.load accepts.
const award90 = (i: number) => ({ date: `2020-01-${String(i).padStart(3, '0')}`, agentId: 'a', deskId: 'r::/w', name: 'n', repo: 'web', repoId: 'r', agentType: 'claude', instructions: 1, toolCalls: 0, score: 10 });
const capBook = new AwardBook(path.join(bookDir, 'cap.json'));
const capInitial = { leader: award90(999), hall: Array.from({ length: 95 }, (_, i) => award90(i)) };
writeFileSync(path.join(bookDir, 'cap.json'), JSON.stringify(capInitial));
await capBook.load();
const capChanged = capBook.update([], new Date('2026-10-03T00:00:00Z'));
write('awards-cap', { initial: capInitial, now: '2026-10-03T00:00:00Z', changed: capChanged, board: capBook.current });
write('awards-local-date', ['2026-10-03T00:00:00Z', '2026-10-03T23:59:59.999Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z', '2024-02-29T12:00:00Z', '2026-03-29T01:30:00Z'].map((iso) => ({ iso, expected: localDate(new Date(iso)) })));

// Request/response samples (the wire types the new modules serve).
write('wire-answer', {
  request: { agentId: 'tab1:leaf1', toolUseId: 'toolu_1', choices: [[1], [0, 2]] } satisfies AnswerRequest,
  ok: { ok: true },
  errors: [
    { error: '질문을 찾지 못했습니다' },
    { error: '이미 답했거나 취소된 질문입니다' },
    { error: '답을 입력하는 중입니다' },
    { error: 'unknown agent' },
    { error: '에이전트가 지금 새 메시지를 받을 수 없는 상태예요 (질문·권한 확인 중이거나 화면 전환 중). 잠시 후 다시 보내기를 눌러 주세요', code: 'agent_busy', requestId: 'req-1' },
    { error: '에이전트 터미널에 메뉴가 열려 있어 메시지가 전달되지 않습니다', code: 'menu_open' },
  ],
  hireOk: { ok: true, warning: 'worktree 생성 후 시작 지연' },
});
write('wire-upload', {
  sends: [
    { terminalHandle: 'h1', text: 'look' } satisfies SendRequest,
    { terminalHandle: 'h1', text: '', images: [{ mediaType: 'image/png', data: 'iVBORw==' }], force: true } satisfies SendRequest,
    { terminalHandle: 'h1', text: 'x', images: [], force: false } satisfies SendRequest,
  ],
  imageTypes: IMAGE_TYPES,
  limits: { maxImages: MAX_IMAGES, maxImageBytes: MAX_IMAGE_BYTES },
  uploadPath: ['123-abcd1234.png', 'a_b-C9.jpg', '1.gif', 'x.webp', '../secret.png', 'a.exe', '', '.png', 'a/b.png', 'a\\b.png', 'a.png\n', 'a b.png', 'a.PNG', 'a.jpeg', '한글.png', 'a.b.png'].map((name) => ({ name, expected: uploadPath(name, '/up') === null ? null : name })),
  compose: [['  look at this ', ['/p/a.png']], ['', ['/p/a.png']], ['  hi  ', []], ['a', ['/p/1.png', '/p/2.png']], ['', []], [' x ', ['/p/a.png']]].map(([text, paths]) => ({ text, paths, expected: composePrompt(text as string, paths as string[]) })),
  // Decoded bytes of base64 strings (Node's lenient decoder) as hex.
  base64: ['aGVsbG8=', 'aGVs\nbG8', '-_-_', '+/+/', 'aGVsbG8=junk', 'a', 'a$b!c', '', 'iVBORw==', '////'].map((data) => ({ data, expectedHex: Buffer.from(data, 'base64').toString('hex') })),
  errors: [
    { error: '이미지는 한 번에 6장까지 보낼 수 있습니다' },
    { error: '지원하지 않는 이미지 형식입니다 (png, jpg, gif, webp)' },
    { error: '이미지가 비어 있거나 10MB를 넘습니다' },
    { error: '업로드 폴더가 올바르지 않습니다' },
    { error: '업로드 폴더의 소유자가 다릅니다' },
  ],
});

// listCommands over a fixture home. Everything is created in a temp dir; paths inside
// installed_plugins.json are written as "<HOME>/..." and expanded by the Rust test.
const cmdHome = mkdtempSync(path.join(tmpdir(), 'od-golden-home-'));
const cmdProj = mkdtempSync(path.join(tmpdir(), 'od-golden-proj-'));
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const fixtureFiles: Record<string, string> = {
  'home/.claude/commands/git/push.md': '---\ndescription: Push it\n---',
  'home/.claude/commands/git/deep/nested.md': '# Nested heading\n\nbody',
  'home/.claude/commands/plain.md': 'Just a first line',
  'home/.claude/commands/quoted.md': '---\r\ndescription: \'single "quoted"\'\r\n---\r\n',
  'home/.claude/commands/folded.md': '---\ndescription: >-\n  line one\n  line two\nother: 1\n---',
  'home/.claude/commands/empty.md': '',
  'home/.claude/commands/Zeta.md': 'upper case',
  'home/.claude/commands/alpha_beta.md': 'underscore',
  'home/.claude/commands/alpha-beta.md': 'dash',
  'home/.claude/commands/help.md': 'shadowed by the built-in',
  'home/.claude/commands/notes.txt': 'not a command',
  'home/.claude/commands/한글.md': '한글 설명',
  'home/.claude/commands/éclair.md': 'accent',
  'home/.claude/commands/eclair.md': 'plain e',
  'home/.claude/commands/10-ten.md': 'ten',
  'home/.claude/commands/2-two.md': 'two',
  'home/.claude/skills/browse/SKILL.md': '---\nname: browse\ndescription: Browser\n---',
  'home/.claude/skills/dirname-only/SKILL.md': '---\ndescription: uses the dir name\n---',
  'home/.claude/skills/empty-skill/SKILL.md': '',
  'home/.claude/skills/no-skill-file/README.md': 'x',
  'proj/.claude/commands/same.md': 'from project',
  'home/.claude/commands/same.md': 'from user',
  'proj/.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship\n---',
  'home/plugins/sp/skills/brainstorming/SKILL.md': '---\nname: brainstorming\ndescription: Think\n---',
  'home/plugins/sp/commands/go.md': '---\ndescription: Go plugin\n---',
  'home/plugins/off/skills/hidden/SKILL.md': '---\nname: hidden\n---',
  'home/.codex/prompts/fix.md': 'Fix the failing test',
  'home/.codex/prompts/review/deep.md': '---\ndescription: nested prompt\n---',
};
for (const [rel, text] of Object.entries(fixtureFiles)) put(path.join(rel.startsWith('home/') ? cmdHome : cmdProj, rel.replace(/^(home|proj)\//, '')), text);
const pluginsJson = { plugins: { 'superpowers@x': [{ installPath: '<HOME>/plugins/sp' }], 'off@x': [{ installPath: '<HOME>/plugins/off' }] } };
const expandHome = (s: string) => s.replaceAll('<HOME>', cmdHome.replaceAll('\\', '/'));
put(path.join(cmdHome, '.claude/plugins/installed_plugins.json'), expandHome(JSON.stringify(pluginsJson)));
put(path.join(cmdHome, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'off@x': false } }));
const listCases = [['claude', 'proj'], ['codex', 'proj'], ['gemini', 'proj'], ['claude', 'nowhere'], ['codex', 'nowhere']].map(([agentType, where]) => ({
  agentType,
  project: where,
  expected: [] as unknown[],
}));
for (const c of listCases) c.expected = await listCommands(c.agentType, c.project === 'proj' ? cmdProj : path.join(cmdProj, 'nowhere'), cmdHome);
const emptyHome = mkdtempSync(path.join(tmpdir(), 'od-golden-empty-'));
write('commands-list', {
  files: fixtureFiles,
  installedPlugins: pluginsJson,
  settings: { enabledPlugins: { 'off@x': false } },
  cases: listCases,
  emptyHome: { claude: await listCommands('claude', path.join(emptyHome, 'p'), emptyHome), codex: await listCommands('codex', path.join(emptyHome, 'p'), emptyHome) },
  frontMatter: [
    '---\nname: browse\ndescription: "Fast browser"\n---\n',
    '---\nname: x\ndescription: >-\n  line one\n  line two\nother: 1\n---',
    '# Deploy the app\n\nsteps',
    "---\r\nname: 'a b'\r\ndescription: |\r\n  x\r\n  y\r\n---\r\n",
    '---\nname: a\nname: b\n---',
    '---\nname:\n---',
    '---\nname: "a\'\n---',
    '---\nname: "\n---',
    '---\n---\nx',
    '\n  \n##   Title  \nbody',
    '',
    '   \n\n',
    '---\n  name: no\nother: 1\n---',
    '---\ndescription: >\nname: n\n---',
    '---\nname: a # comment\ndescription:   spaced   \n---',
  ].map((text) => ({ text, expected: frontMatter(text) })),
});

// Dialog screens: currentQuestion / isReviewScreen / validateChoices, and the full key sequence
// answerQuestions presses against a scripted terminal.
const aq = (header: string, question: string, multiSelect: boolean, labels: string[]): AskedQuestion => ({ header, question, multiSelect, options: labels.map((label) => ({ label, description: '' })) });
const ansQs = [aq('Color', 'Which color?', false, ['Red', 'Blue']), aq('Sizes', 'Which sizes?', true, ['Small', 'Medium', 'Large'])];
const arule = '─'.repeat(40);
const aq1 = ['❯ Use AskUserQuestion: Which color? Which sizes?', arule, '←  ☐ Color  ☐ Sizes  ✔ Submit  →', 'Which color?', '❯ 1. Red', '     warm', '  2. Blue', '  3. Type something.', arule, '  4. Chat about this'];
const aq2 = [arule, '←  ☒ Color  ☐ Sizes  ✔ Submit  →', 'Which sizes?', '❯ 1. [ ] Small', '  2. [ ] Medium', '  3. [ ] Large', '     Submit', arule];
const areview = ['←  ☒ Color  ☒ Sizes  ✔ Submit  →', 'Review your answers', ' ● Which color?', '   → Blue', 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'];
const adone = ['⏺ Blue; Small, Large', arule, '❯ ', arule];
const asingle = [
  '──────────────────────────────     +— they stay on the top floor. */',
  ' ☐ 캡처 테스트                                                  37 +export function zoneOf(desk',
  '│ [화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에       38 +  if (desk.agents',
  '│ 터미널에서 아무거나 골라 주세요.                                  +d))) return',
  '                                                                   39    return desk',
  '❯ 1. 확인                                                          40  }',
  '  2. 다시                                                          39 -export function recency',
  '  3. Type something.',
];
const screensForAnswer: Record<string, string[]> = {
  q1: aq1, q2: aq2, review: areview, done: adone, single: asingle,
  'header without options': [' ☐ Header', 'Question?'],
  'header with option': [' ☐ Header', 'Question?', '  1. Yes'],
  'wrapped and indented': ['←  ☐ A  →', '│ first  line', '      other pane', 'second', '1. x'],
  'review half': ['Ready to submit your answers?'],
  'review spaced': ['Ready to submit your answers?', '  12.Submit answers'],
  empty: [],
};
const choiceCases: { name: string; choices: unknown }[] = [
  { name: 'ok', choices: [[1], [0, 2]] }, { name: 'short', choices: [[1]] }, { name: 'two on single', choices: [[0, 1], [0]] }, { name: 'empty multi', choices: [[1], []] },
  { name: 'out of range', choices: [[5], [0]] }, { name: 'duplicate', choices: [[1], [0, 0]] }, { name: 'not a list', choices: 'x' }, { name: 'null', choices: null },
  { name: 'entry not a list', choices: [1, [0]] }, { name: 'string index', choices: [['0'], [0]] }, { name: 'negative', choices: [[-1], [0]] }, { name: 'fraction', choices: [[0.5], [0]] },
  { name: 'null index', choices: [[null], [0]] }, { name: 'whole float', choices: [[1.0], [0.0, 2]] }, { name: 'empty single', choices: [[], [0]] },
];
const wide = aq('', 'Pick?', false, Array.from({ length: 10 }, (_, i) => String(i)));
const scripted = async (questions: AskedQuestion[], choices: number[][], first: string[], step: (screen: string[], key: TerminalKey) => string[] | null) => {
  let screen = first;
  const pressed: TerminalKey[] = [];
  const slept: number[] = [];
  let t = 0;
  const realNow = Date.now;
  Date.now = () => (t += 1000);
  let error: string | null = null;
  try {
    await answerQuestions(
      { readScreen: async () => screen, sleep: async (ms) => void slept.push(ms), press: async (k) => { pressed.push(k); screen = step(screen, k) ?? screen; } },
      questions,
      choices,
    );
  } catch (e) {
    error = (e as Error).message;
  } finally {
    Date.now = realNow;
  }
  return { pressed, slept, error };
};
const walkDialog = (screen: string[], k: TerminalKey) => (screen === aq1 && /^\d$/.test(k) ? aq2 : screen === aq2 && k === 'right' ? areview : screen === areview && k === '1' ? adone : null);
write('answer-driver', {
  questions: ansQs,
  screens: Object.entries(screensForAnswer).map(([name, lines]) => ({ name, lines, currentQuestion: currentQuestion(lines), isReview: isReviewScreen(lines) })),
  validate: [
    ...choiceCases.map((c) => ({ name: c.name, questions: ansQs, choices: c.choices, expected: validateChoices(ansQs, c.choices) })),
    { name: 'wide empty', questions: [wide], choices: [[]], expected: validateChoices([wide], [[]]) },
    { name: 'wide', questions: [wide], choices: [[0]], expected: validateChoices([wide], [[0]]) },
  ],
  runs: [
    { name: 'full walk', questions: ansQs, choices: [[1], [0, 2]], first: 'q1', result: await scripted(ansQs, [[1], [0, 2]], aq1, walkDialog) },
    { name: 'question not on screen', questions: ansQs, choices: [[1], [0]], first: 'done', result: await scripted(ansQs, [[1], [0]], adone, () => null) },
    { name: 'never reaches review', questions: [ansQs[0]], choices: [[0]], first: 'q1', result: await scripted([ansQs[0]], [[0]], aq1, () => null) },
    { name: 'single question submits at once', questions: [aq('캡처 테스트', '[화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에 터미널에서 아무거나 골라 주세요.', false, ['확인', '다시'])], choices: [[1]], first: 'single', result: await scripted([aq('캡처 테스트', '[화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에 터미널에서 아무거나 골라 주세요.', false, ['확인', '다시'])], [[1]], asingle, () => adone) },
  ],
});

console.log(`golden: wrote ${readdirSync(fileURLToPath(outDir)).length} files to ${fileURLToPath(outDir)}`);
