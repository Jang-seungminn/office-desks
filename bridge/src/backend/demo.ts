import { createDemoRunner, demoEnrichment } from '../demo.js';
import type { OfficeSnapshot } from '../model.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { OrcaBackend } from './orca.js';
import type { BackendCapabilities, BackendMessages } from './types.js';

/** `npm run demo`: the Orca backend over a fake Orca, plus the data real transcripts and git would add. */
export class DemoBackend extends OrcaBackend {
  override readonly name: string = 'demo';
  override readonly capabilities: BackendCapabilities = { usage: true, search: false, board: false, hire: false, changes: false, transcripts: false, focus: false, repos: false, stop: false, remove: false };
  override readonly messages: BackendMessages = {
    noSession: 'Orca 세션 검색에서 이 에이전트의 대화 기록을 찾지 못했습니다. (Orca Settings → Agent Session History가 켜져 있어야 합니다)',
    hireDisabled: '데모 모드에서는 만들 수 없어요',
  };

  constructor(verify?: SessionVerifier) {
    super(createDemoRunner(), verify);
  }

  override async snapshot(): Promise<OfficeSnapshot> {
    const s = await super.snapshot();
    for (const a of s.desks.flatMap((d) => d.agents)) Object.assign(a, demoEnrichment(a.id));
    for (const [i, d] of s.desks.entries()) d.changes = d.agents.length ? { files: (i % 4) + 1, added: 12 + i * 37, deleted: i * 9 } : null;
    return s;
  }
}
