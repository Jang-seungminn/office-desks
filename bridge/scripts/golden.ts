// Writes crates/od-core/tests/golden/*.json from the real TS code. The Rust tests
// deserialize and re-serialize each file, so wire shapes stay identical to the bridge.
// Run: npm run golden
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AwardBoard, BackendInfo, OrgChart, ServerMessage, UsageSnapshot } from '../src/model.js';
import { toSnapshot } from '../src/stateMapper.js';

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
console.log(`golden: wrote ${3 + Object.keys(messages).length} files to ${fileURLToPath(outDir)}`);
