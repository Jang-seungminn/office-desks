// Run from the repo root: node crates/od-core/tests/fixtures/xterm/gen-screen-lines.cjs > crates/od-core/tests/fixtures/xterm/screen_lines.json
const root = require('path').resolve('node_modules/@xterm') + '/';
const { Terminal } = require(root + 'headless');
const { Unicode11Addon } = require(root + 'addon-unicode11');
const cases = {
  glyphs: '❯ hi\r\n⏺ Done\r\n✻ Thinking…\r\n  ⎿  out\r\n────────\r\n╭──╮\r\n│x │\r\n╰──╯',
  emoji_cjk: '✅ ok 🚀 go\r\n한글 테스트\r\n日本語',
  wide_last_col: 'abcdefghi한x',
  wide_exact_fit: 'abcdefgh한',
  combining: 'é café x',
  zwj: '👨‍👩‍👧 fam',
  cuf_gaps: '\x1b[5Cz\x1b[3Cq',
  el_tail: 'hello world\x1b[1;6H\x1b[K',
  ed_tail: 'line1\r\nline2\r\nline3\x1b[2;3H\x1b[J',
  trailing_spaces: 'ab   \r\ncd',
  tabs: 'a\tb\tc',
  overwrite_wide: '한글\x1b[1;2Hx',
  vs16: '❤️ heart ☺️',
  wrap_long: 'x'.repeat(25),
};
const out = {};
let pending = Object.keys(cases).length;
for (const [name, data] of Object.entries(cases)) {
  const t = new Terminal({ cols: 10, rows: 6, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon()); t.unicode.activeVersion = '11';
  t.write(data, () => {
    const b = t.buffer.active; const lines = [];
    for (let y = 0; y < t.rows; y++) lines.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    out[name] = { data, lines };
    if (--pending === 0) console.log(JSON.stringify(out));
  });
}
