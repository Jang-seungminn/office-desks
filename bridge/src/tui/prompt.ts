import type { Key } from './keys.js';

// One-line prompts inside the lobby (paths, names, first instructions). Text arrives already
// composed from the terminal (IME included), so editing is append and backspace by code point.

export interface Field {
  label: string;
  initial?: string;
  optional?: boolean;
}

export class Form {
  private values: string[] = [];
  private index = 0;
  private text: string;

  constructor(private readonly fields: Field[]) {
    this.text = fields[0]?.initial ?? '';
  }

  key(k: Key): { done: 'submit'; values: string[] } | { done: 'cancel' } | null {
    if (k.name === 'escape' || k.name === 'ctrl-c') return { done: 'cancel' };
    if (k.name === 'backspace') {
      this.text = [...this.text].slice(0, -1).join('');
      return null;
    }
    if (k.name === 'char') {
      this.text += k.ch;
      return null;
    }
    if (k.name !== 'enter') return null;
    const field = this.fields[this.index];
    const value = this.text.trim();
    if (!value && !field.optional) return null;
    this.values.push(value);
    this.index++;
    if (this.index >= this.fields.length) return { done: 'submit', values: this.values };
    this.text = this.fields[this.index].initial ?? '';
    return null;
  }

  line(): string {
    return `${this.fields[this.index]?.label ?? ''}: ${this.text}█`;
  }
}
