import Phaser from 'phaser';

// Every frame the office uses lives here, as [col, row] on its sheet, so swapping in another
// pack (e.g. a purchased LimeZu/Donarg tileset in a gitignored folder) only touches this file.
// Default art: Kenney CC0 packs in web/public/assets/kenney (see LICENSE.txt there).

export const TILE = 16;
export const SCALE = 3;
export const PX = TILE * SCALE; // one tile on screen

type Cell = readonly [col: number, row: number];

const SHEETS = {
  indoor: { url: 'assets/kenney/roguelike-indoor.png', cols: 27, spacing: 1 },
  chars: { url: 'assets/kenney/roguelike-characters.png', cols: 54, spacing: 1 },
  city: { url: 'assets/kenney/roguelike-modern-city.png', cols: 37, spacing: 0 },
} as const;
export type SheetKey = keyof typeof SHEETS;

export const FRAMES = {
  desk: [[0, 0], [1, 0], [2, 0]] as Cell[], // left, middle, right of a 3-tile table
  chair: [0, 2] as Cell,
  floor: [[24, 0], [25, 0], [24, 1], [25, 1]] as Cell[], // city beige stone, 2x2 block
  wallTop: [10, 5] as Cell, // city beige brick
  wallBrick: [10, 5] as Cell,
  wallWindow: [[12, 6], [13, 6], [14, 6]] as Cell[],
  plants: [[16, 0], [17, 0]] as Cell[],
  sideboard: [[23, 9], [24, 9]] as Cell[],
  // Wall pictures (indoor sheet): landscape, pumpkin, teal, small frame pairs.
  pictures: [[19, 12], [19, 13], [19, 14], [16, 12], [17, 13], [18, 12]] as Cell[],
  mapPoster: [[20, 12], [21, 12]] as Cell[],
  // Office machines along the wall (city sheet).
  vending: [[28, 7], [29, 7]] as Cell[],
  printer: [27, 8] as Cell,
  cooler: [28, 14] as Cell,
  // Lounge (indoor sheet): a cushioned bench as the sofa, a cloth-covered table.
  sofa: [[4, 7], [5, 7], [6, 7], [7, 7]] as Cell[],
  coffeeTable: [[7, 9], [8, 9], [9, 9]] as Cell[],
};

// Character layers on the Kenney character sheet (front-facing, 16x16, stacked).
const BODIES: Cell[] = [[0, 0], [0, 1], [0, 2]];
const PANTS: Cell[] = [[3, 0], [3, 1], [3, 2], [3, 3]];
const HAIR: Cell[] = [
  ...[0, 1, 4, 5].flatMap((r) => [19, 20, 21, 22, 23, 24, 25, 26].map((c) => [c, r] as Cell)),
  [19, 8], [20, 8], [21, 8], [22, 8],
];
/** Shirt colour family tells you the agent type at a glance. */
const SHIRTS: Record<string, Cell[]> = {
  claude: [[6, 0], [7, 0], [8, 0], [6, 2], [7, 2], [8, 2]], // orange
  codex: [[10, 0], [11, 0], [12, 0], [10, 2], [11, 2], [12, 2]], // teal
  gemini: [[14, 0], [15, 0], [16, 0], [14, 2], [15, 2], [16, 2]], // lilac
  default: [[6, 5], [7, 5], [8, 5], [6, 7], [7, 7]], // green
};

export function preloadAssets(scene: Phaser.Scene): void {
  for (const [key, s] of Object.entries(SHEETS)) {
    scene.load.spritesheet(key, s.url, { frameWidth: TILE, frameHeight: TILE, spacing: s.spacing });
  }
}

export function frameIndex(sheet: SheetKey, [col, row]: Cell): number {
  return row * SHEETS[sheet].cols + col;
}

/** Composite several 16x16 frames (bottom layer first) into a new canvas texture, laid out in a row grid. */
function compose(scene: Phaser.Scene, key: string, cols: number, rows: number, layers: { sheet: SheetKey; cell: Cell; x: number; y: number }[]): string {
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, cols * TILE, rows * TILE)!;
  const ctx = tex.context;
  for (const l of layers) {
    const f = scene.textures.getFrame(l.sheet, frameIndex(l.sheet, l.cell));
    ctx.drawImage(f.source.image as CanvasImageSource, f.cutX, f.cutY, TILE, TILE, l.x * TILE, l.y * TILE, TILE, TILE);
  }
  tex.refresh();
  return key;
}

export function characterTexture(scene: Phaser.Scene, agentType: string, seed: number): string {
  const shirts = SHIRTS[agentType] ?? SHIRTS.default;
  const pick = <T,>(list: T[], salt: number) => list[(seed >>> salt) % list.length];
  const body = pick(BODIES, 0);
  const pants = pick(PANTS, 3);
  const shirt = pick(shirts, 6);
  const hair = pick(HAIR, 11);
  const key = `char:${body}:${pants}:${shirt}:${hair}`;
  return compose(scene, key, 1, 1, [body, pants, shirt, hair].map((cell) => ({ sheet: 'chars' as const, cell, x: 0, y: 0 })));
}

export function deskTexture(scene: Phaser.Scene): string {
  return compose(scene, 'desk3', 3, 1, FRAMES.desk.map((cell, i) => ({ sheet: 'indoor' as const, cell, x: i, y: 0 })));
}

export function sideboardTexture(scene: Phaser.Scene): string {
  return compose(scene, 'sideboard', 2, 1, FRAMES.sideboard.map((cell, i) => ({ sheet: 'indoor' as const, cell, x: i, y: 0 })));
}

export function floorTexture(scene: Phaser.Scene): string {
  return compose(scene, 'floor-tile', 2, 2, FRAMES.floor.map((cell, i) => ({ sheet: 'city' as const, cell, x: i % 2, y: Math.floor(i / 2) })));
}

/** Two-tile-high wall strip: brick on top, a band of windows with brick pillars below. */
export function sofaTexture(scene: Phaser.Scene): string {
  return compose(scene, 'sofa4', 4, 1, FRAMES.sofa.map((cell, i) => ({ sheet: 'indoor' as const, cell, x: i, y: 0 })));
}

export function coffeeTableTexture(scene: Phaser.Scene): string {
  return compose(scene, 'coffee-table3', 3, 1, FRAMES.coffeeTable.map((cell, i) => ({ sheet: 'indoor' as const, cell, x: i, y: 0 })));
}

export function mapPosterTexture(scene: Phaser.Scene): string {
  return compose(scene, 'map-poster', 2, 1, FRAMES.mapPoster.map((cell, i) => ({ sheet: 'indoor' as const, cell, x: i, y: 0 })));
}

export function wallTexture(scene: Phaser.Scene): string {
  const bottom: Cell[] = [FRAMES.wallBrick, ...FRAMES.wallWindow];
  return compose(scene, 'wall-strip', bottom.length, 2, [
    ...bottom.map((_, i) => ({ sheet: 'city' as const, cell: FRAMES.wallTop, x: i, y: 0 })),
    ...bottom.map((cell, i) => ({ sheet: 'city' as const, cell, x: i, y: 1 })),
  ]);
}
