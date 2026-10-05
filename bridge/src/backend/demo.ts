import { createDemoRunner, demoEnrichment } from '../demo.js';
import type { OfficeSnapshot } from '../model.js';
import type { SessionVerifier } from '../sessionResolver.js';
import { OrcaBackend } from './orca.js';
import type { BackendCapabilities } from './types.js';

/** `npm run demo`: the Orca backend over a fake Orca, plus the data real transcripts and git would add. */
export class DemoBackend extends OrcaBackend {
  override readonly name: string = 'demo';
  override readonly capabilities: BackendCapabilities = { usage: true, search: false, board: false, hire: false, changes: false, transcripts: false };

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
