// Which agent each pane slot shows, which pane has focus, and each pane's scrollback offset.
import type { Preset } from './layout.js';

export class PaneSet {
  preset: Preset;
  focused = 0;
  readonly agents: (string | null)[] = [null, null, null, null];
  readonly scroll: number[] = [0, 0, 0, 0];

  constructor(preset: Preset = 1) {
    this.preset = preset;
  }

  setPreset(p: Preset): void {
    this.preset = p;
  }

  clamp(visible: number): void {
    this.focused = Math.max(0, Math.min(this.focused, visible - 1));
  }

  show(agentId: string | null, visible: number): void {
    this.clamp(visible);
    const before = [...this.agents];
    const at = agentId === null ? -1 : this.agents.indexOf(agentId);
    if (at === this.focused) return;
    if (at >= 0) this.agents[at] = this.agents[this.focused];
    this.agents[this.focused] = agentId;
    this.agents.forEach((a, i) => {
      if (a !== before[i]) this.scroll[i] = 0;
    });
  }

  focusNext(dir: 1 | -1, visible: number): void {
    if (visible <= 0) return;
    this.focused = (this.focused + dir + visible) % visible;
  }

  shown(visible: number): string[] {
    return this.agents.slice(0, visible).filter((a): a is string => a !== null);
  }

  paneOf(agentId: string, visible: number): number {
    const i = this.agents.indexOf(agentId);
    return i >= 0 && i < visible ? i : -1;
  }

  prune(alive: (agentId: string) => boolean): void {
    this.agents.forEach((a, i) => {
      if (a !== null && !alive(a)) {
        this.agents[i] = null;
        this.scroll[i] = 0;
      }
    });
  }
}
