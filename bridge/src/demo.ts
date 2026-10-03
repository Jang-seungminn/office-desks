import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentStats, Award, OrgChart } from './model.js';
import { localDate } from './awards.js';
import type { OrcaRunner } from './orcaCli.js';

// A fake Orca for `npm run demo`: several repos, some with many worktrees, agents whose
// states rotate over time. Lets you see (and screenshot) busy offices without real agents.

interface DemoAgent {
  pane: string;
  type: string;
  states: [state: string, tool: string | null, input: string | null][];
}

interface DemoWorktree {
  repo: string;
  repoId: string;
  name: string;
  branch: string;
  main?: boolean;
  parent?: string;
  agents: DemoAgent[];
}

const W = (repo: string, name: string, branch: string, agents: DemoAgent[], extra: Partial<DemoWorktree> = {}): DemoWorktree => ({
  repo,
  repoId: `demo-${repo}`,
  name,
  branch,
  agents,
  ...extra,
});

const A = (pane: string, type: string, states: DemoAgent['states']): DemoAgent => ({ pane, type, states });

const WORKTREES: DemoWorktree[] = [
  W('shop-web', 'shop-web', 'main', [A('p1', 'claude', [['working', 'Edit', 'src/cart/Cart.tsx'], ['working', 'Bash', 'npm test'], ['done', null, null]])], { main: true }),
  W('shop-web', 'checkout-flow', 'feat/checkout-flow', [A('p2', 'claude', [['waiting', 'ExitPlanMode', null], ['working', 'Write', 'src/checkout/Pay.tsx']])], { parent: 'shop-web' }),
  W('shop-web', 'login-bug', 'fix/login-redirect', [A('p3', 'codex', [['working', 'exec_command', 'pnpm vitest login'], ['working', 'Read', 'src/auth/session.ts']])], { parent: 'shop-web' }),
  W('shop-web', 'deps-bump', 'chore/deps-bump', []),
  W('api-server', 'api-server', 'main', [A('p4', 'codex', [['working', 'Grep', 'rateLimit'], ['done', null, null]])], { main: true }),
  W('api-server', 'rate-limit', 'feat/rate-limit', [
    A('p5', 'claude', [['working', 'Edit', 'internal/limiter/bucket.go'], ['waiting', 'Bash', 'go test ./...']]),
    A('p6', 'claude', [['working', 'WebSearch', 'token bucket redis lua'], ['working', 'Read', 'docs/limits.md']]),
  ]),
  W('docs', 'docs', 'main', [A('p7', 'gemini', [['done', null, null], ['working', 'Edit', 'guide/intro.md']])], { main: true }),
  // Finished a while ago: these take a break in the lounge.
  W('docs', 'faq-rewrite', 'docs/faq-rewrite', [A('p8', 'claude', [['done', null, null]]), A('p9', 'claude', [['done', null, null]])]),
  W('api-server', 'perf-tuning', 'perf/query-cache', [A('p10', 'codex', [['done', null, null]])]),
];

const START = Date.now();

function worktreePs(now: number) {
  const tick = Math.floor((now - START) / 8000);
  return {
    worktrees: WORKTREES.map((w) => {
      const agents = w.agents.map((a, i) => {
        const [state, toolName, toolInput] = a.states[(tick + i) % a.states.length];
        return {
          paneKey: `${a.pane}:leaf`,
          agentType: a.type,
          state,
          toolName,
          toolInput,
          prompt: `Demo task for ${w.branch}`,
          lastAssistantMessage: state === 'done' ? `${w.branch} 작업을 끝냈습니다. 테스트 통과.` : null,
          // Agents with a single 'done' state finished long ago (they rest in the lounge).
          stateStartedAt: a.states.length === 1 ? START - 20 * 60_000 : START + tick * 8000,
        };
      });
      const waiting = agents.some((a) => a.state === 'waiting');
      const working = agents.some((a) => a.state === 'working');
      return {
        worktreeId: `${w.repoId}::/demo/${w.repo}/${w.name}`,
        repoId: w.repoId,
        repo: w.repo,
        path: `/demo/${w.repo}/${w.name}`,
        branch: `refs/heads/${w.branch}`,
        displayName: w.name,
        isMainWorktree: Boolean(w.main),
        parentWorktreeId: w.parent ? `${w.repoId}::/demo/${w.repo}/${w.parent}` : null,
        status: waiting ? 'permission' : working ? 'working' : agents.length ? 'active' : 'inactive',
        lastActivityAt: START - WORKTREES.indexOf(w) * 60_000,
        workspaceStatus: 'in-progress',
        comment: w.name === 'checkout-flow' ? '결제 플로우 플랜 승인 대기' : '',
        agents,
      };
    }),
  };
}

function terminalList() {
  return {
    terminals: WORKTREES.flatMap((w) => w.agents.map((a) => ({ handle: `demo_${a.pane}`, tabId: a.pane, leafId: 'leaf', title: `✳ ${w.branch}` }))),
  };
}

/** Write a small fake transcript per demo agent so the chat panel has something to show. */
function writeDemoTranscripts(): Map<string, string> {
  const dir = path.join(os.tmpdir(), 'office-desks-demo');
  mkdirSync(dir, { recursive: true });
  const files = new Map<string, string>();
  const L = (o: unknown) => JSON.stringify(o);
  const t = (min: number) => new Date(START - min * 60_000).toISOString();
  for (const w of WORKTREES) {
    for (const a of w.agents) {
      const lines = [
        L({ type: 'ai-title', aiTitle: `${w.branch} 작업` }),
        L({ type: 'user', timestamp: t(30), message: { role: 'user', content: `Demo task for ${w.branch}` } }),
        L({
          type: 'assistant',
          timestamp: t(29),
          effort: 'high',
          message: {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: `**${w.branch}** 작업을 시작합니다.\n\n1. 코드 읽기\n2. 수정\n3. 테스트\n\n\`\`\`ts\nexport const ok = true;\n\`\`\`` }],
          },
        }),
        L({ type: 'assistant', timestamp: t(28), message: { role: 'assistant', content: [{ type: 'tool_use', id: `r-${a.pane}`, name: 'Read', input: { file_path: 'src/index.ts' } }] } }),
        L({
          type: 'assistant',
          timestamp: t(27),
          message: { role: 'assistant', content: [{ type: 'tool_use', id: `sa-${a.pane}`, name: 'Agent', input: { description: '관련 파일 찾기', subagent_type: 'Explore' } }] },
        }),
      ];
      if (a.pane === 'p5' || a.pane === 'p2') {
        lines.push(
          L({
            type: 'assistant',
            timestamp: t(1),
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: `ask-${a.pane}`,
                  name: 'AskUserQuestion',
                  input: {
                    questions: [
                      {
                        header: '저장소',
                        question: '레이트 리밋 카운터를 어디에 둘까요?',
                        multiSelect: false,
                        options: [
                          { label: 'Redis', description: '여러 서버가 공유, 운영 부담 조금' },
                          { label: '메모리', description: '가장 간단, 서버마다 따로 셈' },
                        ],
                      },
                      {
                        header: '대상',
                        question: '어떤 API에 적용할까요?',
                        multiSelect: true,
                        options: ['로그인', '검색', '결제'].map((label) => ({ label, description: '' })),
                      },
                    ],
                  },
                },
              ],
            },
          }),
        );
      }
      const file = path.join(dir, `${a.pane}.jsonl`);
      writeFileSync(file, lines.join('\n') + '\n');
      // Search is per worktree + agent type, so the first agent of a kind owns the demo transcript.
      const key = `/demo/${w.repo}/${w.name}|${a.type}`;
      if (!files.has(key)) files.set(key, file);
    }
  }
  return files;
}

export function createDemoRunner(): OrcaRunner {
  const transcripts = writeDemoTranscripts();
  return async (args) => {
    const [a, b] = args;
    if (a === 'worktree' && b === 'ps') return worktreePs(Date.now());
    if (a === 'terminal' && b === 'list') return terminalList();
    if (a === 'terminal' && b === 'read') {
      // Waiting agents show a permission dialog; everyone else shows Claude's normal input box.
      const pane = String(args[args.indexOf('--terminal') + 1] ?? '').replace(/^demo_/, '');
      const agent = worktreePs(Date.now()).worktrees.flatMap((w) => w.agents).find((x) => x.paneKey.startsWith(`${pane}:`));
      const rule = '─'.repeat(48);
      const rule2 = '─'.repeat(48);
      const asking = agent?.state === 'waiting' && (pane === 'p5' || pane === 'p2');
      const tail = asking
        ? ['(demo)', rule2, '←  ☐ 저장소  ☐ 대상  ✔ Submit  →', '레이트 리밋 카운터를 어디에 둘까요?', '❯ 1. Redis', '  2. 메모리', '  3. Type something.', rule2]
        : agent?.state === 'waiting'
          ? ['(demo) Bash command', '', '  go test ./...', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently', '', 'Esc to cancel']
          : ['(demo) ⏺ 작업 중입니다…', '', rule, '❯ ', rule, '  ⏵⏵ auto mode on'];
      return { terminal: { tail, source: 'screen' } };
    }
    if (a === 'search') {
      const opt = (name: string) => args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
      const cwd = opt('path');
      const file = transcripts.get(`${cwd}|${opt('agent')}`);
      return { hits: file ? [{ title: 'demo', cwd, source: { presence: 'present', filePath: file } }] : [] };
    }
    if (a === 'account' && b === 'list') {
      const in3h = Date.now() + 3 * 3600_000;
      const in4d = Date.now() + 4 * 86400_000;
      return {
        rateLimits: {
          claude: {
            provider: 'claude',
            status: 'ok',
            session: { usedPercent: 62, windowMinutes: 300, resetsAt: in3h, resetDescription: '3:00 PM' },
            weekly: { usedPercent: 21, windowMinutes: 10080, resetsAt: in4d, resetDescription: 'Fri 4:00 AM' },
            fableWeekly: { usedPercent: 9, windowMinutes: 10080, resetsAt: in4d, resetDescription: 'Fri 4:00 AM' },
          },
          codex: { provider: 'codex', status: 'unavailable', session: null, weekly: null },
        },
      };
    }
    return { ok: true };
  };
}

/** What the bridge would learn from demo transcripts: running subagents, model, effort. */
export function demoOrg(): OrgChart {
  return {
    departments: [
      { id: 'd-dev', name: '쇼핑 개발팀', theme: 'dev', repoIds: ['demo-shop-web'] },
      { id: 'd-ops', name: '플랫폼팀', theme: 'ops', repoIds: ['demo-api-server'] },
      { id: 'd-doc', name: '기획·문서팀', theme: 'design', repoIds: ['demo-docs'] },
    ],
  };
}

export function demoEnrichment(agentId: string): { subagentsRunning: number; model: string; effort: string; stats: AgentStats } {
  const table: Record<string, [number, string, string]> = {
    'p1:leaf': [2, 'claude-opus-5-5', 'xhigh'],
    'p2:leaf': [0, 'claude-fable-5-1', 'high'],
    'p3:leaf': [0, 'gpt-5.4', 'medium'],
    'p4:leaf': [0, 'gpt-5.4', 'high'],
    'p5:leaf': [1, 'claude-sonnet-5-5', 'medium'],
    'p6:leaf': [0, 'claude-haiku-4-5-20251001', 'low'],
    'p7:leaf': [0, 'gemini-3-pro', 'medium'],
  };
  const [subagentsRunning, model, effort] = table[agentId] ?? [0, 'claude-opus-5-5', 'medium'];
  const n = Number(/\d+/.exec(agentId)?.[0] ?? 1);
  const stats: AgentStats = {
    instructions: [0, 142, 37, 8, 64, 211, 19, 90][n] ?? 10,
    instructionsToday: [0, 12, 5, 2, 7, 18, 3, 4][n] ?? 1,
    toolCalls: [0, 1840, 402, 77, 690, 2650, 230, 512][n] ?? 50,
    toolCallsToday: [0, 160, 44, 12, 70, 210, 31, 25][n] ?? 5,
    subagents: [0, 31, 4, 0, 9, 44, 2, 6][n] ?? 0,
    hiredAt: new Date(START - ([0, 40, 9, 2, 21, 60, 5, 30][n] ?? 1) * 86400_000).toISOString(),
  };
  return { subagentsRunning, model, effort, stats };
}

/** A sample hall of fame for the demo; returns the awards file to use. */
export function createDemoAwards(): string {
  const dir = path.join(os.tmpdir(), 'office-desks-demo');
  mkdirSync(dir, { recursive: true });
  const day = (n: number) => localDate(new Date(START - n * 86400_000));
  const win = (n: number, pane: string, name: string, repo: string, instructions: number, toolCalls: number): Award => ({
    date: day(n),
    agentId: `${pane}:leaf`,
    deskId: `demo-${repo}::/demo/${repo}/${name}`,
    name,
    repo,
    repoId: `demo-${repo}`,
    agentType: 'claude',
    instructions,
    toolCalls,
    score: instructions * 10 + toolCalls,
  });
  const file = path.join(dir, 'awards.json');
  writeFileSync(
    file,
    JSON.stringify({
      leader: null,
      hall: [
        win(1, 'p5', 'rate-limit', 'api-server', 21, 240),
        win(2, 'p1', 'shop-web', 'shop-web', 17, 198),
        win(3, 'p2', 'checkout-flow', 'shop-web', 12, 130),
        win(4, 'p5', 'rate-limit', 'api-server', 15, 171),
      ],
    }),
  );
  return file;
}
