// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../bridge/src/model';
import { rankCommands } from '../src/panel/slashMenu';

const cmd = (name: string, description = ''): SlashCommand => ({ name, description, source: 'user' });

describe('rankCommands', () => {
  it('prefers name prefix, then plugin-namespace prefix, then substring, then description', () => {
    const list = [cmd('setup-gbrain'), cmd('superpowers:brainstorming'), cmd('brainstorm'), cmd('review', 'brainy review')];
    expect(rankCommands(list, 'brain').map((c) => c.name)).toEqual(['brainstorm', 'superpowers:brainstorming', 'setup-gbrain', 'review']);
    expect(rankCommands(list, 'zzz')).toEqual([]);
  });
});
