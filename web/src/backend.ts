import type { BackendInfo } from '../../bridge/src/model';

// What the connected bridge's backend can do. Until the bridge says otherwise, assume Orca
// (the first backend), so nothing flickers away for existing users.
let info: BackendInfo = {
  name: 'orca',
  capabilities: { usage: true, search: true, board: true, hire: true, changes: true, transcripts: true, focus: true, repos: false },
};

export function backendInfo(): BackendInfo {
  return info;
}

export function setBackendInfo(next: BackendInfo): void {
  info = next;
}
