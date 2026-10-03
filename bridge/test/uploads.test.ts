import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanOldUploads, composePrompt, saveImages, uploadPath } from '../src/uploads.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

describe('uploads', () => {
  it('saves images and appends one path per line to the prompt', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-up-'));
    const [file] = await saveImages([{ mediaType: 'image/png', data: PNG }], dir);
    expect(file.startsWith(dir)).toBe(true);
    expect(file.endsWith('.png')).toBe(true);
    expect(readFileSync(file).toString('base64')).toBe(PNG);
    expect(composePrompt('  look at this ', [file])).toBe(`look at this\n${file}`);
    expect(composePrompt('', [file])).toBe(file);
  });

  it('writes into a private folder with private files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-up-'));
    const dir = path.join(root, 'office-desks-1', 'uploads');
    const [file] = await saveImages([{ mediaType: 'image/png', data: PNG }], dir);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses an upload folder that is a symlink', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(path.join(tmpdir(), 'od-up-'));
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'od-evil-'));
    symlinkSync(elsewhere, path.join(root, 'uploads'));
    await expect(saveImages([{ mediaType: 'image/png', data: PNG }], path.join(root, 'uploads'))).rejects.toThrow();
  });

  it('rejects unknown types, empty data and too many images', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-up-'));
    await expect(saveImages([{ mediaType: 'image/svg+xml', data: PNG }], dir)).rejects.toThrow();
    await expect(saveImages([{ mediaType: 'image/png', data: '' }], dir)).rejects.toThrow();
    await expect(saveImages(Array(7).fill({ mediaType: 'image/png', data: PNG }), dir)).rejects.toThrow();
  });

  it('serves uploads by bare name only', () => {
    expect(uploadPath('123-abcd1234.png', '/up')).toBe(path.join('/up', '123-abcd1234.png'));
    expect(uploadPath('../secret.png', '/up')).toBeNull();
    expect(uploadPath('a.exe', '/up')).toBeNull();
  });

  it('deletes uploads older than a day', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-up-'));
    const old = path.join(dir, 'old.png');
    const fresh = path.join(dir, 'fresh.png');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const twoDaysAgo = (Date.now() - 2 * 864e5) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    await cleanOldUploads(dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
