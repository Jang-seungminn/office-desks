// The E2E hook (Task 9): read-only views of the workspace. Never exposes the term config.
import { isE2E } from './host';
import type { Workspace } from './workspace';

export interface GongbangDebug {
  text(agentId: string): string;
  tabs(): string[];
  active(): string | null;
  split(): string | null;
}

export function installDebug(workspace: Workspace, w: Window = window): void {
  if (!isE2E()) return;
  const hook: GongbangDebug = {
    text: (agentId) => workspace.text(agentId),
    tabs: () => workspace.state.tabs.map((t) => t.agentId),
    active: () => workspace.state.active,
    split: () => workspace.state.split,
  };
  (w as unknown as { __gongbang?: GongbangDebug }).__gongbang = hook;
}
