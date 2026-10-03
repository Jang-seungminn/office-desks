import type { AskedQuestion, TerminalKey } from './model.js';

// Answer a Claude Code AskUserQuestion dialog by pressing keys, the way a person would.
// Verified against Claude Code 2.1: the dialog shows a tab row (`←  ☐ Color  ☐ Sizes  ✔ Submit  →`)
// with the current question on the next line, then numbered options.
//   single-select: pressing the option's number selects it and moves to the next question
//   multi-select:  numbers toggle options; → moves on
//   review screen: "Ready to submit your answers?" with "1. Submit answers"
// Before every keystroke the screen is checked, so keys never land in the wrong dialog.

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The question the dialog is currently showing, or null if no question dialog is visible. */
export function currentQuestion(lines: string[]): string | null {
  const tab = lines.findIndex((l) => /^\s*←.*→\s*$/.test(l));
  if (tab >= 0) {
    // The question may wrap onto several lines until the first numbered option.
    const out: string[] = [];
    for (let i = tab + 1; i < lines.length; i++) {
      if (/^\s*(❯\s*)?\d+\.\s/.test(lines[i])) break;
      if (lines[i].trim()) out.push(lines[i]);
    }
    return out.length ? norm(out.join(' ')) : null;
  }
  return null;
}

export function isReviewScreen(lines: string[]): boolean {
  return lines.some((l) => /Ready to submit your answers\?/.test(l)) && lines.some((l) => /\d+\.\s*Submit answers/.test(l));
}

/** Check a request before touching the terminal. Returns an error message or null. */
export function validateChoices(questions: AskedQuestion[], choices: unknown): string | null {
  if (!Array.isArray(choices) || choices.length !== questions.length) return '모든 질문에 답해 주세요';
  for (let i = 0; i < questions.length; i++) {
    const c = choices[i];
    const q = questions[i];
    if (!Array.isArray(c) || !c.every((n) => Number.isInteger(n) && n >= 0 && n < q.options.length)) return '잘못된 선택입니다';
    if (new Set(c).size !== c.length) return '잘못된 선택입니다';
    if (q.multiSelect ? c.length < 1 : c.length !== 1) return `"${q.header || q.question}"에 답해 주세요`;
    if (q.options.length > 9) return '선택지가 너무 많아 웹에서 답할 수 없습니다. 터미널에서 답해 주세요';
  }
  return null;
}

export interface AnswerIO {
  readScreen(): Promise<string[]>;
  press(key: TerminalKey): Promise<void>;
  sleep(ms: number): Promise<void>;
}

async function waitFor<T>(io: AnswerIO, check: (lines: string[]) => T | null | false, timeoutMs: number): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const hit = check(await io.readScreen());
    if (hit) return hit;
    if (Date.now() > until) return null;
    await io.sleep(200);
  }
}

const sameQuestion = (shown: string | null, q: AskedQuestion) => {
  if (!shown) return false;
  const want = norm(q.question);
  // Long questions can be cut by the terminal width; compare a generous prefix.
  return shown.startsWith(want.slice(0, 60)) || want.startsWith(shown.slice(0, 60));
};

export async function answerQuestions(io: AnswerIO, questions: AskedQuestion[], choices: number[][]): Promise<void> {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const ok = await waitFor(io, (lines) => sameQuestion(currentQuestion(lines), q), 3000);
    if (!ok) throw new Error(`터미널에 "${q.header || q.question}" 질문이 보이지 않아 멈췄습니다. 터미널 탭에서 확인해 주세요`);
    if (q.multiSelect) {
      for (const n of choices[i]) {
        await io.press(String(n + 1) as TerminalKey);
        await io.sleep(120);
      }
      await io.press('right');
    } else {
      await io.press(String(choices[i][0] + 1) as TerminalKey);
    }
    await io.sleep(250);
  }
  // Several questions end on a review screen; a single one may submit right away.
  const review = await waitFor(io, (lines) => (isReviewScreen(lines) ? 'review' : currentQuestion(lines) === null ? 'gone' : null), 3000);
  if (review === 'review') await io.press('1');
  else if (review === null) throw new Error('답을 입력했지만 제출 화면을 확인하지 못했습니다. 터미널 탭에서 확인해 주세요');
}
