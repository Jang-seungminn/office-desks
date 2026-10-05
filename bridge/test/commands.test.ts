import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { frontMatter, listCommands } from '../src/commands.js';
import { keyBytes } from '../src/keys.js';
import { scratch } from './scratch.js';

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe('frontMatter', () => {
  it('reads plain, quoted and folded descriptions', () => {
    expect(frontMatter('---\nname: browse\ndescription: "Fast browser"\n---\n')).toEqual({ name: 'browse', description: 'Fast browser' });
    expect(frontMatter('---\nname: x\ndescription: >-\n  line one\n  line two\nother: 1\n---')).toEqual({ name: 'x', description: 'line one line two' });
    expect(frontMatter('# Deploy the app\n\nsteps')).toEqual({ description: 'Deploy the app' });
  });
});

describe('listCommands', () => {
  it('merges Claude built-ins, user/project commands and skills, and enabled plugin skills', async () => {
    const home = scratch('od-home-');
    const proj = scratch('od-proj-');
    write(path.join(home, '.claude/commands/git/push.md'), '---\ndescription: Push it\n---');
    write(path.join(home, '.claude/skills/browse/SKILL.md'), '---\nname: browse\ndescription: Browser\n---');
    write(path.join(proj, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Ship\n---');
    const pluginDir = path.join(home, 'plugins/sp');
    write(path.join(pluginDir, 'skills/brainstorming/SKILL.md'), '---\nname: brainstorming\ndescription: Think\n---');
    write(path.join(home, 'plugins/off/skills/hidden/SKILL.md'), '---\nname: hidden\n---');
    write(
      path.join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({ plugins: { 'superpowers@x': [{ installPath: pluginDir }], 'off@x': [{ installPath: path.join(home, 'plugins/off') }] } }),
    );
    write(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'off@x': false } }));

    const list = await listCommands('claude', proj, home);
    const names = list.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['compact', 'config', 'git:push', 'browse', 'deploy', 'superpowers:brainstorming']));
    expect(names).not.toContain('off:hidden');
    expect(list.find((c) => c.name === 'deploy')).toMatchObject({ source: 'project', description: 'Ship' });
  });

  it('gives Codex its built-ins and prompts', async () => {
    const home = scratch('od-home-');
    write(path.join(home, '.codex/prompts/fix.md'), 'Fix the failing test');
    const names = (await listCommands('codex', '/nowhere', home)).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['model', 'approvals', 'prompts:fix']));
  });
});

describe('keyBytes', () => {
  it('maps whitelisted keys and rejects everything else', () => {
    expect(keyBytes('up')).toBe('\x1b[A');
    expect(keyBytes('enter')).toBe('\r');
    expect(keyBytes('rm -rf /')).toBeNull();
    expect(keyBytes('toString')).toBeNull();
  });
});
