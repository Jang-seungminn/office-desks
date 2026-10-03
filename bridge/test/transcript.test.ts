import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTranscript, readTranscript } from '../src/transcript.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseTranscript (Claude Code)', () => {
  const { title, messages, images } = parseTranscript(fixture('claude-session.jsonl'));

  it('keeps the chat and drops thinking, meta, tool output, wrappers and sidechains', () => {
    expect(title).toBe('Office desks project');
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Build an **office** view'],
      ['assistant', 'Sure.\n\n```ts\nconst a = 1;\n```'],
      ['tool', 'Bash: npm test --run'],
      ['user', 'next: add pixel assets'],
      ['user', 'also check usage'],
    ]);
    expect(messages.at(-1)!.queued).toBe(true);
    expect(messages[0].ts).toBe('2026-10-03T03:00:00.000Z');
    expect(messages[0].images).toEqual([0]);
    expect(images[0]).toEqual({ mediaType: 'image/png', data: 'xx' });
  });
});

describe('parseTranscript (Codex)', () => {
  const { messages } = parseTranscript(fixture('codex-session.jsonl'));

  it('uses user_message events, assistant output_text and tool summaries', () => {
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Make a terminal usage monitor'],
      ['assistant', 'Checking the repo first.'],
      ['tool', 'exec_command: pwd && rg --files'],
      ['tool', 'web_search: claude code otel'],
      ['tool', 'apply_patch: *** Begin Patch *** Add File: docs/plan.md +# Plan'],
    ]);
  });
});

describe('readTranscript', () => {
  const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'od-')), 's.jsonl');
  const line = (text: string, role = 'user') =>
    JSON.stringify({ type: role, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } }) + '\n';

  it('tolerates CRLF', async () => {
    const file = tmpFile();
    writeFileSync(file, fixture('claude-session.jsonl').replace(/\n/g, '\r\n'));
    expect((await readTranscript(file)).messages).toHaveLength(5);
  });

  it('keeps the whole history and parses only appended lines', async () => {
    const file = tmpFile();
    writeFileSync(file, line('the very first request') + Array.from({ length: 1500 }, (_, i) => line(`reply ${i}`, 'assistant')).join(''));
    const a = await readTranscript(file);
    expect(a.messages).toHaveLength(1501);
    expect(a.messages[0].text).toBe('the very first request');

    appendFileSync(file, line('one more'));
    const b = await readTranscript(file);
    expect(b.messages).toHaveLength(1502);
    expect(b.messages.at(-1)!.text).toBe('one more');
    expect(b.fileId).toBe(a.fileId);
  });

  it('waits for a half-written line (including split UTF-8) before parsing it', async () => {
    const file = tmpFile();
    const bytes = Buffer.from(line('안녕하세요 반가워요'));
    writeFileSync(file, bytes.subarray(0, 20)); // cuts inside a multibyte character
    expect((await readTranscript(file)).messages).toHaveLength(0);
    appendFileSync(file, bytes.subarray(20));
    expect((await readTranscript(file)).messages.map((m) => m.text)).toEqual(['안녕하세요 반가워요']);
  });

  it('starts over with a new fileId when the file is truncated or replaced', async () => {
    const file = tmpFile();
    writeFileSync(file, line('old session, long text here') + line('more'));
    const a = await readTranscript(file);
    writeFileSync(file, line('new'));
    const b = await readTranscript(file);
    expect(b.messages.map((m) => m.text)).toEqual(['new']);
    expect(b.fileId).not.toBe(a.fileId);
  });
});
