import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { subagentFile, subagentIds, subagentInfos } from '../src/subagents.js';
import { parseTranscript, readTranscript } from '../src/transcript.js';

const L = (o: unknown) => JSON.stringify(o);
const agentCall = (id: string, description: string) =>
  L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, subagent_type: 'Explore', prompt: 'p' } }] } });
const toolResult = (id: string, text: string) =>
  L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const notification = (id: string, status: string) =>
  L({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
      origin: { kind: 'task-notification' },
    },
  });

describe('subagent tracking', () => {
  it('turns Agent calls into subagent messages and follows their status', () => {
    const st = parseTranscript(
      [
        agentCall('bg', 'Security review'),
        toolResult('bg', 'Async agent launched successfully.'),
        agentCall('fg', 'Find files'),
        toolResult('fg', 'Found 3 files'),
        agentCall('dead', 'Flaky one'),
        toolResult('dead', 'Async agent launched successfully.'),
        notification('dead', 'failed'),
      ].join('\n'),
    );
    expect(st.messages.filter((m) => m.role === 'subagent').map((m) => m.text)).toEqual(['Security review', 'Find files', 'Flaky one']);
    expect([...st.calls!.values()].map((c) => [c.toolUseId, c.status])).toEqual([
      ['bg', 'running'],
      ['fg', 'done'],
      ['dead', 'failed'],
    ]);
    const later = parseTranscript([agentCall('bg', 'Security review'), notification('bg', 'completed')].join('\n'));
    expect(later.calls!.get('bg')!.status).toBe('done');
    // the notification itself is not shown as a chat message
    expect(later.messages).toHaveLength(1);
  });

  it('maps tool calls to subagent transcripts and reads their sidechain records', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-sub-'));
    const main = path.join(root, 'sess.jsonl');
    writeFileSync(main, agentCall('t1', 'Review') + '\n');
    const dir = path.join(root, 'sess', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'agent-abc123.meta.json'), L({ toolUseId: 't1', agentType: 'Explore' }));
    writeFileSync(
      path.join(dir, 'agent-abc123.jsonl'),
      [
        L({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Review the bridge' } }),
        L({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'Found 2 issues' }] } }),
        L({
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: '## Report' } }] },
        }),
      ].join('\n') + '\n',
    );
    const t = await readTranscript(main);
    const infos = subagentInfos(t.calls, await subagentIds(main));
    expect(infos).toEqual([{ toolUseId: 't1', agentId: 'abc123', description: 'Review', agentType: 'Explore', status: 'running' }]);
    const sub = await readTranscript(subagentFile(main, 'abc123')!, { sidechain: true });
    expect(sub.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Review the bridge'],
      ['assistant', 'Found 2 issues'],
      ['assistant', '## Report'],
    ]);
    expect(subagentFile(main, '../../etc')).toBeNull();
  });
});
