import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv, findCommand } from '../src/native/env.js';

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

describe('findCommand', () => {
  it.skipIf(process.platform === 'win32')('finds an executable file on PATH, else null', () => {
    const a = mkdtempSync(path.join(os.tmpdir(), 'od-which-'));
    const b = mkdtempSync(path.join(os.tmpdir(), 'od-which-'));
    writeFileSync(path.join(a, 'claude'), '#!/bin/sh\n');
    chmodSync(path.join(a, 'claude'), 0o644); // not executable: skipped
    writeFileSync(path.join(b, 'claude'), '#!/bin/sh\n');
    chmodSync(path.join(b, 'claude'), 0o755);
    mkdirSync(path.join(a, 'codex')); // a folder is not a command
    const env = { PATH: [a, b].join(path.delimiter) };
    expect(findCommand('claude', env)).toBe(path.join(b, 'claude'));
    expect(findCommand('codex', env)).toBeNull();
    expect(findCommand('gemini', env)).toBeNull();
  });

  it.runIf(process.platform === 'win32')('resolves a Windows command to an existing file', () => {
    const a = mkdtempSync(path.join(os.tmpdir(), 'od-which-'));
    writeFileSync(path.join(a, 'claude.cmd'), '@echo off\r\n');
    expect(findCommand('claude', { PATH: a })).toBe(path.win32.join(a, 'claude.cmd'));
    expect(findCommand('codex', { PATH: a })).toBeNull();
  });
});
