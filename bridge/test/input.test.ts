import { describe, expect, it } from 'vitest';
import { encodePanelInput } from '../src/tui/input.js';

const off = { bracketedPasteMode: false, applicationCursorKeysMode: false };
const paste = { ...off, bracketedPasteMode: true };
const app = { ...off, applicationCursorKeysMode: true };

describe('encodePanelInput', () => {
  it('passes plain keys through unchanged', () => {
    expect(encodePanelInput('hi\r\x03\x7f한', off)).toBe('hi\r\x03\x7f한');
  });

  it('keeps paste markers only when the agent asked for bracketed paste', () => {
    const p = '\x1b[200~line1\nline2\x1b[201~';
    expect(encodePanelInput(p, paste)).toBe(p);
    expect(encodePanelInput(p, off)).toBe('line1\nline2');
  });

  it('sends arrows in the cursor-key mode the agent uses, never inside a paste', () => {
    expect(encodePanelInput('\x1b[A\x1b[D', app)).toBe('\x1bOA\x1bOD');
    expect(encodePanelInput('\x1bOB', off)).toBe('\x1b[B');
    expect(encodePanelInput('\x1b[200~\x1b[A\x1b[201~', { ...paste, applicationCursorKeysMode: true })).toBe('\x1b[200~\x1b[A\x1b[201~');
  });
});

describe('encodePanelInput Home/End', () => {
  it('sends Home/End in the cursor-key mode the agent uses, leaving modified keys alone', () => {
    expect(encodePanelInput('\x1b[H\x1b[F', app)).toBe('\x1bOH\x1bOF');
    expect(encodePanelInput('\x1bOH\x1bOF', off)).toBe('\x1b[H\x1b[F');
    expect(encodePanelInput('\x1b[1;5H', app)).toBe('\x1b[1;5H');
  });
});
