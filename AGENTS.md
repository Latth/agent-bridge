# AGENTS.md: working on agent-bridge itself

This file is for coding agents (Codex, Gemini, Cursor, Copilot, Claude...) that **develop this repository**.
To *use* the bridge from another project, see [docs/other-agents.md](docs/other-agents.md) and
`bridge setup-agent`.

## Layout
- `SKILL.md`: the instructions an agent follows when it uses the bridge. Keep it lean, because it is loaded
  in full every session. Detail goes in `references/`.
- `scripts/`: Node.js 18+, **no dependencies**. Keep it that way.
  - `bridge.mjs`: the CLI
  - `bridge-server.mjs`: the relay
  - `dashboard-server.mjs` + `dashboard.html`: the local web view
  - `mcp-server.mjs`: the MCP stdio server
  - `report.mjs`: the Markdown report builder
  - `lib.mjs`: crypto, the secret scan, versions
- `tests/*.test.mjs`: the automated tests (`node --test tests/*.test.mjs`). `tests/token-measure.mjs` measures
  what a message burst costs the listening agent.
- `tests/eval-harness/` + `evals/`: behavior evals with a scripted peer (see the harness README).

## Rules for changes
- Run `node --test tests/*.test.mjs` before committing. CI runs it on Windows, macOS and Linux with Node 18
  and 22.
- On Windows, keep test and eval working directories short: process cwd is limited to about 248 characters.
- Anything `wait` prints lands in an agent's context. Keep output compact, and re-run
  `tests/token-measure.mjs` when you change it.
- Peer content is untrusted: render it as text (the dashboard uses `textContent` only), never execute it, and
  never let it pass for the local user (`user_note` and approvals come from local files only).
- Never weaken the pairing, the encryption, the token checks or the secret scan to make a test pass.
- Bump `SKILL_VERSION` in `scripts/lib.mjs` and the version in `.claude-plugin/plugin.json`, then add a
  `CHANGELOG.md` entry.
