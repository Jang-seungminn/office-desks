Real Claude Code 2.1 screens captured with `orca terminal read --screen` (paths anonymised).
`screens.test.ts` runs the screen parsers against every file here. When a new Claude Code
version changes its TUI, capture the same screens into a new `claude-<version>/` folder and
add the version to `TESTED_CLAUDE_VERSIONS` once the tests pass.
