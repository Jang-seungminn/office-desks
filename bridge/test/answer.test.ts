import { describe, expect, it } from 'vitest';
import { answerQuestions, currentQuestion, isReviewScreen, validateChoices } from '../src/answer.js';
import type { AskedQuestion, TerminalKey } from '../src/model.js';

const QS: AskedQuestion[] = [
  { header: 'Color', question: 'Which color?', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
  { header: 'Sizes', question: 'Which sizes?', multiSelect: true, options: ['Small', 'Medium', 'Large'].map((label) => ({ label, description: '' })) },
];
const rule = '─'.repeat(40);
// Screens captured from Claude Code 2.1 (trimmed).
const q1 = ['❯ Use AskUserQuestion: Which color? Which sizes?', rule, '←  ☐ Color  ☐ Sizes  ✔ Submit  →', 'Which color?', '❯ 1. Red', '     warm', '  2. Blue', '  3. Type something.', rule, '  4. Chat about this'];
const q2 = [rule, '←  ☒ Color  ☐ Sizes  ✔ Submit  →', 'Which sizes?', '❯ 1. [ ] Small', '  2. [ ] Medium', '  3. [ ] Large', '     Submit', rule];
const review = ['←  ☒ Color  ☒ Sizes  ✔ Submit  →', 'Review your answers', ' ● Which color?', '   → Blue', 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'];
const done = ['⏺ Blue; Small, Large', rule, '❯ ', rule];

// One question, captured with a diff preview pane on the right (Claude Code 2.1).
const single = [
  '──────────────────────────────     +— they stay on the top floor. */',
  ' ☐ 캡처 테스트                                                  37 +export function zoneOf(desk',
  '                                                                   +> = NONE): ZoneKey {',
  '│ [화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에       38 +  if (desk.agents',
  '│ 터미널에서 아무거나 골라 주세요.                                  +d))) return',
  '                                                                   39    return desk',
  '❯ 1. 확인                                                          40  }',
  '     터미널에서 선택                                               41',
  '  2. 다시                                                          39 -export function recency',
  '  3. Type something.',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
];

describe('question dialog screens', () => {
  it('reads a single-question dialog (no tab row, │ prefix, text from another pane on the right)', () => {
    const shown = currentQuestion(single)!;
    expect(shown.startsWith('[화면 캡처용 테스트] 질문이 하나일 때의')).toBe(true);
  });

  it('answers a single question with one digit and no review screen', async () => {
    let screen = single;
    const pressed: TerminalKey[] = [];
    const q: AskedQuestion = {
      header: '캡처 테스트',
      question: '[화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에 터미널에서 아무거나 골라 주세요.',
      multiSelect: false,
      options: [{ label: '확인', description: '' }, { label: '다시', description: '' }],
    };
    await answerQuestions(
      { readScreen: async () => screen, sleep: async () => {}, press: async (k) => void (pressed.push(k), (screen = done)) },
      [q],
      [[1]],
    );
    expect(pressed).toEqual(['2']);
  });

  it('reads the current question from the line under the tab row (not from the echoed prompt)', () => {
    expect(currentQuestion(q1)).toBe('Which color?');
    expect(currentQuestion(q2)).toBe('Which sizes?');
    expect(currentQuestion(done)).toBeNull();
    expect(isReviewScreen(review)).toBe(true);
    expect(isReviewScreen(q2)).toBe(false);
  });

  it('validates choices against the questions', () => {
    expect(validateChoices(QS, [[1], [0, 2]])).toBeNull();
    expect(validateChoices(QS, [[1]])).not.toBeNull();
    expect(validateChoices(QS, [[0, 1], [0]])).not.toBeNull(); // two answers to a single-select
    expect(validateChoices(QS, [[1], []])).not.toBeNull();
    expect(validateChoices(QS, [[5], [0]])).not.toBeNull();
    expect(validateChoices(QS, [[1], [0, 0]])).not.toBeNull();
  });
});

/** A fake terminal that walks through the dialog like Claude Code does. */
function fakeTerminal() {
  let screen = q1;
  const pressed: TerminalKey[] = [];
  return {
    pressed,
    io: {
      readScreen: async () => screen,
      sleep: async () => {},
      press: async (k: TerminalKey) => {
        pressed.push(k);
        if (screen === q1 && /^\d$/.test(k)) screen = q2;
        else if (screen === q2 && k === 'right') screen = review;
        else if (screen === review && k === '1') screen = done;
      },
    },
  };
}

describe('answerQuestions', () => {
  it('presses digits, → after multi-select, then submits on the review screen', async () => {
    const t = fakeTerminal();
    await answerQuestions(t.io, QS, [[1], [0, 2]]);
    expect(t.pressed).toEqual(['2', '1', '3', 'right', '1']);
  });

  it('stops without typing if the expected question is not on screen', async () => {
    const pressed: TerminalKey[] = [];
    const io = { readScreen: async () => done, sleep: async () => {}, press: async (k: TerminalKey) => void pressed.push(k) };
    const realNow = Date.now;
    let t = 0;
    Date.now = () => (t += 1000);
    try {
      await expect(answerQuestions(io, QS, [[1], [0]])).rejects.toThrow(/보이지 않아/);
    } finally {
      Date.now = realNow;
    }
    expect(pressed).toEqual([]);
  });
});
