import Phaser from 'phaser';
import type { AwardBoard, OfficeAgent, OfficeDesk } from '../../bridge/src/model';
import { bossReply, pickTalk, reportLine } from './chatter';
import { characterTexture, SCALE } from './assets';
import type { LoungeRect } from './decor';
import { PX11 } from './fonts';

// Agents that finished and have been resting a while walk to the lounge, sit on the sofa or
// stand by the coffee table, and chat (see chatter.ts: no tokens spent). Work for them, a
// question, or an unopened report sends them back to the desk. Now and then someone who just
// finished walks into the CEO's office to report, then goes back to the desk.

/** Rest this long after finishing before heading to the lounge. */
export const LOUNGE_AFTER_MS = 3 * 60_000;
const WALK_PX_PER_S = 200;
const CHAT_EVERY_MS = 7000;
const BUBBLE_MS = 4200;

export interface Spot {
  x: number;
  y: number;
}

/** Where loungers stand (character top-centre): three on the sofa, two by the table. */
export function loungeSlots(r: LoungeRect): Spot[] {
  const cx = r.x + r.w / 2 - 10; // same centre line as the sofa and table (decor.ts)
  return [
    { x: cx - 50, y: r.y + 50 },
    { x: cx, y: r.y + 50 },
    { x: cx + 50, y: r.y + 50 },
    { x: cx - 100, y: r.y + 118 },
    { x: cx + 94, y: r.y + 118 },
  ];
}

export interface Resting {
  agent: OfficeAgent;
  desk: OfficeDesk;
}

/** Who may go to the lounge right now: finished a while ago and nothing you haven't seen. */
export function restingAgents(desks: OfficeDesk[], unseen: ReadonlySet<string>, now: number, max: number): Resting[] {
  return desks
    .flatMap((desk) => desk.agents.map((agent) => ({ agent, desk })))
    .filter(({ agent }) => agent.state === 'done' && agent.since !== null && now - agent.since >= LOUNGE_AFTER_MS && !unseen.has(agent.id))
    .sort((a, b) => (a.agent.since ?? 0) - (b.agent.since ?? 0) || a.agent.id.localeCompare(b.agent.id))
    .slice(0, max);
}

interface Walker {
  /** In the lounge, or on an errand to the CEO's office. */
  mode: 'lounge' | 'report';
  img: Phaser.GameObjects.Image;
  target: Spot;
  leaving: boolean;
  arrived: boolean;
  bubble: Phaser.GameObjects.Text | null;
  bubbleUntil: number;
  /** Replies float higher so they don't cover the line they answer. */
  bubbleLift: number;
  resting: Resting;
}

export class LoungeCrowd {
  private walkers = new Map<string, Walker>();
  private nextChat = 0;
  private turn = 0;
  /** Recently used talk topics, so the lounge doesn't repeat itself. */
  private recent: string[] = [];
  /** Bubbles over things that aren't walkers (the boss). */
  private floating: { text: Phaser.GameObjects.Text; until: number }[] = [];
  /** Facts the chatter uses (department names, awards). */
  department: (repoId: string) => string | null = () => null;
  awards: AwardBoard | null = null;
  /** A walker got back to its desk: the desk should show the character again. */
  onReturned: () => void = () => {};

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly onClick: (deskId: string, agentId: string) => void,
  ) {}

  /** Agents in the lounge or on their way there/back (their desks show an empty chair). */
  has(agentId: string): boolean {
    return this.walkers.has(agentId);
  }

  /** Same set the crowd would pick, to tell whether a relayout is needed. */
  sameAs(ids: string[]): boolean {
    const here = [...this.walkers].filter(([, w]) => !w.leaving).map(([id]) => id);
    return here.length === ids.length && ids.every((id) => this.walkers.get(id)?.leaving === false);
  }

  /**
   * Bring the crowd in line with who should be resting. `deskSpot` gives where an agent's
   * character sits at its desk (start and end of the walk).
   */
  sync(resting: Resting[], slots: Spot[], deskSpot: (agentId: string) => Spot | null): void {
    const want = new Map(resting.map((r) => [r.agent.id, r]));
    for (const [id, w] of this.walkers) {
      if (w.mode === 'report' || want.has(id)) continue;
      const home = deskSpot(id);
      if (!home) {
        this.drop(id);
        continue;
      }
      w.leaving = true;
      w.arrived = false;
      w.target = home;
      this.hideBubble(w);
    }
    let i = 0;
    for (const [id, r] of want) {
      const slot = slots[i++];
      const w = this.walkers.get(id);
      if (w?.mode === 'report') continue; // finishes its errand first
      if (w) {
        w.resting = r;
        if (w.leaving || w.target.x !== slot.x || w.target.y !== slot.y) {
          w.leaving = false;
          w.arrived = false;
          w.target = slot;
        }
        continue;
      }
      this.walkers.set(id, this.spawn('lounge', r, deskSpot(id) ?? slot, slot));
    }
  }

  private spawn(mode: Walker['mode'], r: Resting, from: Spot, to: Spot): Walker {
    const img = this.scene.add
      .image(from.x, from.y, characterTexture(this.scene, r.agent.agentType, hashId(r.agent.id)))
      .setOrigin(0.5, 0)
      .setScale(SCALE)
      .setDepth(1)
      .setInteractive({ useHandCursor: true });
    img.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if ((p.event?.target ?? null) === this.scene.game.canvas) this.onClick(r.desk.id, r.agent.id);
    });
    return { mode, img, target: to, leaving: false, arrived: false, bubble: null, bubbleUntil: 0, bubbleLift: 0, resting: r };
  }

  /** What the agent's desk should say while it's away (null: it's at the desk). */
  awayText(agentId: string): string | null {
    const w = this.walkers.get(agentId);
    if (!w) return null;
    return w.mode === 'report' ? '사장실에 보고하는 중' : '라운지에서 휴식 중';
  }

  /**
   * Walk from the desk into the CEO's office, report, hear the boss, walk back. Returns false
   * if the agent is already out (lounge or another errand).
   */
  report(r: Resting, home: Spot, standAt: Spot, boss: Spot): boolean {
    if (this.walkers.has(r.agent.id)) return false;
    const w = this.spawn('report', r, home, standAt);
    this.walkers.set(r.agent.id, w);
    this.errands.set(r.agent.id, { home, boss, phase: 'going' });
    return true;
  }

  get reporting(): boolean {
    return [...this.walkers.values()].some((w) => w.mode === 'report');
  }

  private errands = new Map<string, { home: Spot; boss: Spot; phase: 'going' | 'talking' | 'back' }>();

  /** A reporter reached the CEO: say the report, let the boss answer, then head home. */
  private onReportArrived(w: Walker, now: number): void {
    const id = w.resting.agent.id;
    const e = this.errands.get(id);
    if (!e) return;
    if (e.phase === 'going') {
      e.phase = 'talking';
      w.img.setFlipX(false);
      this.say(w, reportLine(w.resting), now, 0);
      const pick = this.turn++;
      this.scene.time.delayedCall(1600, () => this.floatAt(e.boss, bossReply(w.resting, this.awards, pick), this.scene.time.now));
      this.scene.time.delayedCall(4200, () => {
        if (this.walkers.get(id) !== w) return;
        e.phase = 'back';
        w.leaving = true;
        w.arrived = false;
        w.target = e.home;
        this.hideBubble(w);
      });
    }
  }

  private floatAt(at: Spot, text: string, now: number): void {
    const t = this.scene.add
      .text(at.x, at.y - 4, text, { ...PX11, color: '#2b2118', backgroundColor: '#ffe39a', padding: { x: 5, y: 3 } })
      .setOrigin(0.5, 1)
      .setDepth(3);
    this.floating.push({ text: t, until: now + BUBBLE_MS });
  }

  private drop(id: string): void {
    const w = this.walkers.get(id);
    if (!w) return;
    this.hideBubble(w);
    w.img.destroy();
    this.walkers.delete(id);
    this.errands.delete(id);
  }

  private hideBubble(w: Walker): void {
    w.bubble?.destroy();
    w.bubble = null;
  }

  /** Every frame: walk (with a little bob), chat now and then. */
  step(dtMs: number, now: number): void {
    let returned = false;
    for (const [id, w] of this.walkers) {
      const dx = w.target.x - w.img.x;
      const dy = w.target.y - w.img.y;
      const dist = Math.hypot(dx, dy);
      const stepPx = (WALK_PX_PER_S * dtMs) / 1000;
      if (dist <= stepPx || dist < 0.5) {
        w.img.setPosition(w.target.x, w.target.y);
        if (!w.arrived) {
          w.arrived = true;
          if (w.leaving) {
            this.drop(id);
            returned = true;
            continue;
          }
          if (w.mode === 'report') this.onReportArrived(w, now);
        }
      } else {
        const bob = Math.sin(now / 90) * 2;
        w.img.setPosition(w.img.x + (dx / dist) * stepPx, w.img.y + (dy / dist) * stepPx + bob * 0.15);
        w.img.setFlipX(dx < 0);
      }
      if (w.bubble) {
        if (now > w.bubbleUntil) this.hideBubble(w);
        else w.bubble.setPosition(w.img.x, w.img.y - 4 - w.bubbleLift);
      }
    }
    this.floating = this.floating.filter((f) => {
      if (now <= f.until) return true;
      f.text.destroy();
      return false;
    });
    if (returned) this.onReturned();
    if (now >= this.nextChat) {
      this.nextChat = now + CHAT_EVERY_MS;
      this.chat(now);
    }
  }

  private chat(now: number): void {
    const seated = [...this.walkers.values()].filter((w) => w.mode === 'lounge' && w.arrived && !w.leaving);
    if (!seated.length) return;
    const a = seated[Math.floor(Math.random() * seated.length)];
    const others = seated.filter((w) => w !== a);
    const b = others.length ? others[Math.floor(Math.random() * others.length)] : null;
    const talk = pickTalk(
      { a: a.resting, b: b?.resting ?? null, now: new Date(), department: this.department, awards: this.awards },
      new Set(this.recent),
    );
    this.recent = [talk.key, ...this.recent].slice(0, 12);
    this.say(a, talk.lines[0], now, 0);
    const reply = talk.lines[1];
    if (b && reply) {
      this.scene.time.delayedCall(1800, () => {
        if (this.walkers.get(b.resting.agent.id) === b && !b.leaving) this.say(b, reply, this.scene.time.now, 24);
      });
    }
  }

  private say(w: Walker, text: string, now: number, lift: number): void {
    this.hideBubble(w);
    w.bubbleLift = lift;
    w.bubble = this.scene.add
      .text(w.img.x, w.img.y - 4 - lift, text, { ...PX11, color: '#2b2118', backgroundColor: '#fdf6e3', padding: { x: 5, y: 3 } })
      .setOrigin(0.5, 1)
      .setDepth(3);
    w.bubbleUntil = now + BUBBLE_MS;
  }

  clear(): void {
    for (const id of [...this.walkers.keys()]) this.drop(id);
    for (const f of this.floating) f.text.destroy();
    this.floating = [];
  }
}

function hashId(s: string): number {
  // Must match the seat's seed (officeScene hash) so the same person walks over.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
