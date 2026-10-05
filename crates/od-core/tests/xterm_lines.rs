//! `row_text` (what `PtyHost::screen_lines` returns per row) against xterm-headless with the
//! Unicode 11 addon, as the TS PtyHost renders: `translateToString(true)` on a 10x6 terminal.
//! Fixture made by `tests/fixtures/xterm/gen-screen-lines.cjs`.

use od_core::native::pty_host::row_text;

#[test]
fn screen_lines_match_xterm_headless() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/xterm/screen_lines.json"
    );
    let cases: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = cases.as_object().unwrap();
    assert!(cases.len() >= 14);
    for (name, c) in cases {
        let mut p = vt100::Parser::new(6, 10, 1000);
        p.process(c["data"].as_str().unwrap().as_bytes());
        let got: Vec<String> = (0..6).map(|r| row_text(p.screen(), r, true)).collect();
        let want: Vec<&str> = c["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(got, want, "case {name}");
    }
}
