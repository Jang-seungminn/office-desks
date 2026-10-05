// The app UI against the in-process server (the Rust harness), with the fake agent and a fake
// Tauri host. One page per project, kept across the serial steps (tabs and agents carry over).
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, test, type BrowserContext, type Page, type Response } from '@playwright/test';
import { useFakeHost } from './fakeHost';
import { agentPids, alive, FORBIDDEN_PORTS, type HarnessInfo } from './harness';

declare global {
  interface Window {
    __gongbang: { text(id: string): string; tabs(): string[]; active(): string | null; split(): string | null };
    __officeOpened: number;
  }
}

const info = JSON.parse(process.env.GONGBANG_E2E ?? 'null') as HarnessInfo;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control+Shift';
const POLL = { timeout: 10_000 };

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
/** Every HTTP response the page received and every WebSocket frame, checked for the token. */
const scans: Promise<void>[] = [];
const leaks: string[] = [];
const seen: string[] = [];

function scan(where: string, text: string): void {
  if (text.includes(info.token)) leaks.push(where);
}

function watch(r: Response): void {
  seen.push(r.url());
  scans.push(
    (async () => {
      for (const h of await r.headersArray()) scan(`header ${h.name} of ${r.url()}`, h.value);
      let body: Buffer | null = null;
      try {
        body = await r.body();
      } catch {
        // no body (a redirect, a 204, a page that moved on)
      }
      if (body) scan(`body of ${r.url()}`, body.toString('latin1'));
    })(),
  );
}

async function noLeaks(): Promise<void> {
  await Promise.all(scans.splice(0));
  expect(leaks).toEqual([]);
}

const term = (agentId: string): Promise<string> => page.evaluate((id) => window.__gongbang.text(id), agentId);
const active = (): Promise<string | null> => page.evaluate(() => window.__gongbang.active());
const split = (): Promise<string | null> => page.evaluate(() => window.__gongbang.split());
const newestPid = (): number => {
  const pids = agentPids(info.out);
  expect(pids.length).toBeGreaterThan(0);
  return pids[pids.length - 1];
};

function worktree(name: string) {
  return page.locator('.worktree', { has: page.getByText(`🌿 ${name}`, { exact: true }) });
}

async function deskPath(name: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${info.port}/api/snapshot`);
  const s = (await r.json()) as { desks: { name: string; path: string }[] };
  const d = s.desks.find((x) => x.name === name);
  expect(d, `desk ${name} in the snapshot`).toBeTruthy();
  return d!.path;
}

/** The keyboard goes to the visible terminal (xterm's textarea in the active pane). */
async function terminalFocused(): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const a = document.activeElement;
          return !!a && a.classList.contains('xterm-helper-textarea') && !!a.closest('.pane:not([hidden])');
        }),
      POLL,
    )
    .toBe(true);
}

/** ⌘T / Ctrl+Shift+T, fill the name, keep claude, 만들기. */
async function newWork(name: string): Promise<void> {
  await page.keyboard.press(`${mod}+KeyT`);
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  await modal.getByLabel('워크트리 이름 (브랜치 이름이 됩니다)').fill(name);
  await expect(modal.getByLabel('에이전트')).toHaveValue('claude');
  await modal.getByRole('button', { name: '만들기' }).click();
}

/** ⏹ 중지 on the agent's row, then the modal's confirm; the row goes and the process ends. */
async function stopAgent(agentId: string, pid: number): Promise<void> {
  await page.locator(`[data-stop="${agentId}"]`).click();
  await page.locator('.modal').getByRole('button', { name: '⏹ 중지' }).click();
  await expect(page.locator(`.agent-open[data-agent="${agentId}"]`)).toHaveCount(0, POLL);
  await expect.poll(() => alive(pid), POLL).toBe(false);
}

test.beforeAll(async ({ browser }) => {
  expect(info, 'GONGBANG_E2E from the global setup').toBeTruthy();
  expect(FORBIDDEN_PORTS).not.toContain(info.port);
  context = await browser.newContext();
  page = await context.newPage();
  page.on('response', watch);
  page.on('websocket', (ws) => ws.on('framereceived', (f) => scan(`a frame on ${ws.url().split('?')[0]}`, String(f.payload))));
});

test.afterAll(async () => {
  await context?.close();
});

let agent1 = '';
let pid1 = 0;
let agent2 = '';
let pid2 = 0;

test('never serves the token', async () => {
  await useFakeHost(page, info);
  await expect(page.locator('.sidebar h1')).toHaveText('공방');
  await noLeaks();
  expect(seen.some((u) => u.endsWith('/app/'))).toBe(true);
  expect(seen.some((u) => /\/app\/assets\/.+\.js$/.test(u))).toBe(true);
  // No inline script: an indirect check that the app runs under `script-src 'self'`.
  await expect(page.locator('script:not([src])')).toHaveCount(0);
});

test('adds a project with the folder picker', async ({}, testInfo) => {
  // The first project adds it; the next one finds it already there (same server).
  if (testInfo.project.name === 'chromium') await page.getByRole('button', { name: '＋ 프로젝트' }).click();
  await expect(page.locator('.project-name')).toHaveText(`📁 ${basename(info.repo)}`, POLL);
  // The main checkout's row: named after the folder, on branch main.
  const main = page.locator('.worktree-head', { has: page.locator('.worktree-name', { hasText: '🏠' }) });
  await expect(main.locator('.worktree-name')).toHaveText(`🏠 ${basename(info.repo)}`);
  await expect(main.locator('.branch')).toHaveText('main');
});

test('new work opens a live terminal', async ({}, testInfo) => {
  const name = `e2e-${testInfo.project.name}-1`;
  await newWork(name);
  await expect(page.locator('.tab.active .tab-title')).toHaveText(`${name} · claude`, { timeout: 15_000 });
  agent1 = (await active())!;
  expect(agent1).toBeTruthy();
  await expect.poll(() => term(agent1), POLL).toContain('FAKE AGENT READY');
  await terminalFocused();
  await page.keyboard.type('hello');
  await page.keyboard.press('Enter');
  await expect.poll(() => term(agent1), POLL).toContain('got:hello');
});

test('closing a tab detaches', async () => {
  pid1 = newestPid();
  expect(alive(pid1)).toBe(true);
  await page.keyboard.press(`${mod}+KeyW`);
  await expect(page.locator(`.tab[data-agent="${agent1}"]`)).toHaveCount(0);
  const row = page.locator(`.agent-open[data-agent="${agent1}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.state')).not.toBeEmpty();
  expect(alive(pid1)).toBe(true);
  await row.click();
  await expect(page.locator(`.tab.active[data-agent="${agent1}"]`)).toBeVisible();
  // The server replays the screen snapshot on attach.
  await expect.poll(() => term(agent1), POLL).toContain('got:hello');
});

test('add agent and split', async ({}, testInfo) => {
  const name = `e2e-${testInfo.project.name}-1`;
  await worktree(name).getByRole('button', { name: '🧑 에이전트 추가' }).click();
  await page.locator('.modal').getByRole('button', { name: '에이전트 띄우기' }).click();
  await expect(page.locator('.tab')).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(active, POLL).not.toBe(agent1);
  agent2 = (await active())!;
  pid2 = newestPid();
  expect(pid2).not.toBe(pid1);
  await expect.poll(() => term(agent2), POLL).toContain('FAKE AGENT READY');

  await page.keyboard.press(`${mod}+Digit1`);
  await expect.poll(active, POLL).toBe(agent1);
  await page.keyboard.press(`${mod}+Backslash`);
  await expect(page.locator('.pane:visible')).toHaveCount(2);
  expect(await split()).toBe(agent2);
  await page.keyboard.press(`${mod}+Backslash`);
  await expect(page.locator('.pane:visible')).toHaveCount(1);
  expect(await split()).toBeNull();
});

test('sidebar toggles', async () => {
  await page.keyboard.press(`${mod}+KeyB`);
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.keyboard.press(`${mod}+KeyB`);
  await expect(page.locator('.sidebar')).toBeVisible();
});

test('office button', async () => {
  await page.getByRole('button', { name: '🏢 사무실' }).click();
  await expect.poll(() => page.evaluate(() => window.__officeOpened), POLL).toBe(1);
});

test('remove refuses while agents run', async ({}, testInfo) => {
  const name = `e2e-${testInfo.project.name}-1`;
  const path = await deskPath(name);
  await worktree(name).getByRole('button', { name: '🗑 워크트리 삭제' }).click();
  await page.locator('.modal').getByRole('button', { name: '🗑 지우기' }).click();
  await expect(page.locator('.toast.error')).toHaveText('⚠️ 먼저 에이전트를 ⏹ 중지해 주세요 (실행 중인 에이전트가 있어요)');
  expect(existsSync(path)).toBe(true);
  await expect(worktree(name)).toBeVisible();
});

test('stop asks first', async () => {
  await page.locator(`[data-stop="${agent1}"]`).click();
  await page.locator('.modal').getByRole('button', { name: '취소' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator(`.agent-open[data-agent="${agent1}"]`)).toBeVisible();
  expect(alive(pid1)).toBe(true);

  await stopAgent(agent1, pid1);
  await expect(page.locator(`.pane[data-agent="${agent1}"] .term-banner`)).toContainText('에이전트가 종료됐어요', POLL);
  await stopAgent(agent2, pid2);
  await expect(page.locator(`.pane[data-agent="${agent2}"] .term-banner`)).toContainText('에이전트가 종료됐어요', POLL);
});

test('remove after stop', async ({}, testInfo) => {
  const name = `e2e-${testInfo.project.name}-1`;
  const path = await deskPath(name);
  await worktree(name).getByRole('button', { name: '🗑 워크트리 삭제' }).click();
  await page.locator('.modal').getByRole('button', { name: '🗑 지우기' }).click();
  await expect(worktree(name)).toHaveCount(0, POLL);
  await expect.poll(() => existsSync(path), POLL).toBe(false);
});

test('errors show in Korean', async ({}, testInfo) => {
  const name = `e2e-${testInfo.project.name}-2`;
  await newWork(name);
  await expect(page.locator('.tab.active .tab-title')).toHaveText(`${name} · claude`, { timeout: 15_000 });
  await expect(worktree(name)).toBeVisible();
  const agent = (await active())!;
  const pid = newestPid();
  await expect.poll(() => term(agent), POLL).toContain('FAKE AGENT READY');

  await newWork(name);
  await expect(page.locator('.toast.error', { hasText: '같은 이름의 워크트리가 이미 있어요' })).toBeVisible();

  // Leave only clean exits for the teardown's check.
  await stopAgent(agent, pid);
});

test('nothing served during the run carried the token', async () => {
  await noLeaks();
});
