import Phaser from 'phaser';

// Small procedural pixel textures that the Kenney packs don't have: monitor backs and
// status icons for speech bubbles. Drawn at 1px per cell, scaled with nearest-neighbour.

type Palette = Record<string, number>;

function pixelTexture(scene: Phaser.Scene, key: string, rows: string[], palette: Palette): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({}, false);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = palette[ch];
      if (color === undefined) return;
      g.fillStyle(color, 1).fillRect(x, y, 1, 1);
    });
  });
  g.generateTexture(key, Math.max(...rows.map((r) => r.length)), rows.length);
  g.destroy();
}

// Monitor seen from behind (the agent sits facing us, the screen faces the agent).
const MONITOR_BACK = [
  'mmmmmmmmmmmm',
  'mMMMMMMMMMMm',
  'mMMMMMMMMMMm',
  'mMMMMMlMMMMm',
  'mMMMMMMMMMMm',
  'mmmmmmmmmmmm',
  '.....ss.....',
  '...ssssss...',
];

// --- Status icons for speech bubbles (7x7) ---

const ICONS: Record<string, { rows: string[]; color: number }> = {
  waiting: {
    color: 0xe0a800,
    rows: ['...x...', '...x...', '...x...', '...x...', '...x...', '.......', '...x...'],
  },
  typing: {
    color: 0x444444,
    rows: ['.......', '.......', '.......', 'x.x.x..', '.......', '.......', '.......'],
  },
  running: {
    color: 0x2f9e44,
    rows: ['.......', 'x......', '.x.....', '..x....', '.x.....', 'x..xxx.', '.......'],
  },
  reading: {
    color: 0x3b6fd8,
    rows: ['.xxx...', 'x...x..', 'x...x..', 'x...x..', '.xxx...', '....xx.', '.....xx'],
  },
  done: {
    color: 0x8a6fd1,
    rows: ['xxxx...', '...x...', '..x....', '.x.xxx.', 'xxxx.x.', '....x..', '...xxx.'],
  },
};

export function iconKey(state: string): string | null {
  return ICONS[state] ? `icon-${state}` : null;
}

export function buildTextures(scene: Phaser.Scene): void {
  pixelTexture(scene, 'monitor-back', MONITOR_BACK, { m: 0x23262e, M: 0x3a3f4b, l: 0x8ad0ff, s: 0x2a2f3a });
  for (const [state, icon] of Object.entries(ICONS)) {
    pixelTexture(scene, `icon-${state}`, icon.rows, { x: icon.color });
  }
}

/** Screen glow colour per character state. */
export const SCREEN: Record<string, number> = {
  typing: 0x7fd1ff,
  reading: 0xbfe3ff,
  running: 0x1e3b22,
  waiting: 0xffd166,
  done: 0x4a5266,
  away: 0x1b1f27,
};
