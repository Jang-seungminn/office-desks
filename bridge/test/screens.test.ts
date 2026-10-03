import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentQuestion, isReviewScreen } from '../src/answer.js';
import { composerState } from '../src/screen.js';

// Contract tests against real captured TUI screens, one folder per Claude Code version.
const root = new URL('./fixtures/screens/', import.meta.url);
const expected: Record<string, { composer: string; question?: string | null; review?: boolean }> = {
  'composer-queued.txt': { composer: 'ready', question: null },
  'composer-working.txt': { composer: 'ready', question: null },
  'question-single-with-pane.txt': { composer: 'menu', question: '[화면 캡처용 테스트] 질문이 하나일 때의' },
  'question-multi-first.txt': { composer: 'menu', question: 'Which color?' },
  'question-multi-review.txt': { composer: 'menu', review: true },
  'trust-dialog.txt': { composer: 'menu', question: null },
};

for (const version of readdirSync(root)) {
  describe(`Claude Code ${version} screens`, () => {
    for (const file of readdirSync(new URL(`${version}/`, root)).filter((f) => f.endsWith('.txt'))) {
      it(file, () => {
        const lines = readFileSync(new URL(`${version}/${file}`, root), 'utf8').split('\n');
        const want = expected[file];
        expect(want, `add an expectation for ${file}`).toBeDefined();
        expect(composerState(lines, 'claude')).toBe(want.composer);
        if (want.question === null) expect(currentQuestion(lines)).toBeNull();
        else if (want.question) expect(currentQuestion(lines)?.startsWith(want.question)).toBe(true);
        if (want.review !== undefined) expect(isReviewScreen(lines)).toBe(want.review);
      });
    }
  });
}
