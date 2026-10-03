import type { SlashCommand } from '../../../bridge/src/model';
import { esc } from './util';

const MENU_SIZE = 8;
const SOURCE_LABEL: Record<SlashCommand['source'], string> = { builtin: '기본', user: '내 스킬', project: '프로젝트', plugin: '플러그인' };

/** Rank commands for a typed query: name prefix, prefix after a plugin namespace, substring, description. */
export function rankCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const ql = query.toLowerCase();
  const rank = (c: SlashCommand): number => {
    const n = c.name.toLowerCase();
    if (n.startsWith(ql)) return 0;
    if (n.split(':').some((part) => part.startsWith(ql))) return 1;
    if (n.includes(ql)) return 2;
    if (ql.length > 2 && c.description.toLowerCase().includes(ql)) return 3;
    return 9;
  };
  return commands
    .map((c) => [rank(c), c] as const)
    .filter(([r]) => r < 9)
    .sort((x, y) => x[0] - y[0] || x[1].name.length - y[1].name.length)
    .map(([, c]) => c)
    .slice(0, 50);
}

/** `/` autocomplete for the message box. */
export class SlashMenu {
  private commands: SlashCommand[] = [];
  private items: SlashCommand[] = [];
  private index = 0;

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly el: HTMLElement,
  ) {
    textarea.addEventListener('input', () => this.update());
    textarea.addEventListener('click', () => this.update());
    textarea.addEventListener('blur', () => window.setTimeout(() => this.hide(), 150));
    el.addEventListener('mousedown', (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i;
      if (i !== undefined) {
        e.preventDefault();
        this.accept(Number(i));
      }
    });
  }

  setCommands(list: SlashCommand[]): void {
    this.commands = list;
  }

  find(name: string): SlashCommand | undefined {
    return this.commands.find((c) => c.name === name);
  }

  hide(): void {
    this.el.hidden = true;
    this.items = [];
  }

  /** Handle navigation keys while the menu is open; returns true when the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.el.hidden || !this.items.length || e.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.items.length;
      this.index = (this.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.render();
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return true;
    }
    // Enter on an exact match falls through and sends the command as typed.
    const exact = this.items[this.index]?.name === this.query();
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exact)) {
      e.preventDefault();
      this.accept(this.index);
      return true;
    }
    return false;
  }

  /** The `/word` being typed, if the caret is still inside the first token of the message. */
  private query(): string | null {
    const v = this.textarea.value;
    if (!v.startsWith('/')) return null;
    const end = v.search(/\s/);
    const tokenEnd = end === -1 ? v.length : end;
    if (this.textarea.selectionStart > tokenEnd) return null;
    return v.slice(1, tokenEnd);
  }

  private update(): void {
    const q = this.query();
    if (q === null || !this.commands.length) return this.hide();
    this.items = rankCommands(this.commands, q);
    this.index = 0;
    if (!this.items.length) return this.hide();
    this.render();
  }

  private render(): void {
    const start = Math.max(0, Math.min(this.index - MENU_SIZE + 1, this.items.length - MENU_SIZE));
    const view = this.items.slice(start, start + MENU_SIZE);
    this.el.innerHTML =
      view
        .map((c, k) => {
          const i = start + k;
          return `<div class="item${i === this.index ? ' active' : ''}" data-i="${i}">
            <span class="name">/${esc(c.name)}</span><span class="src">${SOURCE_LABEL[c.source]}</span>
            <span class="desc">${esc(c.description)}</span></div>`;
        })
        .join('') + `<div class="hint">↑↓ 이동 · Tab/Enter 선택 · Esc 닫기 · ${this.items.length}개</div>`;
    this.el.hidden = false;
  }

  private accept(i: number): void {
    const c = this.items[i];
    if (!c) return;
    const v = this.textarea.value;
    const end = v.search(/\s/);
    const rest = end === -1 ? '' : v.slice(end).replace(/^\s+/, '');
    this.textarea.value = `/${c.name} ${rest}`;
    const caret = c.name.length + 2;
    this.textarea.setSelectionRange(caret, caret);
    this.hide();
    this.textarea.focus();
  }
}
