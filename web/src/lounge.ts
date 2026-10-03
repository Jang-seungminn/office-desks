import Phaser from 'phaser';
import type { OfficeAgent, OfficeDesk } from '../../bridge/src/model';
import { characterTexture, SCALE } from './assets';
import type { LoungeRect } from './decor';
import { PX11 } from './fonts';

// Agents that finished and have been resting a while walk to the lounge, sit on the sofa or
// stand by the coffee table, and chat a little (canned lines built from their own status, no
// tokens spent). Work for them, a question, or an unopened report sends them back to the desk.

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

function snippet(s: string | null, max = 20): string | null {
  if (!s) return null;
  const flat = s.replace(/[#*`_>\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=[.!?。])\s|\n/)[0] ?? flat;
  if (!first) return null;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Small talk for one lounger, from what it actually did. */
export function chatLine(r: Resting, pick: number): string {
  const repo = r.desk.repo || r.desk.name;
  const lines = [`${repo} 일 하나 끝냈어요`, '커피 맛있네요', '다음 지시 기다리는 중'];
  const said = snippet(r.agent.lastMessage);
  if (said) lines.push(`방금 "${said}"`);
  if (r.agent.stats?.instructionsToday) lines.push(`오늘 지시 ${r.agent.stats.instructionsToday}건 했어요`);
  if (r.agent.stats && r.agent.stats.subagents > 2) lines.push(`외주를 ${r.agent.stats.subagents}번이나 썼네요`);
  return lines[pick % lines.length];
}

const REPLIES = ['오 수고했어요!', '저도 거의 끝났어요', '대단하네요', '한 잔 더 해요', '사장님이 좋아하시겠어요'];

interface Walker {
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
      if (want.has(id)) continue;
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
      if (w) {
        w.resting = r;
        if (w.leaving || w.target.x !== slot.x || w.target.y !== slot.y) {
          w.leaving = false;
          w.arrived = false;
          w.target = slot;
        }
        continue;
      }
      const from = deskSpot(id) ?? slot;
      const img = this.scene.add
        .image(from.x, from.y, characterTexture(this.scene, r.agent.agentType, hashId(id)))
        .setOrigin(0.5, 0)
        .setScale(SCALE)
        .setDepth(1)
        .setInteractive({ useHandCursor: true });
      img.on('pointerdown', (p: Phaser.Input.Pointer) => {
        if ((p.event?.target ?? null) === this.scene.game.canvas) this.onClick(r.desk.id, id);
      });
      this.walkers.set(id, { img, target: slot, leaving: false, arrived: false, bubble: null, bubbleUntil: 0, bubbleLift: 0, resting: r });
    }
  }

  private drop(id: string): void {
    const w = this.walkers.get(id);
    if (!w) return;
    this.hideBubble(w);
    w.img.destroy();
    this.walkers.delete(id);
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
    if (returned) this.onReturned();
    if (now >= this.nextChat) {
      this.nextChat = now + CHAT_EVERY_MS;
      this.chat(now);
    }
  }

  private chat(now: number): void {
    const seated = [...this.walkers.values()].filter((w) => w.arrived && !w.leaving);
    if (!seated.length) return;
    const t = this.turn++;
    const a = seated[t % seated.length];
    this.say(a, chatLine(a.resting, t), now, 0);
    const others = seated.filter((w) => w !== a);
    if (others.length) {
      const b = others[t % others.length];
      this.scene.time.delayedCall(1800, () => {
        if (this.walkers.get(b.resting.agent.id) === b && !b.leaving) this.say(b, REPLIES[t % REPLIES.length], this.scene.time.now, 24);
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
  }
}

function hashId(s: string): number {
  // Must match the seat's seed (officeScene hash) so the same person walks over.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
