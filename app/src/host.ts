// The only place the UI talks to the Tauri host. The E2E fakes window.__TAURI_INTERNALS__.invoke.
import { invoke } from '@tauri-apps/api/core';

export interface TermConfig { port: number; token: string }
export type Platform = 'mac' | 'win';

export function termConfig(): Promise<TermConfig> {
  return invoke<TermConfig>('term_config');
}

export async function pickFolder(): Promise<string | null> {
  return (await invoke<string | null>('pick_folder')) ?? null;
}

export async function openOffice(): Promise<void> {
  await invoke('open_office');
}

export function platform(ua: string = navigator.userAgent): Platform {
  return /Mac/.test(ua) ? 'mac' : 'win';
}

/**
 * Test hook. Enabled only by a build made with `vite build --mode e2e` (Task 9's E2E must build
 * that way) AND the window flag, so a production build can never turn it on: Vite replaces
 * import.meta.env.MODE statically and the branch is dead code. vitest runs with MODE 'test'.
 */
export function isE2E(): boolean {
  const mode = import.meta.env.MODE;
  if (mode !== 'e2e' && mode !== 'test') return false;
  return (window as any).__TAURI_INTERNALS__?.__gongbangE2E === true;
}
