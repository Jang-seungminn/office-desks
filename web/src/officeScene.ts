import Phaser from 'phaser';
import type { OfficeAgent, OfficeDesk, OfficeSnapshot } from '../../bridge/src/model';
import {
  characterTexture,
  deskTexture,
  FRAMES,
  floorTexture,
  frameIndex,
  preloadAssets,
  PX,
  SCALE,
  sideboardTexture,
  wallTexture,
} from './assets';
import { buildTextures, iconKey, SCREEN } from './sprites';
import { modelTag } from './format';
import { PX11, PX14, PX22B } from './fonts';
import { arrangeOffice, type Room } from './arrange';
import { OfficeDecor } from './decor';

export interface Selection {
  deskId: string;
  agentId: string | null;
}

const SEAT_W = 3 * PX + 12;
const SEAT_H = 138;
const CX = SEAT_W / 2; // character centre
const CHAR_Y = 14;
const DESK_Y = 58;
const MAX_INTERNS = 3;
const BUBBLE_Y = 18; // beside the head, below the model tag
const POD_PAD = 12;
const LABEL_H = 40;
const POD_GAP = 14;
const ROOM_PAD = 14;
const ROOM_HEADER = 42;
const ROOM_GAP = 26;
const ZONE_HEADER = 30;
const ZONE_GAP = 34;
const LOUNGE_W = 250;
const LOUNGE_H = 230;
const MARGIN = 28;
const WALL_H = 2 * PX;
const FIRST_ROW_Y = WALL_H + 40;

// Team carpet colour per Orca worktree status.
const POD_TINT: Record<string, number> = {
  permission: 0x7a5a1e,
  working: 0x2f4f6f,
  active: 0x5b4636,
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Set text, shortening it with an ellipsis until it fits maxWidth pixels. */
function fitText(t: Phaser.GameObjects.Text, s: string, maxWidth: number): Phaser.GameObjects.Text {
  t.setText(s);
  if (t.width <= maxWidth) return t;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    t.setText(`${s.slice(0, mid)}…`);
    if (t.width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return t.setText(`${s.slice(0, lo)}…`);
}

function truncateTag(s: string): string {
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

export interface HoverInfo {
  deskId: string;
  agentId: string | null;
  clientX: number;
  clientY: number;
}

/** One desk + chair + (optional) character. Keyed so animations survive snapshot updates. */
class Seat {
  readonly root: Phaser.GameObjects.Container;
  private readonly glow: Phaser.GameObjects.Rectangle;
  private readonly character: Phaser.GameObjects.Image;
  private readonly bubble: Phaser.GameObjects.Container;
  private readonly bubbleIcon: Phaser.GameObjects.Image;
  private readonly activity: Phaser.GameObjects.Text;
  private readonly modelTag: Phaser.GameObjects.Text;
  /** Coffee on the desk while the agent rests after finishing. */
  private readonly mug: Phaser.GameObjects.Image;
  private readonly steam: Phaser.GameObjects.Image;
  private steamTween: Phaser.Tweens.Tween | null = null;
  private readonly badge: Phaser.GameObjects.Container;
  private badgeTween: Phaser.Tweens.Tween | null = null;
  private badgeKind: string | null = null;
  private readonly highlight: Phaser.GameObjects.Rectangle;
  private tweens: Phaser.Tweens.Tween[] = [];
  /** Small helpers standing by the desk while this agent's subagents work. */
  private readonly interns: Phaser.GameObjects.Image[] = [];
  private internTweens: Phaser.Tweens.Tween[] = [];
  private shownInterns = -1;
  private shownState = '';
  private selected = false;

  constructor(
    private readonly scene: Phaser.Scene,
    onClick: () => void,
    onHover: (over: boolean, pointer: Phaser.Input.Pointer) => void,
  ) {
    const s = scene;
    this.highlight = s.add.rectangle(0, 0, SEAT_W, SEAT_H, 0xffffff, 0.14).setOrigin(0).setVisible(false);
    // Back to front: chair, agent, desk, monitor (we see its back; its glow leaks around the edges).
    const chair = s.add.image(CX, CHAR_Y + 16, 'indoor', frameIndex('indoor', FRAMES.chair)).setOrigin(0.5, 0).setScale(SCALE);
    this.character = s.add.image(CX, CHAR_Y, '__MISSING').setOrigin(0.5, 0).setScale(SCALE).setVisible(false);
    for (let i = 0; i < MAX_INTERNS; i++) {
      this.interns.push(s.add.image(SEAT_W - 16 - i * 20, DESK_Y + 6, '__MISSING').setOrigin(0.5, 1).setScale(2).setVisible(false));
    }
    const desk = s.add.image(6, DESK_Y, deskTexture(s)).setOrigin(0).setScale(SCALE);
    this.mug = s.add.image(SEAT_W - 34, DESK_Y + 16, 'mug').setOrigin(0.5, 1).setScale(SCALE).setVisible(false);
    this.steam = s.add.image(SEAT_W - 32, DESK_Y, 'steam').setOrigin(0.5, 1).setScale(2).setVisible(false);
    this.glow = s.add.rectangle(12, DESK_Y - 24, 44, 26, SCREEN.away, 0.9).setOrigin(0);
    const monitor = s.add.image(16, DESK_Y - 20, 'monitor-back').setOrigin(0).setScale(SCALE);
    this.activity = s.add
      .text(CX, DESK_Y + PX + 4, '', {
        ...PX11,
        color: '#fdf6e3',
        align: 'center',
        wordWrap: { width: SEAT_W - 10, useAdvancedWrap: true },
        maxLines: 2,
      })
      .setOrigin(0.5, 0)
      .setShadow(1, 1, '#2b2118', 0, false, true);

    // Model and effort of this agent's latest turn, as a small tag in the seat's corner.
    this.modelTag = s.add
      .text(4, 2, '', { ...PX11, color: '#fdf6e3', backgroundColor: '#2b2118cc', padding: { x: 4, y: 2 } })
      .setVisible(false);

    // Red "new report" badge, like an app icon badge, until the agent is opened.
    const badgeBg = s.add.graphics();
    badgeBg.fillStyle(0xe5484d, 1).fillCircle(0, 0, 10).lineStyle(2, 0xffffff, 1).strokeCircle(0, 0, 10);
    const badgeText = s.add.text(0, 0, '!', { ...PX14, color: '#ffffff' }).setOrigin(0.5);
    this.badge = s.add.container(SEAT_W - 12, 10, [badgeBg, badgeText]).setVisible(false);

    const bubbleBg = s.add.graphics();
    bubbleBg.fillStyle(0xffffff, 1).fillRoundedRect(0, 0, 11 * SCALE, 11 * SCALE, 6);
    bubbleBg.lineStyle(2, 0x2b2118, 1).strokeRoundedRect(0, 0, 11 * SCALE, 11 * SCALE, 6);
    this.bubbleIcon = s.add.image(2 * SCALE, 2 * SCALE, 'icon-typing').setOrigin(0).setScale(SCALE);
    this.bubble = s.add.container(CX + 22, BUBBLE_Y, [bubbleBg, this.bubbleIcon]).setVisible(false);

    // A zone with origin 0 avoids Container hit-area offsets (containers hit-test around their centre).
    const hit = s.add.zone(0, 0, SEAT_W, SEAT_H).setOrigin(0).setInteractive({ useHandCursor: true });
    // Only react to input that actually lands on the canvas: the side panel floats above it,
    // and a click there must never select the desk underneath.
    const onCanvas = (p: Phaser.Input.Pointer) => (p.event?.target ?? null) === s.game.canvas;
    hit.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (onCanvas(p)) onClick();
    });
    hit.on('pointerover', (p: Phaser.Input.Pointer) => {
      if (!onCanvas(p)) return;
      this.highlight.setVisible(true);
      onHover(true, p);
    });
    hit.on('pointermove', (p: Phaser.Input.Pointer) => onHover(onCanvas(p), p));
    hit.on('pointerout', (p: Phaser.Input.Pointer) => {
      this.highlight.setVisible(this.selected);
      onHover(false, p);
    });

    this.root = s.add.container(0, 0, [
      this.highlight,
      chair,
      this.character,
      ...this.interns,
      desk,
      this.glow,
      monitor,
      this.mug,
      this.steam,
      this.activity,
      this.modelTag,
      this.bubble,
      this.badge,
      hit,
    ]);
  }

  /** `nameTag`: shown above the activity when a worktree has several agents, so you can tell them apart. */
  update(agent: OfficeAgent | null, seed: number, nameTag: string | null = null): void {
    const state = agent?.state ?? 'away';
    this.glow.setFillStyle(SCREEN[state] ?? SCREEN.away, state === 'away' ? 0 : 0.9);
    const activity = agent ? agent.activity : '빈 자리';
    this.activity.setText(nameTag ? `「${truncateTag(nameTag)}」\n${activity}` : activity);
    this.activity.setColor(state === 'waiting' ? '#ffd166' : '#fdf6e3');

    if (agent && state !== 'away') {
      this.character.setTexture(characterTexture(this.scene, agent.agentType, seed)).setVisible(true);
    } else {
      this.character.setVisible(false);
    }

    this.showInterns(agent && state !== 'away' ? agent.subagentsRunning : 0, seed);
    const tag = agent ? modelTag(agent.model, agent.effort) : null;
    this.modelTag.setVisible(Boolean(tag));
    if (tag) fitText(this.modelTag, tag, SEAT_W - 8);

    const icon = iconKey(state);
    this.bubble.setVisible(Boolean(icon));
    if (icon) this.bubbleIcon.setTexture(icon);

    this.showCoffee(state === 'done');

    if (state !== this.shownState) {
      this.shownState = state;
      this.animate(state);
    }
  }

  private animate(state: string): void {
    for (const t of this.tweens) t.remove();
    this.tweens = [];
    const c = this.character;
    c.setPosition(CX, CHAR_Y).setAlpha(1);
    this.glow.setAlpha(1);
    this.bubble.setY(BUBBLE_Y);
    const add = (cfg: Phaser.Types.Tweens.TweenBuilderConfig) => this.tweens.push(this.scene.tweens.add(cfg));

    switch (state) {
      case 'typing':
        add({ targets: c, y: CHAR_Y - SCALE, duration: 140, yoyo: true, repeat: -1, repeatDelay: 60 });
        add({ targets: this.glow, alpha: 0.7, duration: 220, yoyo: true, repeat: -1 });
        break;
      case 'running':
        add({ targets: c, y: CHAR_Y - SCALE, duration: 320, yoyo: true, repeat: -1 });
        add({ targets: this.glow, alpha: 0.5, duration: 500, yoyo: true, repeat: -1 });
        break;
      case 'reading':
        add({ targets: c, x: CX + SCALE, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        break;
      case 'waiting':
        c.setY(CHAR_Y - 3 * SCALE); // half stood up, looking for you
        add({ targets: this.bubble, y: BUBBLE_Y - 6, duration: 350, yoyo: true, repeat: -1, ease: 'Quad.easeOut' });
        add({ targets: this.glow, alpha: 0.4, duration: 600, yoyo: true, repeat: -1 });
        break;
      case 'done':
        c.setAlpha(0.95);
        break;
    }
  }

  private showCoffee(on: boolean): void {
    if (on === this.mug.visible) return;
    this.mug.setVisible(on);
    this.steam.setVisible(on);
    this.steamTween?.remove();
    this.steamTween = null;
    if (on) {
      this.steam.setY(DESK_Y).setAlpha(0.7);
      this.steamTween = this.scene.tweens.add({ targets: this.steam, y: DESK_Y - 12, alpha: 0, duration: 1800, repeat: -1, ease: 'Sine.easeOut' });
    }
  }

  private showInterns(running: number, seed: number): void {
    const n = Math.min(MAX_INTERNS, running);
    if (n === this.shownInterns) return;
    this.shownInterns = n;
    for (const t of this.internTweens) t.remove();
    this.internTweens = [];
    this.interns.forEach((img, i) => {
      img.setVisible(i < n);
      if (i >= n) return;
      img.setTexture(characterTexture(this.scene, 'intern', (seed + 7919 * (i + 1)) >>> 0)).setY(DESK_Y + 6);
      this.internTweens.push(
        this.scene.tweens.add({ targets: img, y: DESK_Y + 4, duration: 260 + i * 70, yoyo: true, repeat: -1, delay: i * 120 }),
      );
    });
  }

  private placed = false;
  /** Where the office wants this seat; step() glides there. The latest target always wins. */
  private target = { x: 0, y: 0 };

  /** Set a new spot when the office rearranges (jump on first placement, glide afterwards). */
  moveTo(x: number, y: number): void {
    this.target = { x, y };
    if (!this.placed) {
      this.placed = true;
      this.root.setPosition(x, y);
    }
  }

  /** Called every frame: ease toward the target, snapping when close. */
  step(dtMs: number): void {
    const r = this.root;
    const dx = this.target.x - r.x;
    const dy = this.target.y - r.y;
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      r.setPosition(this.target.x, this.target.y);
      return;
    }
    const k = Math.min(1, dtMs / 90); // ~90ms time constant: settles in about half a second
    r.setPosition(r.x + dx * k, r.y + dy * k);
  }

  setAttention(kind: string | null): void {
    if (kind === this.badgeKind) return;
    this.badgeKind = kind;
    this.badgeTween?.remove();
    this.badgeTween = null;
    this.badge.setVisible(Boolean(kind)).setScale(1);
    if (kind) {
      (this.badge.list[1] as Phaser.GameObjects.Text).setText(kind === 'waiting' ? '?' : '!');
      this.badgeTween = this.scene.tweens.add({ targets: this.badge, scale: 1.25, duration: 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
  }

  setSelected(on: boolean): void {
    this.selected = on;
    this.highlight.setFillStyle(on ? 0xffd166 : 0xffffff, on ? 0.3 : 0.14).setVisible(on);
  }

  destroy(): void {
    for (const t of this.tweens) t.remove();
    for (const t of this.internTweens) t.remove();
    this.badgeTween?.remove();
    this.steamTween?.remove();
    this.root.destroy();
  }
}

export class OfficeScene extends Phaser.Scene {
  private snapshot: OfficeSnapshot | null = null;
  private seats = new Map<string, Seat>();
  private podLayer!: Phaser.GameObjects.Container;
  private floor!: Phaser.GameObjects.TileSprite;
  private wall!: Phaser.GameObjects.TileSprite;
  private decor: Phaser.GameObjects.Image[] = [];
  private interior!: OfficeDecor;
  private selection: Selection | null = null;
  onSelect: (sel: Selection) => void = () => {};
  onHover: (info: HoverInfo | null) => void = () => {};
  /** A click on empty floor (not on any desk). */
  onBackground: () => void = () => {};

  constructor() {
    super('office');
  }

  preload(): void {
    preloadAssets(this);
  }

  create(): void {
    buildTextures(this);
    this.floor = this.add.tileSprite(0, 0, 10, 10, floorTexture(this)).setOrigin(0).setTileScale(SCALE).setDepth(-10);
    this.wall = this.add.tileSprite(0, 0, 10, WALL_H, wallTexture(this)).setOrigin(0).setTileScale(SCALE).setDepth(-8);
    this.interior = new OfficeDecor(this);
    const plant = (i: number) => this.add.image(0, WALL_H + 30, 'indoor', frameIndex('indoor', FRAMES.plants[i])).setOrigin(0.5, 1).setScale(SCALE);
    this.decor = [
      plant(0).setX(MARGIN + 20).setDepth(-5),
      this.add.image(0, WALL_H + 30, sideboardTexture(this)).setOrigin(1, 1).setScale(SCALE).setDepth(-5),
      plant(1).setDepth(-5),
    ];
    this.podLayer = this.add.container(0, 0);

    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      this.cameras.main.scrollY += dy;
    });
    this.scale.on('resize', () => this.layout());
    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (!over.length && (p.event?.target ?? null) === this.game.canvas) this.onBackground();
    });
    this.layout();
  }

  update(_time: number, delta: number): void {
    this.interior?.update(new Date());
    for (const seat of this.seats.values()) seat.step(delta);
  }

  private usageLine: string | null = null;

  /** Plan usage line for the wall TV, e.g. "5시간 22% · 주간 24%". */
  setUsageLine(line: string | null): void {
    this.usageLine = line;
    this.updateTv();
  }

  private updateTv(): void {
    const agents = this.snapshot?.desks.flatMap((d) => d.agents) ?? [];
    const busy = agents.filter((a) => ['typing', 'reading', 'running'].includes(a.state)).length;
    const waiting = agents.filter((a) => a.state === 'waiting').length;
    const subs = agents.reduce((n, a) => n + a.subagentsRunning, 0);
    const lines = [`⌨ 일하는 중 ${busy}명`, waiting ? `🙋 확인 필요 ${waiting}` : '✔ 확인 필요 없음'];
    if (subs) lines.push(`🤖 서브에이전트 ${subs}`);
    if (this.usageLine) lines.push(this.usageLine);
    this.interior?.setTvLines(lines);
  }

  setSnapshot(snapshot: OfficeSnapshot): void {
    this.snapshot = snapshot;
    this.updateTv();
    if (this.sys.isActive()) this.layout();
  }

  private attention = new Map<string, string>();

  /** agentId → 'done' | 'waiting' for agents with an unopened report. */
  setAttention(attention: Map<string, string>): void {
    // Unopened reports keep their desk on the top floor, so a change can move desks.
    const moved = [...attention.keys()].sort().join() !== [...this.attention.keys()].sort().join();
    this.attention = attention;
    if (moved && this.sys.isActive()) this.layout();
    for (const [key, seat] of this.seats) seat.setAttention(this.attention.get(key.split('|')[1]) ?? null);
  }

  setSelection(sel: Selection | null): void {
    this.selection = sel;
    for (const [key, seat] of this.seats) seat.setSelected(key === this.selectionKey());
  }

  private selectionKey(): string | null {
    if (!this.selection) return null;
    return `${this.selection.deskId}|${this.selection.agentId ?? 'empty'}`;
  }

  private layout(): void {
    const width = this.scale.width;
    const desks: OfficeDesk[] = this.snapshot?.desks ?? [];
    this.podLayer.removeAll(true);
    const alive = new Set<string>();

    // Floors by activity (working / waiting / idle); rooms per repo inside a floor, newest left.
    const zones = arrangeOffice(desks, new Set(this.attention.keys()));
    const podH = LABEL_H + SEAT_H + POD_PAD * 2;
    // A lounge corner on the right when the office is wide enough; rooms flow beside it.
    const lounge = width >= 1100 ? { x: width - MARGIN - LOUNGE_W, y: FIRST_ROW_Y + 4, w: LOUNGE_W, h: LOUNGE_H } : null;
    const usable = lounge ? width - LOUNGE_W - ROOM_GAP : width;
    const maxInner = Math.max(SEAT_W + POD_PAD * 2, usable - MARGIN * 2 - ROOM_PAD * 2);
    let ry = FIRST_ROW_Y;
    let rowH = 0;

    for (const zone of zones) {
      // Floor sign: a wooden plaque with the floor name, and a rail across the room.
      const title = this.add.text(MARGIN + 10, ry, `${zone.label} · ${zone.count}`, {
        ...PX14,
        color: '#fdf6e3',
      });
      const plaque = this.add.graphics();
      plaque.fillStyle(0x2b1d14, 0.35).fillRoundedRect(MARGIN + 3, ry - 3, title.width + 20, 26, 6);
      plaque.fillStyle(0x7a5536, 1).fillRoundedRect(MARGIN, ry - 6, title.width + 20, 26, 6);
      plaque.lineStyle(2, 0x3d2b1f, 1).strokeRoundedRect(MARGIN, ry - 6, title.width + 20, 26, 6);
      plaque.fillStyle(0xc9a25a, 1).fillCircle(MARGIN + 5, ry + 7, 2).fillCircle(MARGIN + title.width + 15, ry + 7, 2);
      const rule = this.add.graphics();
      rule.lineStyle(3, 0x6b5038, 0.45).lineBetween(MARGIN + title.width + 30, ry + 7, usable - MARGIN, ry + 7);
      this.podLayer.add([rule, plaque, title]);
      ry += ZONE_HEADER;
      let rx = MARGIN;
      rowH = 0;

      for (const room of zone.rooms) {
        // Lay pods out inside the room first to know its size.
        const placed: { desk: OfficeDesk; x: number; y: number; w: number }[] = [];
        let px = 0;
        let py = 0;
        let innerW = 0;
        for (const desk of room.desks) {
          const w = Math.max(1, desk.agents.length) * SEAT_W + POD_PAD * 2;
          if (px > 0 && px + w > maxInner) {
            px = 0;
            py += podH + POD_GAP;
          }
          placed.push({ desk, x: px, y: py, w });
          px += w + POD_GAP;
          innerW = Math.max(innerW, px - POD_GAP);
        }
        // Wide enough for the project name at its full size (plus the "워크트리 n개" note).
        const roomW = Math.max(innerW + ROOM_PAD * 2, this.plateWidth(room) + ROOM_PAD * 2);
        const roomH = ROOM_HEADER + py + podH + ROOM_PAD;
        if (rx > MARGIN && rx + roomW > usable - MARGIN) {
          rx = MARGIN;
          ry += rowH + ROOM_GAP;
          rowH = 0;
        }
        this.drawRoom(room, rx, ry, roomW, roomH);
        for (const p of placed) this.drawPod(p.desk, rx + ROOM_PAD + p.x, ry + ROOM_HEADER + p.y, p.w, alive);
        rx += roomW + ROOM_GAP;
        rowH = Math.max(rowH, roomH);
      }
      ry += rowH + ZONE_GAP;
    }
    ry -= ZONE_GAP;
    rowH = 0; // already included in ry

    for (const [key, seat] of this.seats) {
      if (!alive.has(key)) {
        seat.destroy();
        this.seats.delete(key);
      }
    }
    // Pods sit under seats; seats are added to the display list directly, so push pods to the back.
    this.children.sendToBack(this.podLayer);
    this.children.sendToBack(this.wall);
    this.children.sendToBack(this.floor);

    if (!desks.length) {
      this.podLayer.add(
        this.add.text(MARGIN, FIRST_ROW_Y, 'Orca 워크트리를 기다리는 중…', { ...PX14, color: '#2b2118' }),
      );
    }

    const roomH = Math.max(this.scale.height, ry + rowH + MARGIN * 2, FIRST_ROW_Y + LOUNGE_H + MARGIN * 2);
    this.floor.setSize(width, roomH);
    this.wall.setSize(width, WALL_H);
    this.decor[1].setX(width - MARGIN - PX);
    this.decor[2].setX(width - MARGIN - 20);
    this.interior.layout(width, roomH - WALL_H, WALL_H, lounge);
    this.cameras.main.setBounds(0, 0, width, roomH);
  }

  private plateWidths = new Map<string, number>();

  /** Pixel width the room's name plate needs (measured once per text). */
  private plateWidth(room: Room): number {
    const meta = room.total > 1 ? 90 : 0;
    const key = `📁 ${room.repo}`;
    let w = this.plateWidths.get(key);
    if (w === undefined) {
      const probe = this.add.text(0, 0, key, { ...PX22B });
      w = Math.ceil(probe.width) + 4;
      probe.destroy();
      this.plateWidths.set(key, w);
    }
    return Math.min(w, 420) + meta;
  }

  /** A repo's room on one floor: a carpeted area with a name plate. */
  private drawRoom(room: Room, x: number, y: number, w: number, h: number): void {
    const g = this.add.graphics();
    g.fillStyle(0x3d3128, 0.28).fillRoundedRect(x + 4, y + 5, w, h, 12); // shadow
    g.fillStyle(0xe9dcc3, 0.92).fillRoundedRect(x, y, w, h, 12);
    g.lineStyle(4, 0x6b5038, 1).strokeRoundedRect(x, y, w, h, 12);
    const plate = this.add.text(x + ROOM_PAD, y + 8, '', { ...PX22B, color: '#2b2118' });
    this.podLayer.add([g, plate]);
    // Worktree count only when the repo has several; "2/4" when the rest sit on other floors.
    let metaW = 0;
    if (room.total > 1) {
      const meta = this.add
        .text(x + w - ROOM_PAD, y + 13, room.desks.length === room.total ? `워크트리 ${room.total}개` : `워크트리 ${room.desks.length}/${room.total}`, {
          ...PX11,
          color: '#7a6a58',
        })
        .setOrigin(1, 0);
      metaW = meta.width + 8;
      this.podLayer.add(meta);
    }
    fitText(plate, `📁 ${room.repo}`, w - ROOM_PAD * 2 - metaW);
  }

  /** One worktree: a team carpet tinted by status, a two-line label and one seat per agent. */
  private drawPod(desk: OfficeDesk, x: number, y: number, podW: number, alive: Set<string>): void {
    const podH = LABEL_H + SEAT_H + POD_PAD * 2;
    const rug = this.add.graphics();
    const tint = POD_TINT[desk.status] ?? 0x6e6458;
    rug.fillStyle(tint, desk.status === 'inactive' ? 0.55 : 0.85);
    rug.fillRoundedRect(x, y, podW, podH, 10);
    if (desk.status === 'permission') rug.lineStyle(3, 0xe0a800, 1).strokeRoundedRect(x, y, podW, podH, 10);

    // Inside a repo room the branch is what tells worktrees apart.
    const title = desk.isMain ? `★ ${desk.branch || desk.name}` : desk.name;
    const parent = desk.parentId ? this.snapshot?.desks.find((d) => d.id === desk.parentId) : null;
    const sub = desk.isMain ? '메인 체크아웃' : desk.branch && desk.branch !== desk.name ? `⎇ ${desk.branch}` : parent ? `↳ ${parent.branch || parent.name}에서 분기` : '';
    // Right-aligned chips: open PR and uncommitted line counts.
    let chipX = x + podW - POD_PAD;
    const chip = (label: string, bg: string) => {
      const t = this.add
        .text(chipX, y + 7, label, { ...PX11, color: '#fdf6e3', backgroundColor: bg, padding: { x: 4, y: 2 } })
        .setOrigin(1, 0);
      this.podLayer.add(t);
      chipX -= t.width + 4;
    };
    if (desk.pr) chip(desk.pr.number ? `PR #${desk.pr.number}` : 'PR', desk.pr.state && /merged/i.test(desk.pr.state) ? '#6e4fb3' : '#2f7a32');
    if (desk.changes && desk.changes.files > 0) chip(`+${desk.changes.added} −${desk.changes.deleted}`, '#2b2118');
    const chipsW = x + podW - POD_PAD - chipX;
    const textW = podW - POD_PAD * 2;
    const name = this.add
      .text(x + POD_PAD, y + 6, '', { ...PX14, color: '#fdf6e3' })
      .setShadow(1, 1, '#2b2118', 0, false, true);
    fitText(name, title, textW - chipsW);
    const branch = this.add
      .text(x + POD_PAD, y + 23, '', { ...PX11, color: '#e8dcc4' })
      .setShadow(1, 1, '#2b2118', 0, false, true);
    fitText(branch, sub, textW);
    this.podLayer.add([rug, name, branch]);

    const seatsHere: (OfficeAgent | null)[] = desk.agents.length ? desk.agents : [null];
    seatsHere.forEach((agent, i) => {
      const key = `${desk.id}|${agent?.id ?? 'empty'}`;
      alive.add(key);
      let seat = this.seats.get(key);
      if (!seat) {
        const sel: Selection = { deskId: desk.id, agentId: agent?.id ?? null };
        seat = new Seat(
          this,
          () => this.onSelect(sel),
          (over, p) => {
            const ev = p.event as MouseEvent | undefined;
            this.onHover(over && ev ? { ...sel, clientX: ev.clientX, clientY: ev.clientY } : null);
          },
        );
        this.seats.set(key, seat);
      }
      seat.moveTo(x + POD_PAD + i * SEAT_W, y + LABEL_H + POD_PAD);
      // Several agents in one worktree: label each with its session title (or its type and number).
      const tag = seatsHere.length > 1 && agent ? (agent.terminalTitle ?? `${agent.agentType} ${i + 1}`) : null;
      seat.update(agent, hash(agent?.id ?? key), tag);
      seat.setSelected(key === this.selectionKey());
      seat.setAttention(agent ? (this.attention.get(agent.id) ?? null) : null);
    });
  }
}
