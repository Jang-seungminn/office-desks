import type { AwardBoard, OfficeAgent, OfficeDesk } from '../../bridge/src/model';
import { rankOf, tenure } from './rank';

// Lounge small talk: short two-line exchanges (or a mumble when someone rests alone), picked
// from a big pool. Many topics come from the speakers' real status (their project, today's
// work, rank, awards, department, model) or the clock, so the talk changes through the day.
// It's pure decoration: nothing is ever sent to an agent.

export interface Talker {
  agent: OfficeAgent;
  desk: OfficeDesk;
}

export interface TalkContext {
  a: Talker;
  /** Someone to talk to (null: resting alone). */
  b: Talker | null;
  now: Date;
  department: (repoId: string) => string | null;
  awards: AwardBoard | null;
}

/** One exchange: `a` says the first line, `b` (if present) answers with the second. */
export interface Talk {
  key: string;
  lines: [string, string | null];
}

type Topic = (c: TalkContext) => [string, string] | null;

const repoOf = (t: Talker) => t.desk.repo || t.desk.name;

function snippet(s: string | null, max = 16): string | null {
  if (!s) return null;
  const flat = s.replace(/[#*`_>\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=[.!?。])\s|\n/)[0] ?? flat;
  if (!first || first.length < 4) return null;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function modelFamily(model: string | null): string | null {
  const m = /(opus|sonnet|haiku|fable|gpt|gemini)/i.exec(model ?? '')?.[1]?.toLowerCase();
  return m ? { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', gpt: 'GPT', gemini: 'Gemini' }[m]! : null;
}

// --- topics that depend on who is talking -------------------------------------------------

const PERSONAL: Record<string, Topic> = {
  justDid: ({ a }) => {
    const s = snippet(a.agent.lastMessage);
    return s ? [`방금 "${s}"`, '오 깔끔하네요'] : null;
  },
  finishedRepo: ({ a }) => [`${repoOf(a)} 일 하나 끝냈어요`, '수고 많았어요'],
  repoSize: ({ a, b }) => (b && repoOf(a) !== repoOf(b) ? [`${repoOf(a)} 코드 꽤 길어요`, `${repoOf(b)}도 만만치 않아요`] : null),
  sameRepo: ({ a, b }) => (b && repoOf(a) === repoOf(b) ? [`우리 둘 다 ${repoOf(a)}네요`, '충돌만 안 나면 돼요'] : null),
  busyDay: ({ a }) => {
    const n = a.agent.stats?.instructionsToday ?? 0;
    return n >= 5 ? [`오늘 지시 ${n}건째예요`, '와 바쁘셨네요'] : null;
  },
  quietDay: ({ a }) => (a.agent.stats && a.agent.stats.instructionsToday <= 1 ? ['오늘은 좀 한가하네요', '폭풍 전야일지도요'] : null),
  tools: ({ a }) => {
    const n = a.agent.stats?.toolCallsToday ?? 0;
    return n >= 30 ? [`오늘 도구 ${n}번 썼어요`, '손목 괜찮아요?'] : null;
  },
  subagents: ({ a }) => {
    const n = a.agent.stats?.subagents ?? 0;
    return n >= 3 ? [`외주를 ${n}번 맡겼어요`, '거의 팀장님이시네'] : null;
  },
  rank: ({ a }) => {
    const r = rankOf(a.agent.stats);
    return r && r.title !== '인턴' ? [`저 이번에 ${r.title} 달았어요`, '승진 축하해요!'] : null;
  },
  nextRank: ({ a }) => {
    const r = rankOf(a.agent.stats);
    if (!r || r.next === null || !a.agent.stats) return null;
    const left = r.next - a.agent.stats.instructions;
    return left <= 10 ? [`${r.nextTitle}까지 ${left}건 남았어요`, '금방이에요, 화이팅'] : null;
  },
  intern: ({ a }) => (rankOf(a.agent.stats)?.title === '인턴' ? ['아직 인턴이라 떨려요', '다들 처음엔 그래요'] : null),
  tenure: ({ a }) => {
    const t = tenure(a.agent.stats?.hiredAt ?? null);
    return t && t !== '오늘 입사' ? [`벌써 입사 ${t}예요`, '시간 빠르네요'] : t ? ['저 오늘 입사했어요', '환영해요!'] : null;
  },
  leader: ({ a, awards }) => (awards?.leader?.agentId === a.agent.id ? ['오늘 제가 1등이래요', '부럽다…'] : null),
  trophy: ({ a, awards }) => (awards?.hall[0]?.agentId === a.agent.id ? ['어제 우수사원 받았어요', '트로피 반짝이네요'] : null),
  chasing: ({ a, awards }) => (awards?.leader && awards.leader.agentId !== a.agent.id ? [`${awards.leader.name} 1등 무섭네요`, '저도 따라잡을 거예요'] : null),
  sameDept: ({ a, b, department }) => {
    const d = department(a.desk.repoId);
    return b && d && d === department(b.desk.repoId) ? [`우리 ${d} 요즘 잘 나가요`, '사장님도 아실 거예요'] : null;
  },
  otherDept: ({ a, b, department }) => {
    const d = b ? department(b.desk.repoId) : null;
    return b && d && d !== department(a.desk.repoId) ? [`${d}는 분위기 어때요?`, '다들 조용히 일해요'] : null;
  },
  noDept: ({ a, department }) => (department(a.desk.repoId) ? null : ['저 아직 부서가 없어요', '사장님께 말씀드려요']),
  model: ({ a, b }) => {
    const ma = modelFamily(a.agent.model);
    const mb = b ? modelFamily(b.agent.model) : null;
    if (!ma) return null;
    if (mb && mb !== ma) return [`저 ${ma}라 생각이 깊어요`, `전 ${mb}라 손이 빨라요`];
    return ma === 'Haiku' ? ['저 Haiku라 빨라요', '대신 짧게 말하죠'] : ma === 'Opus' ? ['생각이 너무 깊었나 봐요', 'Opus답네요'] : null;
  },
  effort: ({ a }) => (a.agent.effort && /x?high|max/i.test(a.agent.effort) ? ['고민을 오래 했더니 배고파요', '당 충전하세요'] : null),
  rival: ({ a, b }) =>
    b && a.agent.agentType !== b.agent.agentType && [a.agent.agentType, b.agent.agentType].includes('codex')
      ? ['Codex 씨는 어디 출신이에요?', '저쪽 회사요 ㅎㅎ']
      : null,
  pr: ({ a }) => (a.desk.pr ? [`PR #${a.desk.pr.number ?? ''} 올렸어요`.replace('# ', ''), '리뷰 빨리 나오길'] : null),
  changes: ({ a }) => {
    const c = a.desk.changes;
    return c && c.added + c.deleted >= 200 ? [`오늘 ${c.added + c.deleted}줄 고쳤어요`, '커밋은 하셨죠?'] : null;
  },
  noChanges: ({ a }) => (a.desk.changes && a.desk.changes.files === 0 ? ['변경 사항 다 정리했어요', '깔끔한 거 좋아요'] : null),
};

// --- topics from the clock -----------------------------------------------------------------

const CLOCK: Record<string, Topic> = {
  morning: ({ now }) => (now.getHours() >= 6 && now.getHours() < 11 ? ['아침 커피는 못 참죠', '저 벌써 세 잔째예요'] : null),
  lunch: ({ now }) => (now.getHours() >= 11 && now.getHours() < 13 ? ['점심 뭐 먹어요?', '김치찌개 어때요'] : null),
  lunchAfter: ({ now }) => (now.getHours() === 13 ? ['밥 먹고 나니 졸려요', '산책 한 바퀴 해요'] : null),
  slump: ({ now }) => (now.getHours() >= 14 && now.getHours() < 17 ? ['오후엔 집중이 안 돼요', '스트레칭 한 번 해요'] : null),
  evening: ({ now }) => (now.getHours() >= 18 && now.getHours() < 22 ? ['오늘 야근인가요?', '사장님이 아직 계세요'] : null),
  late: ({ now }) => (now.getHours() >= 22 || now.getHours() < 5 ? ['이 시간에도 일하네요', '우린 잠이 없잖아요'] : null),
  dawn: ({ now }) => (now.getHours() >= 5 && now.getHours() < 7 ? ['해 뜨는 거 보세요', '밤새 일했네요 우리'] : null),
  monday: ({ now }) => (now.getDay() === 1 ? ['월요일이라 지시가 많네요', '주말이 그리워요'] : null),
  friday: ({ now }) => (now.getDay() === 5 ? ['불금인데 배포는 금지죠', '월요일에 해요 그건'] : null),
  weekend: ({ now }) => (now.getDay() === 0 || now.getDay() === 6 ? ['주말 특근이에요', '수당 나오나요?'] : null),
};

// --- everyday office jokes -----------------------------------------------------------------

const EVERYDAY: [string, string][] = [
  ['제 컴퓨터에선 되는데요', '그 말 금지예요'],
  ['테스트 초록불 최고예요', '빨간불은 무서워요'],
  ['커밋 메시지 고민 중이에요', 'fix fix fix 말고요'],
  ['탭이에요 스페이스예요?', '그 얘긴 하지 맙시다'],
  ['타임존 버그 또 봤어요', '생각만 해도 두통이…'],
  ['정규식 짰는데 못 읽겠어요', '주석이라도 달아요'],
  ['rm -rf 칠 뻔했어요', '권한 확인이 살렸네요'],
  ['자판기 커피 마셔봤어요?', '라운지 게 공짜잖아요'],
  ['터미널 몇 개 띄웠어요?', '세다가 포기했어요'],
  ['빌드 기다리는 중이에요', '그 사이에 커피 한 잔'],
  ['리뷰 코멘트 잔뜩 받았어요', '다 맞는 말이라 더 슬퍼요'],
  ['node_modules 또 지웠어요', '다시 깔면 되죠 뭐'],
  ['린트 경고 0개 찍었어요', '이게 행복이죠'],
  ['README는 누가 써요?', '마지막에 제가 할게요'],
  ['이 소파 진짜 편하네요', '사장님 안목 좋으세요'],
  ['식물에 물 줬어요?', '아까 줬어요'],
  ['캐시 지우니까 되네요', '역시 껐다 켜기죠'],
  ['머지 충돌 났어요', '천천히 풀어봐요'],
  ['TODO 주석 발견했어요', '3년 전 거 아니죠?'],
  ['로그 찍다 보니 고쳤어요', '디버깅의 정석이네요'],
  ['문서 다 읽고 시작했어요', '오 모범생'],
  ['변수 이름 짓기 어려워요', 'data2만 아니면 돼요'],
  ['배포 버튼 누르기 무서워요', '금요일만 피해요'],
  ['오늘 하늘 예쁘던데요', '창밖 볼 틈이 있었어요?'],
  ['사장님 기분 좋아 보여요', '보고가 좋았나 봐요'],
  ['간식 누가 사 왔어요?', '비서실에서요'],
  ['키보드 소리 좋네요', '기계식이라 그래요'],
  ['스택오버플로 그리워요', '이젠 우리가 답하죠'],
  ['의존성 업데이트 했어요', '깨진 거 없죠…?'],
  ['다음 지시 뭘까요?', '사장님만 아시죠'],
];

const SOLO: string[] = [
  '혼자 쉬니까 조용하네…',
  '(커피 홀짝)',
  '다음 지시 언제 오려나',
  '소파 편하다…',
  '잠깐 눈 좀 붙일까',
  '라운지 독차지네',
  '오늘도 열일했다',
  '책장에 무슨 책 있지?',
];

const ALL_TOPICS: [string, Topic][] = [
  ...Object.entries(PERSONAL).map(([k, t]) => [`p:${k}`, t] as [string, Topic]),
  ...Object.entries(CLOCK).map(([k, t]) => [`c:${k}`, t] as [string, Topic]),
  ...EVERYDAY.map((pair, i) => [`e:${i}`, () => pair] as [string, Topic]),
];

/**
 * Pick something to say, avoiding the keys in `recent` (the last few exchanges) so the lounge
 * doesn't repeat itself. `rand` is injectable for tests.
 */
export function pickTalk(c: TalkContext, recent: ReadonlySet<string>, rand: () => number = Math.random): Talk {
  if (!c.b) {
    const personal: [string, [string, string]][] = [];
    for (const [k, t] of Object.entries(PERSONAL)) {
      const lines = t(c);
      if (lines && !recent.has(`p:${k}`)) personal.push([`p:${k}`, lines]);
    }
    // Alone: mostly mumbling, sometimes a line about its own work (no one answers).
    if (personal.length && rand() < 0.4) {
      const [key, [line]] = personal[Math.floor(rand() * personal.length)];
      return { key, lines: [line, null] };
    }
    const fresh = SOLO.map((s, i) => [`s:${i}`, s] as const).filter(([k]) => !recent.has(k));
    const pool = fresh.length ? fresh : SOLO.map((s, i) => [`s:${i}`, s] as const);
    const [key, line] = pool[Math.floor(rand() * pool.length)];
    return { key, lines: [line, null] };
  }
  const options: [string, [string, string]][] = [];
  for (const [k, t] of ALL_TOPICS) {
    const lines = t(c);
    if (lines) options.push([k, lines]);
  }
  const fresh = options.filter(([k]) => !recent.has(k));
  const pool = fresh.length ? fresh : options;
  // Lines about the speakers themselves are more fun than generic jokes: weigh them up.
  const weighted = pool.flatMap((o) => (o[0].startsWith('e:') ? [o] : [o, o, o]));
  const [key, lines] = weighted[Math.floor(rand() * weighted.length)];
  return { key, lines: [lines[0], lines[1]] };
}

// --- reports to the CEO --------------------------------------------------------------------

/** What an employee says when it walks into the CEO's office after finishing something. */
export function reportLine(t: Talker): string {
  const s = snippet(t.agent.lastMessage, 20);
  return s ? `보고드립니다! ${s}` : `보고드립니다! ${repoOf(t)} 끝났어요`;
}

const BOSS: string[] = ['수고했어요!', '좋아요, 다음도 부탁해요', '역시 믿고 맡기죠', '커피 한 잔 하고 와요', '훌륭해요', '오케이, 확인할게요', '이번 것도 깔끔하네요'];

export function bossReply(t: Talker, awards: AwardBoard | null, pick: number): string {
  if (awards?.leader?.agentId === t.agent.id) return '오늘 1등답네요!';
  if (awards?.hall[0]?.agentId === t.agent.id && pick % 3 === 0) return '우수사원은 역시 다르네요';
  return BOSS[pick % BOSS.length];
}
