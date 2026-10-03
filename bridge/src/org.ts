import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Department, OrgChart } from './model.js';

// The org chart (departments and which projects sit in them) is the user's own setup, so the
// bridge keeps it in a small JSON file in their home folder: every browser sees the same office.

export const DEPARTMENT_THEMES = ['dev', 'design', 'research', 'ops', 'etc'] as const;
const MAX_DEPARTMENTS = 20;
const MAX_NAME = 20;

export function orgFile(home = os.homedir()): string {
  return path.join(home, '.office-desks', 'org.json');
}

/** Validate and normalise an org chart coming from the browser (or a hand-edited file). */
export function sanitizeOrg(raw: unknown): OrgChart | { error: string } {
  const list = (raw as { departments?: unknown })?.departments;
  if (!Array.isArray(list)) return { error: 'departments must be a list' };
  if (list.length > MAX_DEPARTMENTS) return { error: `부서는 ${MAX_DEPARTMENTS}개까지 만들 수 있어요` };
  const seenIds = new Set<string>();
  const taken = new Set<string>();
  const departments: Department[] = [];
  for (const d of list as Record<string, unknown>[]) {
    const name = typeof d?.name === 'string' ? d.name.replace(/\s+/g, ' ').trim() : '';
    if (!name || name.length > MAX_NAME) return { error: `부서 이름은 1~${MAX_NAME}자로 지어 주세요` };
    const theme = DEPARTMENT_THEMES.includes(d.theme as never) ? (d.theme as Department['theme']) : 'etc';
    let id = typeof d.id === 'string' && /^[a-z0-9-]{1,40}$/.test(d.id) ? d.id : '';
    if (!id || seenIds.has(id)) id = `d-${Math.random().toString(36).slice(2, 10)}`;
    seenIds.add(id);
    // A project sits in one department only: the first one that claims it wins.
    const repoIds = (Array.isArray(d.repoIds) ? d.repoIds : [])
      .filter((r): r is string => typeof r === 'string' && r.length > 0 && r.length <= 200)
      .filter((r) => !taken.has(r) && taken.add(r));
    departments.push({ id, name, theme, repoIds });
  }
  return { departments };
}

export async function loadOrg(file = orgFile()): Promise<OrgChart> {
  try {
    const parsed = sanitizeOrg(JSON.parse(await readFile(file, 'utf8')));
    return 'error' in parsed ? { departments: [] } : parsed;
  } catch {
    return { departments: [] };
  }
}

export async function saveOrg(org: OrgChart, file = orgFile()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(org, null, 2), { mode: 0o600 });
  try {
    await rename(tmp, file); // atomic replace
  } catch {
    // Windows: antivirus or the indexer can hold the target open (EPERM/EBUSY); write it directly.
    await writeFile(file, JSON.stringify(org, null, 2), { mode: 0o600 });
    await rm(tmp, { force: true });
  }
}
