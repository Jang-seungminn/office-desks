import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyHook, hookSettings, initialHookState, relayScript } from '../src/native/hooks.js';

describe('hookSettings', () => {
  it('runs the relay with this node for every event, matching all tools', () => {
    const s = hookSettings('C:\\od\\bridge\\hook-relay.mjs', 'C:\\Program Files\\nodejs\\node.exe');
    const cmd = '"C:/Program Files/nodejs/node.exe" "C:/od/bridge/hook-relay.mjs"';
    expect(Object.keys(s.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']);
    expect(s.hooks.PreToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: cmd }] }]);
  });

  it('points at the shipped relay script', () => {
    expect(existsSync(relayScript())).toBe(true);
  });
});

describe('applyHook', () => {
  const t0 = initialHookState(1000);

  it('follows a turn: start → prompt → tool → done', () => {
    let s = applyHook(t0, { hook_event_name: 'SessionStart', session_id: 'sid', transcript_path: '/p/sid.jsonl', source: 'startup' }, 2000);
    expect(s).toMatchObject({ rawState: 'done', started: true, sessionId: 'sid', transcriptPath: '/p/sid.jsonl', since: 2000 });
    s = applyHook(s, { hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' }, 3000);
    expect(s).toMatchObject({ rawState: 'working', prompt: 'fix the bug', toolName: null, since: 3000 });
    s = applyHook(s, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests' } }, 4000);
    expect(s).toMatchObject({ rawState: 'working', toolName: 'Bash', toolInput: 'npm test', since: 3000 });
    s = applyHook(s, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 5000);
    expect(s).toMatchObject({ rawState: 'working', toolName: null });
    s = applyHook(s, { hook_event_name: 'Stop', last_assistant_message: 'All green.' }, 6000);
    expect(s).toMatchObject({ rawState: 'done', lastMessage: 'All green.', since: 6000 });
  });

  it('waits on a permission notification, but an idle reminder means done', () => {
    const working = applyHook(t0, { hook_event_name: 'UserPromptSubmit', prompt: 'x' }, 2000);
    expect(applyHook(working, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, 3000).rawState).toBe('waiting');
    expect(applyHook(working, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Edit' }, 3000).rawState).toBe('waiting');
    expect(applyHook(working, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, 3000).rawState).toBe('done');
  });

  it('ignores unknown events and malformed fields', () => {
    expect(applyHook(t0, { hook_event_name: 'SubagentStop' }, 2000)).toEqual(t0);
    expect(applyHook(t0, { hook_event_name: 'PreToolUse', tool_name: 42, tool_input: 'x' }, 2000)).toMatchObject({ toolName: null, toolInput: null });
  });
});
