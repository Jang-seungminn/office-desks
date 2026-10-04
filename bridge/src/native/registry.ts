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
