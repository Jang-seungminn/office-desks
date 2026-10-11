//! Answer a Claude Code AskUserQuestion dialog by pressing keys, the way a person would.
//! Port of `bridge/src/answer.ts`.
//!
//! Verified against Claude Code 2.1: the dialog shows a tab row (`←  ☐ Color  ☐ Sizes  ✔ Submit  →`)
//! with the current question on the next line, then numbered options.
//!
//! - single-select: pressing the option's number selects it and moves to the next question
//! - multi-select: numbers toggle options; `right` moves on
//! - review screen: "Ready to submit your answers?" with "1. Submit answers"
//!
//! Before every keystroke the screen is checked, so keys never land in the wrong dialog. The
//! terminal is injected through [`AnswerIO`] (a fake in tests, [`BackendAnswerIO`] in the server).

use std::sync::OnceLock;

use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;

use crate::backend::{BackendError, KeyInput, OfficeBackend};
use crate::jsstr;
use crate::model::{AskedQuestion, TerminalKey};

// JS `\s` / `.` / `\d` spelled for the regex crate (see `commands.rs`).
const S: &str = r"(?:[\s--\x{85}]|\x{FEFF})";
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

fn cached(cell: &'static OnceLock<Regex>, pattern: String) -> &'static Regex {
    cell.get_or_init(|| Regex::new(&pattern).expect("regex"))
}

fn option_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // /^\s*(❯\s*)?\d+\.\s/
    cached(&R, format!(r"^{S}*(?:❯{S}*)?[0-9]+\.{S}"))
}

/// Several questions: a tab row `←  ☐ Color  ☐ Sizes  ✔ Submit  →`. One question: just ` ☐ Header`.
/// Lines may carry another pane's text on their right (e.g. a diff preview), so nothing is
/// anchored at the end.
fn tab_row(line: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    // /^\s*←\s.*→/
    cached(&R, format!(r"^{S}*←{S}{DOT}*→")).is_match(line)
}

fn header_row(line: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    // /^\s*[☐☒✔]\s+\S/
    cached(&R, format!(r"^{S}*[☐☒✔]{S}+(?:[^\s\x{{FEFF}}]|\x{{85}})")).is_match(line)
}

fn option_row(line: &str) -> bool {
    option_re().is_match(line)
}

/// `s.replace(/\s+/g, ' ').trim()`
fn norm(s: &str) -> String {
    jsstr::collapse_ws(s)
}

/// Text from the line under the dialog's tab/header row up to the first numbered option, or None.
pub fn current_question(lines: &[String]) -> Option<String> {
    static INDENT: OnceLock<Regex> = OnceLock::new();
    static BAR: OnceLock<Regex> = OnceLock::new();
    let start = lines.iter().position(|l| tab_row(l)).or_else(|| {
        lines.iter().enumerate().position(|(i, l)| {
            header_row(l)
                && lines[i + 1..lines.len().min(i + 12)]
                    .iter()
                    .any(|x| option_row(x))
        })
    })?;
    let indent = cached(&INDENT, format!(r"^{S}{{4,}}"));
    let bar = cached(&BAR, format!(r"^{S}*│{S}?"));
    let mut out: Vec<String> = Vec::new();
    for line in &lines[start + 1..] {
        if option_row(line) {
            break;
        }
        // Only the dialog's own column: lines that start at the left edge (a pane on the right
        // shows up as lines with lots of leading space).
        if indent.is_match(line) {
            continue;
        }
        let text = jsstr::trim(&bar.replace(line, "")).to_string();
        if !text.is_empty() {
            out.push(text);
        }
    }
    (!out.is_empty()).then(|| norm(&out.join(" ")))
}

pub fn is_review_screen(lines: &[String]) -> bool {
    static SUBMIT: OnceLock<Regex> = OnceLock::new();
    lines
        .iter()
        .any(|l| l.contains("Ready to submit your answers?"))
        && lines
            .iter()
            .any(|l| cached(&SUBMIT, format!(r"[0-9]+\.{S}*Submit answers")).is_match(l))
}

/// `Number.isInteger(v)` for a JSON value.
fn as_js_integer(v: &Value) -> Option<f64> {
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0).then_some(f)
}

/// Check a request before touching the terminal. `choices` is the raw JSON the browser sent;
/// on success the parsed 0-based option indexes per question come back, which is the only form
/// [`answer_questions`] accepts, so validation cannot be skipped. `Err` is the message the
/// server shows (HTTP 400).
pub fn validate_choices(
    questions: &[AskedQuestion],
    choices: &Value,
) -> Result<Vec<Vec<usize>>, String> {
    let Some(list) = choices.as_array().filter(|c| c.len() == questions.len()) else {
        return Err("모든 질문에 답해 주세요".into());
    };
    let bad = || "잘못된 선택입니다".to_string();
    let mut parsed = Vec::with_capacity(list.len());
    for (q, c) in questions.iter().zip(list) {
        let Some(picks) = c.as_array() else {
            return Err(bad());
        };
        let mut idx = Vec::with_capacity(picks.len());
        for n in picks {
            match as_js_integer(n) {
                Some(f) if f >= 0.0 && f < q.options.len() as f64 => idx.push(f as usize),
                _ => return Err(bad()),
            }
        }
        let mut uniq = idx.clone();
        uniq.sort_unstable();
        uniq.dedup();
        if uniq.len() != idx.len() {
            return Err(bad());
        }
        if if q.multi_select {
            idx.is_empty()
        } else {
            idx.len() != 1
        } {
            let label = if q.header.is_empty() {
                &q.question
            } else {
                &q.header
            };
            return Err(format!("\"{label}\"에 답해 주세요"));
        }
        if q.options.len() > 9 {
            return Err(
                "선택지가 너무 많아 웹에서 답할 수 없습니다. 터미널에서 답해 주세요".into(),
            );
        }
        parsed.push(idx);
    }
    Ok(parsed)
}

/// The terminal the dialog is on.
#[async_trait]
pub trait AnswerIO: Send {
    async fn read_screen(&mut self) -> Result<Vec<String>, BackendError>;
    async fn press(&mut self, key: TerminalKey) -> Result<(), BackendError>;
    async fn sleep(&mut self, ms: u64);
    /// Milliseconds on any monotone clock; the driver only compares differences. Tests fake it.
    fn now_ms(&self) -> i64 {
        crate::util::epoch_ms()
    }
}

/// The server's IO: an agent's terminal reached through the backend.
pub struct BackendAnswerIO<'a> {
    pub backend: &'a dyn OfficeBackend,
    pub handle: &'a str,
}

#[async_trait]
impl AnswerIO for BackendAnswerIO<'_> {
    async fn read_screen(&mut self) -> Result<Vec<String>, BackendError> {
        self.backend.read_screen(self.handle).await
    }

    async fn press(&mut self, key: TerminalKey) -> Result<(), BackendError> {
        let input = if key == TerminalKey::Enter {
            KeyInput::Enter
        } else {
            KeyInput::Bytes(key.bytes().to_string())
        };
        self.backend.send_keys(self.handle, input).await
    }

    async fn sleep(&mut self, ms: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
}

enum Seen {
    Review,
    Gone,
}

async fn wait_for<T>(
    io: &mut dyn AnswerIO,
    check: impl Fn(&[String]) -> Option<T>,
    timeout_ms: i64,
) -> Result<Option<T>, BackendError> {
    let until = io.now_ms() + timeout_ms;
    loop {
        let screen = io.read_screen().await?;
        if let Some(hit) = check(&screen) {
            return Ok(Some(hit));
        }
        if io.now_ms() > until {
            return Ok(None);
        }
        io.sleep(200).await;
    }
}

fn same_question(shown: Option<&str>, q: &AskedQuestion) -> bool {
    let Some(shown) = shown else { return false };
    // The question wraps and its lines may end with another pane's text, so compare the
    // beginning only: enough to tell questions apart without depending on the layout.
    let want = norm(&q.question);
    shown.starts_with(jsstr::slice_utf16(&want, 24))
}

/// Key for the 0-based option index `n` (options 1-9 have a number key).
fn digit_key(n: usize) -> Option<TerminalKey> {
    use TerminalKey::*;
    [N1, N2, N3, N4, N5, N6, N7, N8, N9].get(n).copied()
}

fn stopped(msg: String) -> BackendError {
    BackendError::plain(msg)
}

/// Press the keys that answer `questions` with the `choices` [`validate_choices`] returned. Errors carry the Korean message the server shows
/// (HTTP 409); IO errors pass through.
pub async fn answer_questions(
    io: &mut dyn AnswerIO,
    questions: &[AskedQuestion],
    choices: &[Vec<usize>],
) -> Result<(), BackendError> {
    for (i, q) in questions.iter().enumerate() {
        let shown = wait_for(
            io,
            |lines| same_question(current_question(lines).as_deref(), q).then_some(()),
            3000,
        )
        .await?;
        if shown.is_none() {
            let label = if q.header.is_empty() {
                &q.question
            } else {
                &q.header
            };
            return Err(stopped(format!(
                "터미널에 \"{label}\" 질문이 보이지 않아 멈췄습니다. 터미널 탭에서 확인해 주세요"
            )));
        }
        let picks = choices
            .get(i)
            .ok_or_else(|| stopped("모든 질문에 답해 주세요".into()))?;
        let key_for = |n: usize| digit_key(n).ok_or_else(|| stopped("잘못된 선택입니다".into()));
        if q.multi_select {
            for n in picks {
                io.press(key_for(*n)?).await?;
                io.sleep(120).await;
            }
            io.press(TerminalKey::Right).await?;
        } else {
            let first = picks
                .first()
                .ok_or_else(|| stopped("잘못된 선택입니다".into()))?;
            io.press(key_for(*first)?).await?;
        }
        io.sleep(250).await;
    }
    // Several questions end on a review screen; a single one may submit right away.
    let seen = wait_for(
        io,
        |lines| {
            if is_review_screen(lines) {
                Some(Seen::Review)
            } else if current_question(lines).is_none() {
                Some(Seen::Gone)
            } else {
                None
            }
        },
        3000,
    )
    .await?;
    match seen {
        Some(Seen::Review) => io.press(TerminalKey::N1).await?,
        Some(Seen::Gone) => {}
        None => {
            return Err(stopped(
                "답을 입력했지만 제출 화면을 확인하지 못했습니다. 터미널 탭에서 확인해 주세요"
                    .into(),
            ))
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::QuestionOption;
    use serde_json::json;

    fn lines(l: &[&str]) -> Vec<String> {
        l.iter().map(|s| (*s).to_string()).collect()
    }

    fn opt(label: &str, description: &str) -> QuestionOption {
        QuestionOption {
            label: label.into(),
            description: description.into(),
        }
    }

    fn qs() -> Vec<AskedQuestion> {
        vec![
            AskedQuestion {
                header: "Color".into(),
                question: "Which color?".into(),
                multi_select: false,
                options: vec![opt("Red", "warm"), opt("Blue", "cool")],
            },
            AskedQuestion {
                header: "Sizes".into(),
                question: "Which sizes?".into(),
                multi_select: true,
                options: ["Small", "Medium", "Large"]
                    .iter()
                    .map(|l| opt(l, ""))
                    .collect(),
            },
        ]
    }

    fn rule() -> String {
        "─".repeat(40)
    }

    // Screens captured from Claude Code 2.1 (trimmed).
    fn q1() -> Vec<String> {
        let r = rule();
        lines(&[
            "❯ Use AskUserQuestion: Which color? Which sizes?",
            &r,
            "←  ☐ Color  ☐ Sizes  ✔ Submit  →",
            "Which color?",
            "❯ 1. Red",
            "     warm",
            "  2. Blue",
            "  3. Type something.",
            &r,
            "  4. Chat about this",
        ])
    }

    fn q2() -> Vec<String> {
        let r = rule();
        lines(&[
            &r,
            "←  ☒ Color  ☐ Sizes  ✔ Submit  →",
            "Which sizes?",
            "❯ 1. [ ] Small",
            "  2. [ ] Medium",
            "  3. [ ] Large",
            "     Submit",
            &r,
        ])
    }

    fn review() -> Vec<String> {
        lines(&[
            "←  ☒ Color  ☒ Sizes  ✔ Submit  →",
            "Review your answers",
            " ● Which color?",
            "   → Blue",
            "Ready to submit your answers?",
            "❯ 1. Submit answers",
            "  2. Cancel",
        ])
    }

    fn done() -> Vec<String> {
        let r = rule();
        lines(&["⏺ Blue; Small, Large", &r, "❯ ", &r])
    }

    // One question, captured with a diff preview pane on the right (Claude Code 2.1).
    fn single() -> Vec<String> {
        lines(&[
            "──────────────────────────────     +— they stay on the top floor. */",
            " ☐ 캡처 테스트                                                  37 +export function zoneOf(desk",
            "                                                                   +> = NONE): ZoneKey {",
            "│ [화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에       38 +  if (desk.agents",
            "│ 터미널에서 아무거나 골라 주세요.                                  +d))) return",
            "                                                                   39    return desk",
            "❯ 1. 확인                                                          40  }",
            "     터미널에서 선택                                               41",
            "  2. 다시                                                          39 -export function recency",
            "  3. Type something.",
            "Enter to select · ↑/↓ to navigate · Esc to cancel",
        ])
    }

    /// A fake terminal: `step` decides the next screen after each key press.
    struct Fake {
        screen: Vec<String>,
        pressed: Vec<TerminalKey>,
        slept: Vec<u64>,
        clock: i64,
        step: fn(&[String], TerminalKey) -> Option<Vec<String>>,
    }

    impl Fake {
        fn new(
            screen: Vec<String>,
            step: fn(&[String], TerminalKey) -> Option<Vec<String>>,
        ) -> Self {
            Self {
                screen,
                pressed: vec![],
                slept: vec![],
                clock: 0,
                step,
            }
        }
    }

    #[async_trait]
    impl AnswerIO for Fake {
        async fn read_screen(&mut self) -> Result<Vec<String>, BackendError> {
            Ok(self.screen.clone())
        }
        async fn press(&mut self, key: TerminalKey) -> Result<(), BackendError> {
            self.pressed.push(key);
            if let Some(next) = (self.step)(&self.screen, key) {
                self.screen = next;
            }
            Ok(())
        }
        async fn sleep(&mut self, ms: u64) {
            self.slept.push(ms);
        }
        fn now_ms(&self) -> i64 {
            self.clock
        }
    }

    fn walk(screen: &[String], key: TerminalKey) -> Option<Vec<String>> {
        let is_digit = key.name().len() == 1 && key.name().as_bytes()[0].is_ascii_digit();
        if screen == q1().as_slice() && is_digit {
            Some(q2())
        } else if screen == q2().as_slice() && key == TerminalKey::Right {
            Some(review())
        } else if screen == review().as_slice() && key == TerminalKey::N1 {
            Some(done())
        } else {
            None
        }
    }

    // answer.test.ts: reads a single-question dialog (no tab row, │ prefix, text from another pane)
    #[test]
    fn reads_a_single_question_dialog() {
        let shown = current_question(&single()).unwrap();
        assert!(shown.starts_with("[화면 캡처용 테스트] 질문이 하나일 때의"));
    }

    // answer.test.ts: answers a single question with one digit and no review screen
    #[tokio::test]
    async fn answers_a_single_question_with_one_digit_and_no_review_screen() {
        let q = AskedQuestion {
            header: "캡처 테스트".into(),
            question: "[화면 캡처용 테스트] 질문이 하나일 때의 터미널 화면을 저장하는 중입니다. 30초 뒤에 터미널에서 아무거나 골라 주세요.".into(),
            multi_select: false,
            options: vec![opt("확인", ""), opt("다시", "")],
        };
        let mut io = Fake::new(single(), |_, _| Some(done()));
        answer_questions(&mut io, &[q], &[vec![1]]).await.unwrap();
        assert_eq!(io.pressed, vec![TerminalKey::N2]);
    }

    // answer.test.ts: reads the current question from the line under the tab row
    #[test]
    fn reads_the_current_question_from_the_line_under_the_tab_row() {
        assert_eq!(current_question(&q1()).as_deref(), Some("Which color?"));
        assert_eq!(current_question(&q2()).as_deref(), Some("Which sizes?"));
        assert_eq!(current_question(&done()), None);
        assert!(is_review_screen(&review()));
        assert!(!is_review_screen(&q2()));
    }

    // answer.test.ts: validates choices against the questions
    #[test]
    fn validates_choices_against_the_questions() {
        let q = qs();
        assert_eq!(
            validate_choices(&q, &json!([[1], [0, 2]])),
            Ok(vec![vec![1], vec![0, 2]])
        );
        assert!(validate_choices(&q, &json!([[1]])).is_err());
        assert!(validate_choices(&q, &json!([[0, 1], [0]])).is_err()); // two answers to a single-select
        assert!(validate_choices(&q, &json!([[1], []])).is_err());
        assert!(validate_choices(&q, &json!([[5], [0]])).is_err());
        assert!(validate_choices(&q, &json!([[1], [0, 0]])).is_err());
    }

    #[test]
    fn validation_messages_and_odd_shapes() {
        let q = qs();
        let msg = |v: Value| validate_choices(&q, &v).unwrap_err();
        assert_eq!(msg(json!("x")), "모든 질문에 답해 주세요");
        assert_eq!(msg(json!(null)), "모든 질문에 답해 주세요");
        assert_eq!(msg(json!([[1]])), "모든 질문에 답해 주세요");
        assert_eq!(msg(json!([1, [0]])), "잘못된 선택입니다");
        assert_eq!(msg(json!([["0"], [0]])), "잘못된 선택입니다");
        assert_eq!(msg(json!([[-1], [0]])), "잘못된 선택입니다");
        assert_eq!(msg(json!([[0.5], [0]])), "잘못된 선택입니다");
        assert_eq!(msg(json!([[null], [0]])), "잘못된 선택입니다");
        assert_eq!(msg(json!([[2], [0]])), "잘못된 선택입니다"); // only two options
        assert_eq!(msg(json!([[0, 1], [0]])), "\"Color\"에 답해 주세요");
        assert_eq!(msg(json!([[0], []])), "\"Sizes\"에 답해 주세요");
        // 1.0 is an integer in JS.
        assert_eq!(
            validate_choices(&q, &json!([[1.0], [0.0, 2]])),
            Ok(vec![vec![1], vec![0, 2]])
        );
        // No header: the question names it. More than nine options cannot be answered by digit.
        let wide = AskedQuestion {
            header: String::new(),
            question: "Pick?".into(),
            multi_select: false,
            options: (0..10).map(|i| opt(&i.to_string(), "")).collect(),
        };
        assert_eq!(
            validate_choices(std::slice::from_ref(&wide), &json!([[]])).unwrap_err(),
            "\"Pick?\"에 답해 주세요"
        );
        assert_eq!(
            validate_choices(&[wide], &json!([[0]])).unwrap_err(),
            "선택지가 너무 많아 웹에서 답할 수 없습니다. 터미널에서 답해 주세요"
        );
    }

    // answer.test.ts: presses digits, -> after multi-select, then submits on the review screen
    #[tokio::test]
    async fn presses_digits_right_after_multi_select_then_submits_on_the_review_screen() {
        let mut io = Fake::new(q1(), walk);
        answer_questions(&mut io, &qs(), &[vec![1], vec![0, 2]])
            .await
            .unwrap();
        use TerminalKey::*;
        assert_eq!(io.pressed, vec![N2, N1, N3, Right, N1]);
        // Pauses: after each multi-select toggle, after each question.
        assert_eq!(io.slept, vec![250, 120, 120, 250]);
    }

    /// `Date.now = () => (t += 1000)`
    struct Ticking {
        screen: Vec<String>,
        pressed: Vec<TerminalKey>,
        t: std::sync::atomic::AtomicI64,
        sleeps: usize,
    }

    #[async_trait]
    impl AnswerIO for Ticking {
        async fn read_screen(&mut self) -> Result<Vec<String>, BackendError> {
            Ok(self.screen.clone())
        }
        async fn press(&mut self, key: TerminalKey) -> Result<(), BackendError> {
            self.pressed.push(key);
            Ok(())
        }
        async fn sleep(&mut self, _ms: u64) {
            self.sleeps += 1;
        }
        fn now_ms(&self) -> i64 {
            self.t.fetch_add(1000, std::sync::atomic::Ordering::SeqCst) + 1000
        }
    }

    fn ticking(screen: Vec<String>) -> Ticking {
        Ticking {
            screen,
            pressed: vec![],
            t: 0.into(),
            sleeps: 0,
        }
    }

    // answer.test.ts: stops without typing if the expected question is not on screen
    #[tokio::test]
    async fn stops_without_typing_if_the_expected_question_is_not_on_screen() {
        let mut io = ticking(done());
        let err = answer_questions(&mut io, &qs(), &[vec![1], vec![0]])
            .await
            .unwrap_err();
        assert!(err.message.contains("보이지 않아"), "{}", err.message);
        assert_eq!(
            err.message,
            "터미널에 \"Color\" 질문이 보이지 않아 멈췄습니다. 터미널 탭에서 확인해 주세요"
        );
        assert!(err.code.is_none());
        assert!(io.pressed.is_empty());
        // until = 4000; checks at 2000, 3000, 4000 sleep; 5000 gives up.
        assert_eq!(io.sleeps, 3);
    }

    #[tokio::test]
    async fn a_dialog_that_never_reaches_the_review_screen_is_reported() {
        // The answered question stays on screen: neither review nor gone.
        let mut io = ticking(q1());
        let single = vec![qs().remove(0)];
        let err = answer_questions(&mut io, &single, &[vec![0]])
            .await
            .unwrap_err();
        assert_eq!(
            err.message,
            "답을 입력했지만 제출 화면을 확인하지 못했습니다. 터미널 탭에서 확인해 주세요"
        );
        assert_eq!(io.pressed, vec![TerminalKey::N1]);
    }

    #[tokio::test]
    async fn out_of_range_or_missing_choices_stop_before_typing() {
        let mut io = Fake::new(q1(), walk);
        let e = answer_questions(&mut io, &qs(), &[vec![9]])
            .await
            .unwrap_err();
        assert_eq!(e.message, "잘못된 선택입니다");
        let mut io = Fake::new(q1(), walk);
        let e = answer_questions(&mut io, &qs(), &[]).await.unwrap_err();
        assert_eq!(e.message, "모든 질문에 답해 주세요");
        let mut io = Fake::new(q1(), walk);
        assert!(answer_questions(&mut io, &qs(), &[vec![]]).await.is_err());
        assert!(io.pressed.is_empty());
    }

    #[test]
    fn screen_helpers_follow_the_js_regexes() {
        // A header row only counts with an option within the next 11 lines.
        let mut l = lines(&[" ☐ Header", "Question?"]);
        assert_eq!(current_question(&l), None);
        l.push("  1. Yes".into());
        assert_eq!(current_question(&l).as_deref(), Some("Question?"));
        // Wrapped question lines are joined with single spaces; indented lines are skipped.
        let l = lines(&[
            "←  ☐ A  →",
            "│ first  line",
            "      other pane",
            "second",
            "1. x",
        ]);
        assert_eq!(current_question(&l).as_deref(), Some("first line second"));
        // Review needs both lines.
        assert!(!is_review_screen(&lines(&[
            "Ready to submit your answers?"
        ])));
        assert!(is_review_screen(&lines(&[
            "Ready to submit your answers?",
            "  12.Submit answers"
        ])));
        assert_eq!(digit_key(0), Some(TerminalKey::N1));
        assert_eq!(digit_key(8), Some(TerminalKey::N9));
        assert_eq!(digit_key(9), None);
    }
}
