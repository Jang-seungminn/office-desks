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
const ROOM_HEADER = 34;
const ROOM_GAP = 26;
const MARGIN = 28;
const WALL_H = 2 * PX;
const FIRST_ROW_Y = WALL_H + 44;

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
    this.glow = s.add.rectangle(12, DESK_Y - 24, 44, 26, SCREEN.away, 0.9).setOrigin(0);
    const monitor = s.add.image(16, DESK_Y - 20, 'monitor-back').setOrigin(0).setScale(SCALE);
    this.activity = s.add
      .text(CX, DESK_Y + PX + 4, '', {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#fdf6e3',
        align: 'center',
        wordWrap: { width: SEAT_W - 10, useAdvancedWrap: true },
        maxLines: 2,
      })
      .setOrigin(0.5, 0)
      .setShadow(1, 1, '#2b2118', 0, false, true);

    // Model and effort of this agent's latest turn, as a small tag in the seat's corner.
    this.modelTag = s.add
      .text(4, 2, '', { fontFamily: 'monospace', fontSize: '10px', color: '#fdf6e3', backgroundColor: '#2b2118cc', padding: { x: 4, y: 2 } })
      .setVisible(false);

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
      this.activity,
      this.modelTag,
      this.bubble,
      hit,
    ]);
  }

  update(agent: OfficeAgent | null, seed: number): void {
    const state = agent?.state ?? 'away';
    this.glow.setFillStyle(SCREEN[state] ?? SCREEN.away, state === 'away' ? 0 : 0.9);
    this.activity.setText(agent ? agent.activity : '빈 자리');
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

  setSelected(on: boolean): void {
    this.selected = on;
    this.highlight.setFillStyle(on ? 0xffd166 : 0xffffff, on ? 0.3 : 0.14).setVisible(on);
  }

  destroy(): void {
    for (const t of this.tweens) t.remove();
    for (const t of this.internTweens) t.remove();
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
    this.floor = this.add.tileSprite(0, 0, 10, 10, floorTexture(this)).setOrigin(0).setTileScale(SCALE);
    this.wall = this.add.tileSprite(0, 0, 10, WALL_H, wallTexture(this)).setOrigin(0).setTileScale(SCALE);
    const plant = (i: number) => this.add.image(0, WALL_H + 30, 'indoor', frameIndex('indoor', FRAMES.plants[i])).setOrigin(0.5, 1).setScale(SCALE);
    this.decor = [
      plant(0).setX(MARGIN + 20),
      this.add.image(0, WALL_H + 30, sideboardTexture(this)).setOrigin(1, 1).setScale(SCALE),
      plant(1),
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

  setSnapshot(snapshot: OfficeSnapshot): void {
    this.snapshot = snapshot;
    if (this.sys.isActive()) this.layout();
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

    // One room per repo; inside it, one team pod per worktree (main checkout first).
    const rooms = new Map<string, OfficeDesk[]>();
    for (const d of desks) rooms.set(d.repoId, [...(rooms.get(d.repoId) ?? []), d]);
    const roomList = [...rooms.values()]
      .map((list) => list.sort((p, q) => Number(q.isMain) - Number(p.isMain) || p.name.localeCompare(q.name)))
      .sort((p, q) => p[0].repo.localeCompare(q[0].repo));

    const podH = LABEL_H + SEAT_H + POD_PAD * 2;
    const maxInner = Math.max(SEAT_W + POD_PAD * 2, width - MARGIN * 2 - ROOM_PAD * 2);
    let rx = MARGIN;
    let ry = FIRST_ROW_Y;
    let rowH = 0;

    for (const roomDesks of roomList) {
      // Lay pods out inside the room first to know its size.
      const placed: { desk: OfficeDesk; x: number; y: number; w: number }[] = [];
      let px = 0;
      let py = 0;
      let innerW = 0;
      for (const desk of roomDesks) {
        const w = Math.max(1, desk.agents.length) * SEAT_W + POD_PAD * 2;
        if (px > 0 && px + w > maxInner) {
          px = 0;
          py += podH + POD_GAP;
        }
        placed.push({ desk, x: px, y: py, w });
        px += w + POD_GAP;
        innerW = Math.max(innerW, px - POD_GAP);
      }
      const roomW = innerW + ROOM_PAD * 2;
      const roomH = ROOM_HEADER + py + podH + ROOM_PAD;
      if (rx > MARGIN && rx + roomW > width - MARGIN) {
        rx = MARGIN;
        ry += rowH + ROOM_GAP;
        rowH = 0;
      }
      this.drawRoom(roomDesks[0], roomDesks.length, rx, ry, roomW, roomH);
      for (const p of placed) this.drawPod(p.desk, rx + ROOM_PAD + p.x, ry + ROOM_HEADER + p.y, p.w, alive);
      rx += roomW + ROOM_GAP;
      rowH = Math.max(rowH, roomH);
    }

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
        this.add.text(MARGIN, FIRST_ROW_Y, 'Orca 워크트리를 기다리는 중…', { fontFamily: 'monospace', fontSize: '16px', color: '#2b2118' }),
      );
    }

    const roomH = Math.max(this.scale.height, ry + rowH + MARGIN * 2);
    this.floor.setSize(width, roomH);
    this.wall.setSize(width, WALL_H);
    this.decor[1].setX(width - MARGIN - PX);
    this.decor[2].setX(width - MARGIN - 20);
    this.cameras.main.setBounds(0, 0, width, roomH);
  }

  /** A repo's room: a carpeted area with a name plate. */
  private drawRoom(first: OfficeDesk, count: number, x: number, y: number, w: number, h: number): void {
    const g = this.add.graphics();
    g.fillStyle(0x3d3128, 0.28).fillRoundedRect(x + 4, y + 5, w, h, 12); // shadow
    g.fillStyle(0xe9dcc3, 0.92).fillRoundedRect(x, y, w, h, 12);
    g.lineStyle(4, 0x6b5038, 1).strokeRoundedRect(x, y, w, h, 12);
    const plate = this.add.text(x + ROOM_PAD, y + 7, '', { fontFamily: 'monospace', fontSize: '14px', fontStyle: 'bold', color: '#2b2118' });
    this.podLayer.add([g, plate]);
    // The worktree count only matters (and only gets room) when the repo has several.
    let metaW = 0;
    if (count > 1) {
      const meta = this.add
        .text(x + w - ROOM_PAD, y + 9, `워크트리 ${count}개`, { fontFamily: 'monospace', fontSize: '11px', color: '#7a6a58' })
        .setOrigin(1, 0);
      metaW = meta.width + 8;
      this.podLayer.add(meta);
    }
    fitText(plate, `📁 ${first.repo || first.name}`, w - ROOM_PAD * 2 - metaW);
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
    const textW = podW - POD_PAD * 2;
    const name = this.add
      .text(x + POD_PAD, y + 6, '', { fontFamily: 'monospace', fontSize: '13px', fontStyle: 'bold', color: '#fdf6e3' })
      .setShadow(1, 1, '#2b2118', 0, false, true);
    fitText(name, title, textW);
    const branch = this.add
      .text(x + POD_PAD, y + 23, '', { fontFamily: 'monospace', fontSize: '11px', color: '#e8dcc4' })
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
      seat.root.setPosition(x + POD_PAD + i * SEAT_W, y + LABEL_H + POD_PAD);
      seat.update(agent, hash(agent?.id ?? key));
      seat.setSelected(key === this.selectionKey());
    });
  }
}
