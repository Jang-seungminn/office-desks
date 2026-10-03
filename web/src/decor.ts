import Phaser from 'phaser';
import { coffeeTableTexture, FRAMES, frameIndex, mapPosterTexture, PX, SCALE, sofaTexture, type SheetKey } from './assets';

// Office interior that isn't about agents: the wall clock, the sky in the windows (follows the
// PC's clock: dawn, day, sunset, night with stars), pictures on the wall and machines along it.

const WALL_ROW = PX; // the window row starts one tile down
/** Width the chat panel covers on the right when open. */
const PANEL_COVER = 630;
const PERIOD = 4 * PX; // wall strip pattern: brick pillar + three window tiles

// 7-segment layout: which segments light for each digit (a b c d e f g).
const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

const D_W = 16; // digit width
const D_H = 28; // digit height
const T = 4; // segment thickness (pixel-art chunky)
const LED_ON = 0xff5a4f;
const LED_OFF = 0x1e0c0c;
const LED_GLOW = 0xff5a4f;

function drawDigit(g: Phaser.GameObjects.Graphics, x: number, y: number, ch: string): void {
  const on = SEGMENTS[ch] ?? '';
  const mid = y + D_H / 2 - T / 2;
  const segs: Record<string, [number, number, number, number]> = {
    a: [x + T, y, D_W - 2 * T, T],
    b: [x + D_W - T, y + T, T, D_H / 2 - T - T / 2],
    c: [x + D_W - T, mid + T, T, D_H / 2 - T - T / 2],
    d: [x + T, y + D_H - T, D_W - 2 * T, T],
    e: [x, mid + T, T, D_H / 2 - T - T / 2],
    f: [x, y + T, T, D_H / 2 - T - T / 2],
    g: [x + T, mid, D_W - 2 * T, T],
  };
  for (const [name, [sx, sy, w, h]] of Object.entries(segs)) {
    const lit = on.includes(name);
    if (lit) g.fillStyle(LED_GLOW, 0.18).fillRect(sx - 2, sy - 2, w + 4, h + 4); // soft LED bloom
    g.fillStyle(lit ? LED_ON : LED_OFF, 1).fillRect(sx, sy, w, h);
  }
}

interface Sky {
  color: number;
  alpha: number;
  stars: boolean;
  floorDim: number;
  /** City skyline behind the glass. */
  skyline: number;
  skylineAlpha: number;
}

export function skyAt(date: Date): Sky {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5.5 && h < 7.5) return { color: 0xffb38a, alpha: 0.3, stars: false, floorDim: 0.08, skyline: 0x7d6a80, skylineAlpha: 0.55 }; // dawn
  if (h >= 7.5 && h < 17) return { color: 0x9fdcff, alpha: 0.12, stars: false, floorDim: 0, skyline: 0x8aa2b6, skylineAlpha: 0.45 }; // day
  if (h >= 17 && h < 19) return { color: 0xff7f50, alpha: 0.35, stars: false, floorDim: 0.1, skyline: 0x4a2e3e, skylineAlpha: 0.7 }; // sunset
  return { color: 0x0b1633, alpha: 0.72, stars: true, floorDim: 0.22, skyline: 0x141c30, skylineAlpha: 0.95 }; // night
}

export interface LoungeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A lounge corner: rug, sofa, coffee table with a steaming mug, bookshelf, lamp and plants. */
class Lounge {
  private readonly rug: Phaser.GameObjects.Graphics;
  private readonly lampGlow: Phaser.GameObjects.Graphics;
  private readonly items: Phaser.GameObjects.Image[];
  private readonly sign: Phaser.GameObjects.Text;
  private readonly steam: Phaser.GameObjects.Image;
  private night = false;

  constructor(private readonly scene: Phaser.Scene) {
    const s = scene;
    this.rug = s.add.graphics().setDepth(-3);
    this.lampGlow = s.add.graphics().setDepth(-3);
    const plant = (i: number) => s.add.image(0, 0, 'indoor', frameIndex('indoor', FRAMES.plants[i])).setOrigin(0.5, 1).setScale(SCALE);
    this.items = [
      s.add.image(0, 0, 'bookshelf').setOrigin(1, 0).setScale(SCALE),
      s.add.image(0, 0, 'floor-lamp').setOrigin(0.5, 0).setScale(SCALE),
      s.add.image(0, 0, sofaTexture(s)).setOrigin(0.5, 0).setScale(SCALE),
      s.add.image(0, 0, coffeeTableTexture(s)).setOrigin(0.5, 0).setScale(SCALE),
      s.add.image(0, 0, 'mug').setOrigin(0.5, 1).setScale(SCALE),
      plant(0),
      plant(1),
    ];
    for (const it of this.items) it.setDepth(-2);
    this.steam = s.add.image(0, 0, 'steam').setOrigin(0.5, 1).setScale(SCALE).setDepth(-2).setAlpha(0.7);
    this.sign = s.add
      .text(0, 0, '☕ 라운지', { fontFamily: 'monospace', fontSize: '13px', fontStyle: 'bold', color: '#fdf6e3' })
      .setShadow(1, 1, '#2b1d14', 0, false, true)
      .setDepth(-2);
    s.tweens.add({ targets: this.steam, y: '-=10', alpha: 0, duration: 1600, repeat: -1, ease: 'Sine.easeOut' });
  }

  private rect: LoungeRect | null = null;

  setNight(night: boolean): void {
    if (night === this.night) return;
    this.night = night;
    this.layout(this.rect);
  }

  layout(r: LoungeRect | null): void {
    this.rect = r;
    const visible = Boolean(r);
    for (const o of [this.rug, this.lampGlow, this.sign, this.steam, ...this.items]) o.setVisible(visible);
    if (!r) return;
    const [shelf, lamp, sofa, table, mug, plantA, plantB] = this.items;

    // Rug: burgundy with a gold border and a dotted inner line.
    const g = this.rug.clear();
    g.fillStyle(0x2b1d14, 0.3).fillRoundedRect(r.x + 4, r.y + 5, r.w, r.h, 14);
    g.fillStyle(0x8c3b2b, 1).fillRoundedRect(r.x, r.y, r.w, r.h, 14);
    g.lineStyle(4, 0xd9a441, 1).strokeRoundedRect(r.x + 8, r.y + 8, r.w - 16, r.h - 16, 10);
    for (let x = r.x + 20; x < r.x + r.w - 20; x += 12) {
      g.fillStyle(0xe8c47a, 0.8).fillRect(x, r.y + 18, 4, 4).fillRect(x, r.y + r.h - 22, 4, 4);
    }

    this.sign.setPosition(r.x + 18, r.y + 22);
    shelf.setPosition(r.x + r.w - 14, r.y + 14);
    lamp.setPosition(r.x + 40, r.y + 40);
    sofa.setPosition(r.x + r.w / 2 - 10, r.y + 64);
    table.setPosition(r.x + r.w / 2 - 10, r.y + 130);
    mug.setPosition(r.x + r.w / 2 + 14, r.y + 150);
    this.steam.setPosition(mug.x + 2, mug.y - 18);
    plantA.setPosition(r.x + 26, r.y + r.h - 8);
    plantB.setPosition(r.x + r.w - 26, r.y + r.h - 8);

    // Warm light pool from the lamp; stronger at night.
    const lg = this.lampGlow.clear();
    const a = this.night ? 0.28 : 0.12;
    lg.fillStyle(0xffd27a, a).fillCircle(lamp.x, lamp.y + 12, 46);
    lg.fillStyle(0xffd27a, a * 0.6).fillCircle(lamp.x, lamp.y + 12, 70);
  }
}

/** A wall TV that cycles through live office stats. */
class WallTv {
  private readonly frame: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private readonly title: Phaser.GameObjects.Text;
  private lines: string[] = ['OFFICE DESKS'];
  private index = 0;
  private lastSwitch = 0;
  readonly width = 150;

  constructor(scene: Phaser.Scene) {
    this.frame = scene.add.graphics().setDepth(-4);
    this.title = scene.add
      .text(0, 0, 'LIVE', { fontFamily: 'monospace', fontSize: '9px', fontStyle: 'bold', color: '#ff5a4f' })
      .setDepth(-4);
    this.text = scene.add
      .text(0, 0, '', { fontFamily: 'monospace', fontSize: '13px', fontStyle: 'bold', color: '#7cf0a0', align: 'center' })
      .setOrigin(0.5)
      .setDepth(-4);
  }

  setLines(lines: string[]): void {
    this.lines = lines.length ? lines : ['OFFICE DESKS'];
    this.index %= this.lines.length;
    this.text.setText(this.lines[this.index]);
  }

  layout(cx: number): void {
    const w = this.width;
    const h = 62;
    const x = cx - w / 2;
    const y = 8;
    const g = this.frame.clear();
    g.lineStyle(2, 0x2b2118, 1).lineBetween(cx - 20, 0, cx, y).lineBetween(cx + 20, 0, cx, y); // hanging wire
    g.fillStyle(0x2b1d14, 0.35).fillRoundedRect(x + 3, y + 4, w, h, 5);
    g.fillStyle(0x1b1d22, 1).fillRoundedRect(x - 4, y - 4, w + 8, h + 8, 6);
    g.fillStyle(0x0b1a12, 1).fillRect(x + 2, y + 2, w - 4, h - 4);
    for (let sy = y + 4; sy < y + h - 2; sy += 3) g.fillStyle(0x000000, 0.18).fillRect(x + 2, sy, w - 4, 1); // scanlines
    this.title.setPosition(x + 7, y + 5);
    this.text.setPosition(cx, y + h / 2 + 4);
  }

  update(nowMs: number): void {
    if (nowMs - this.lastSwitch < 3500) return;
    this.lastSwitch = nowMs;
    this.index = (this.index + 1) % this.lines.length;
    this.text.setText(this.lines[this.index]);
  }
}

export class OfficeDecor {
  private readonly clockPanel: Phaser.GameObjects.Graphics;
  private readonly clockDigits: Phaser.GameObjects.Graphics;
  private readonly clockDate: Phaser.GameObjects.Text;
  private readonly sky: Phaser.GameObjects.Graphics;
  private readonly stars: Phaser.GameObjects.Graphics;
  /** Darkens the floor at night; rooms are drawn above it, so they read as lit islands. */
  readonly floorShade: Phaser.GameObjects.Rectangle;
  private pictures: Phaser.GameObjects.Image[] = [];
  private readonly poster: Phaser.GameObjects.Image;
  private readonly machines: Phaser.GameObjects.Image[];
  private readonly lounge: Lounge;
  private readonly tv: WallTv;
  private tvX = 0;
  private width = 0;
  private lastMinute = -1;
  private lastSecond = -1;
  private clockX = 0;

  constructor(private readonly scene: Phaser.Scene) {
    const s = scene;
    this.floorShade = s.add.rectangle(0, 0, 10, 10, 0x0b1633, 0).setOrigin(0);
    this.sky = s.add.graphics();
    this.stars = s.add.graphics();
    this.poster = s.add.image(0, PX / 2, mapPosterTexture(s)).setOrigin(0.5).setScale(2);
    const img = (sheet: SheetKey, cell: readonly [number, number]) =>
      s.add.image(0, 0, sheet, frameIndex(sheet, cell)).setOrigin(0.5, 1).setScale(SCALE);
    this.machines = [img('city', FRAMES.cooler), img('city', FRAMES.printer), img('city', FRAMES.vending[0]), img('city', FRAMES.vending[1])];
    this.clockPanel = s.add.graphics();
    this.clockDigits = s.add.graphics();
    this.clockDate = s.add
      .text(0, 0, '', { fontFamily: 'monospace', fontSize: '11px', fontStyle: 'bold', color: '#ff8a80' })
      .setOrigin(0.5, 0);
    this.lounge = new Lounge(s);
    this.tv = new WallTv(s);
    // Below everything about agents (rooms, desks use depth 0).
    this.floorShade.setDepth(-9);
    this.sky.setDepth(-7);
    this.stars.setDepth(-6);
    this.poster.setDepth(-5);
    for (const m of this.machines) m.setDepth(-5);
    this.clockPanel.setDepth(-4);
    this.clockDigits.setDepth(-4);
    this.clockDate.setDepth(-4);
  }

  /** Position everything for a new canvas width. */
  setTvLines(lines: string[]): void {
    this.tv.setLines(lines);
  }

  layout(width: number, floorHeight: number, floorTop: number, lounge: LoungeRect | null): void {
    this.width = width;
    this.lounge.layout(lounge);
    // Keep the clock and TV left of where the chat panel opens (≈600px on the right).
    const visible = Math.max(width - PANEL_COVER, 560);
    this.clockX = Math.round(Math.max(230, Math.min(visible / 2 - 60, width / 2)));
    this.tvX = this.clockX + 190;
    this.tv.layout(this.tvX);
    this.floorShade.setPosition(0, floorTop).setSize(width, floorHeight);

    // Pictures hang on the brick pillars of the window row; skip the ones under the clock.
    for (const p of this.pictures) p.destroy();
    this.pictures = [];
    let k = 0;
    for (let x = PX / 2; x < width - PX; x += PERIOD) {
      if (Math.abs(x - this.clockX) < 140 || Math.abs(x - this.tvX) < 130 || x < 3 * PX) continue;
      const cell = FRAMES.pictures[k++ % FRAMES.pictures.length];
      this.pictures.push(this.scene.add.image(x, WALL_ROW + PX / 2, 'indoor', frameIndex('indoor', cell)).setOrigin(0.5).setScale(2).setDepth(-5));
    }
    this.poster.setPosition(Math.max(150, this.clockX - 190), PX / 2 - 2);

    // Machines along the wall: water cooler and printer on the left, vending machines on the right.
    const base = 2 * PX + 30;
    const [cooler, printer, vendA, vendB] = this.machines;
    cooler.setPosition(PX * 2.2, base);
    printer.setPosition(PX * 3.3, base);
    vendA.setPosition(width - PX * 5, base);
    vendB.setPosition(width - PX * 4, base);

    this.lastMinute = -1;
    this.lastSecond = -1;
    this.update(new Date());
  }

  /** Call every frame; redraws only when the second/minute changes. */
  update(now: Date): void {
    this.tv.update(now.getTime());
    const sec = now.getSeconds();
    if (sec === this.lastSecond) return;
    this.lastSecond = sec;
    this.drawClock(now);
    const minute = now.getHours() * 60 + now.getMinutes();
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      this.drawSky(now);
    }
  }

  private drawClock(now: Date): void {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const gap = 6;
    const colonW = 8;
    const innerW = 4 * D_W + 3 * gap + colonW + gap;
    const padX = 16;
    const w = innerW + padX * 2;
    const h = D_H + 34;
    const x = this.clockX - w / 2;
    const y = 6;

    const p = this.clockPanel.clear();
    p.fillStyle(0x2b1d14, 0.35).fillRoundedRect(x + 3, y + 4, w, h, 6); // shadow on the wall
    p.fillStyle(0x6b4a32, 1).fillRoundedRect(x - 4, y - 4, w + 8, h + 8, 8); // wood frame
    p.fillStyle(0x121419, 1).fillRoundedRect(x, y, w, h, 5);
    p.fillStyle(0xffffff, 0.06).fillRect(x + 4, y + 3, w - 8, 3); // glass glint

    const g = this.clockDigits.clear();
    let dx = x + padX;
    const dy = y + 9;
    for (const [i, ch] of [...`${hh}${mm}`].entries()) {
      if (i === 2) {
        // Colon blinks every second, like a real LED clock.
        const lit = now.getSeconds() % 2 === 0 ? LED_ON : LED_OFF;
        g.fillStyle(lit, 1).fillRect(dx + 2, dy + 7, T, T).fillRect(dx + 2, dy + D_H - 11, T, T);
        dx += colonW + gap;
      }
      drawDigit(g, dx, dy, ch);
      dx += D_W + gap;
    }
    this.clockDate.setPosition(this.clockX, dy + D_H + 5);
    this.clockDate.setText(`${now.getMonth() + 1}/${now.getDate()} (${DAYS[now.getDay()]}) · ${String(now.getSeconds()).padStart(2, '0')}초`);
  }

  private drawSky(now: Date): void {
    const sky = skyAt(now);
    const g = this.sky.clear();
    const st = this.stars.clear();
    for (let x0 = 0; x0 < this.width; x0 += PERIOD) {
      // Glass occupies the three tiles after each brick pillar.
      const gx = x0 + PX;
      const gw = Math.min(3 * PX, this.width - gx);
      if (gw <= 0) continue;
      g.fillStyle(sky.color, sky.alpha).fillRect(gx + 3, WALL_ROW + 3, gw - 6, PX - 6);
      // A few city blocks along the bottom of the glass; lit windows at night.
      const bottom = WALL_ROW + PX - 3;
      for (let bx = gx + 3, i = 0; bx < gx + gw - 6; i++) {
        const bw = 10 + ((x0 + i * 37) % 14);
        const bh = 8 + ((x0 * 5 + i * 23) % 22);
        const w = Math.min(bw, gx + gw - 3 - bx);
        g.fillStyle(sky.skyline, sky.skylineAlpha).fillRect(bx, bottom - bh, w, bh);
        if (sky.stars) {
          for (let wy = bottom - bh + 3; wy < bottom - 3; wy += 5) {
            for (let wx = bx + 2; wx < bx + w - 2; wx += 4) {
              if ((wx * 7 + wy * 13 + x0) % 5 === 0) g.fillStyle(0xffd27a, 0.9).fillRect(wx, wy, 2, 2);
            }
          }
        }
        bx += w + 2;
      }
      if (sky.stars) {
        // Deterministic twinkle-free stars per pane.
        for (let i = 0; i < 6; i++) {
          const sx = gx + 8 + ((x0 * 7 + i * 53) % (gw - 16));
          const sy = WALL_ROW + 8 + ((x0 * 3 + i * 29) % (PX - 18));
          st.fillStyle(0xffffff, i % 3 === 0 ? 0.95 : 0.6).fillRect(sx, sy, i % 3 === 0 ? 3 : 2, i % 3 === 0 ? 3 : 2);
        }
      }
    }
    this.floorShade.setFillStyle(0x0b1633, sky.floorDim);
    this.lounge.setNight(sky.stars);
  }
}
