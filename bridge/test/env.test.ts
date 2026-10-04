import { describe, expect, it } from 'vitest';
import { agentEnv } from '../src/native/env.js';

describe('agentEnv', () => {
  it('drops Claude session markers and Orca variables but keeps user auth and config', () => {
    const env = agentEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 's',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_SESSION_ATTENDED: '1',
        CLAUDE_CODE_BRIDGE_SESSION_ID: 'b',
        CLAUDE_CODE_EXECPATH: '/x',
        CLAUDE_CODE_MESSAGING_SOCKET: '/s',
        CLAUDE_CODE_MESSAGING_TOKEN: 't',
        CLAUDE_PID: '9',
        CLAUDE_EFFORT: 'high',
        ORCA_AGENT_HOOK_TOKEN: 'secret',
        ORCA_TERMINAL_HANDLE: 'term_1',
        CODEX_HOME: '/Users/me/Library/Application Support/orca/codex-runtime-home/home',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
        ANTHROPIC_API_KEY: 'key',
        UNDEFINED_ONE: undefined,
      },
      { OFFICE_DESKS_HOOK_URL: 'http://127.0.0.1:1/hook/a?token=t' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
      ANTHROPIC_API_KEY: 'key',
      OFFICE_DESKS_HOOK_URL: 'http://127.0.0.1:1/hook/a?token=t',
    });
  });

  it('keeps a CODEX_HOME the user chose', () => {
    expect(agentEnv({ CODEX_HOME: '/Users/me/.codex' }).CODEX_HOME).toBe('/Users/me/.codex');
  });
});
