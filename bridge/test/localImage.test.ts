import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLinkedImage, readLocalImage } from '../src/localImage.js';
import type { ConversationMessage } from '../src/model.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const msg = (role: ConversationMessage['role'], text: string): ConversationMessage => ({ role, text, ts: null });

describe('isLinkedImage', () => {
  it('only counts Markdown links in chat messages', () => {
    const shot = '/tmp/shots/a.png';
    expect(isLinkedImage([msg('assistant', `look ![a](${shot})`)], shot)).toBe(true);
    expect(isLinkedImage([msg('assistant', `look ![a](<${shot}>)`)], shot)).toBe(true);
    expect(isLinkedImage([msg('assistant', `I saved it to ${shot}`)], shot)).toBe(false);
    expect(isLinkedImage([msg('tool', `Read: ![x](${shot})`)], shot)).toBe(false);
  });
});

describe('readLocalImage', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-img-'));

  it('serves real images by magic bytes', () => {
    const f = path.join(dir, 'ok.png');
    writeFileSync(f, PNG);
    expect(readLocalImage(f)?.type).toBe('image/png');
  });

  it('refuses non-images renamed to .png and symlinks to non-image files', () => {
    const fake = path.join(dir, 'fake.png');
    writeFileSync(fake, 'ssh-rsa AAAA secret');
    expect(readLocalImage(fake)).toBeNull();
    if (process.platform === 'win32') return;
    const secret = path.join(dir, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    const link = path.join(dir, 'link.png');
    symlinkSync(secret, link);
    expect(readLocalImage(link)).toBeNull();
    expect(readLocalImage(path.join(dir, 'missing.png'))).toBeNull();
  });
});
