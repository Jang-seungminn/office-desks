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
          lastAssistantMessage: state === 'done' ? `**${w.branch}** 작업을 끝냈습니다. 테스트 통과.` : null,
          stateStartedAt: START + tick * 8000,
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

export function createDemoRunner(): OrcaRunner {
  return async (args) => {
    const [a, b] = args;
    if (a === 'worktree' && b === 'ps') return worktreePs(Date.now());
    if (a === 'terminal' && b === 'list') return terminalList();
    if (a === 'terminal' && b === 'read') {
      // Waiting agents show a permission dialog; everyone else shows Claude's normal input box.
      const pane = String(args[args.indexOf('--terminal') + 1] ?? '').replace(/^demo_/, '');
      const agent = worktreePs(Date.now()).worktrees.flatMap((w) => w.agents).find((x) => x.paneKey.startsWith(`${pane}:`));
      const rule = '─'.repeat(48);
      const tail =
        agent?.state === 'waiting'
          ? ['(demo) Bash command', '', '  go test ./...', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently', '', 'Esc to cancel']
          : ['(demo) ⏺ 작업 중입니다…', '', rule, '❯ ', rule, '  ⏵⏵ auto mode on'];
      return { terminal: { tail, source: 'screen' } };
    }
    if (a === 'search') return { hits: [] };
    return { ok: true };
  };
}

/** Demo agents that have subagents working (Orca has no notion of these; the bridge adds them). */
export function demoSubagentsRunning(agentId: string): number {
  return ({ 'p1:leaf': 2, 'p5:leaf': 1 } as Record<string, number>)[agentId] ?? 0;
}
