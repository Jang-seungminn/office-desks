// The Tauri host, faked: exactly the three commands the app invokes (src/host.ts).
import type { Page } from '@playwright/test';
import type { HarnessInfo } from './harness';

export async function useFakeHost(page: Page, info: HarnessInfo): Promise<void> {
  await page.addInitScript(
    ({ port, token, repo }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__officeOpened = 0;
      w.__TAURI_INTERNALS__ = {
        // Read by isE2E(), which only a `vite build --mode e2e` bundle consults.
        __gongbangE2E: true,
        invoke: async (cmd: string) => {
          switch (cmd) {
            case 'term_config':
              return { port, token };
            case 'pick_folder':
              return repo;
            case 'open_office':
              w.__officeOpened = (w.__officeOpened as number) + 1;
              return null;
            default:
              throw new Error(`unknown command ${cmd}`);
          }
        },
      };
    },
    { port: info.port, token: info.token, repo: info.repo },
  );
  await page.goto(`http://127.0.0.1:${info.port}/app/`);
}
