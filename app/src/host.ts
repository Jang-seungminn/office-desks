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

export function isE2E(): boolean {
  return (window as any).__TAURI_INTERNALS__?.__gongbangE2E === true;
}
