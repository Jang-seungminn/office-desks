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

// Lounge furniture the Kenney packs don't have.
const BOOKSHELF = [
  'wwwwwwwwwwwwwwww',
  'wddddddddddddddw',
  'wdrrbbgyyrrbbgdw',
  'wdrrbbgyyrrbbgdw',
  'wdrrbbgyyrrbbgdw',
  'wwwwwwwwwwwwwwww',
  'wddddddddddddddw',
  'wdggyyddbbrrggdw',
  'wdggyyddbbrrggdw',
  'wdggyyopbbrrggdw',
  'wwwwwwwwwwwwwwww',
  'wddddddddddddddw',
  'wdbbrrggyybbdddw',
  'wdbbrrggyybbpodw',
  'wdbbrrggyybbpodw',
  'wwwwwwwwwwwwwwww',
  'ww............ww',
];

const FLOOR_LAMP = [
  '..yyyyyy..',
  '.yYYYYYYy.',
  'yYYYYYYYYy',
  '....kk....',
  '....kk....',
  '....kk....',
  '....kk....',
  '....kk....',
  '....kk....',
  '....kk....',
  '..kkkkkk..',
];

const MUG = [
  'wwwww.',
  'wcccwww',
  'wwwww.w',
  'wwwwwww',
  '.www...',
];

const STEAM = ['.s.', 's..', '.s.', '..s'];

// 9x9 pixel icons used in place of emoji (emoji render differently on every OS).
const PIXEL_ICONS: Record<string, { rows: string[]; palette: Palette }> = {
  fire: {
    palette: { r: 0xe5484d, o: 0xff8a3d, y: 0xffd166 },
    rows: ['....r....', '...rr....', '...rro...', '..rrooo..', '..roooor.', '.rooyyor.', '.roiyyor.', '.rooyyoor', '..rooor..'].map((r) => r.replace('i', 'y')),
  },
  cup: {
    palette: { w: 0xf4f1ea, c: 0x6b3f1d, s: 0xd8d2c4 },
    rows: ['..s..s...', '...s..s..', '.........', 'wwwwwww..', 'wcccccwww', 'wcccccw.w', 'wcccccwww', '.wwwww...', 'sssssss..'],
  },
  zzz: {
    palette: { b: 0x8ab4ff },
    rows: ['....bbbbb', '.......b.', '......b..', '.....bbbb', 'bbbb.....', '...b.....', '..b......', '.b.......', 'bbbb.....'],
  },
  folder: {
    palette: { d: 0xb98a3e, y: 0xe8b85a, l: 0xf6d38a },
    rows: ['.........', 'dddd.....', 'dyyyddddd', 'dlllllllld', 'dyyyyyyyd', 'dyyyyyyyd', 'dyyyyyyyd', 'dyyyyyyyd', 'ddddddddd'],
  },
};

export function pixelIconKey(name: keyof typeof PIXEL_ICONS | string): string {
  return `px-${name}`;
}

export function buildTextures(scene: Phaser.Scene): void {
  for (const [name, icon] of Object.entries(PIXEL_ICONS)) pixelTexture(scene, pixelIconKey(name), icon.rows, icon.palette);
  pixelTexture(scene, 'bookshelf', BOOKSHELF, {
    w: 0x5b3a24,
    d: 0x3d2718,
    r: 0xc0392b,
    b: 0x3b6fd8,
    g: 0x3f8f4a,
    y: 0xe0a800,
    o: 0xf2efe6,
    p: 0x8a6fd1,
  });
  pixelTexture(scene, 'floor-lamp', FLOOR_LAMP, { y: 0xd9a441, Y: 0xffe39a, k: 0x2b2118 });
  pixelTexture(scene, 'mug', MUG, { w: 0xf4f1ea, c: 0x6b3f1d });
  pixelTexture(scene, 'steam', STEAM, { s: 0xffffff });
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
