# Changelog

## Unreleased

## 1.7.0: investigations, sweeps and a shared case file

- **Shared case file** (`bridge case new|put|get|list|log`): one Markdown document per investigation or test
  sweep, stored on the relay with every version kept. `put` stores a new version and sends a `case_updated`
  message carrying a `note` and an `ask` (what the other side should do), so the peer's `wait` wakes up.
  `get` saves the latest version to `.agent-bridge/cases/<name>.md` and prints only the lines that changed
  since this machine's copy. A `put` based on an old version is refused (`stale`) instead of overwriting.
  The next `get` keeps the local edits, saves the newer version beside them and shows the diff to merge.
  `put` runs the same secret scan as `send` (exit 5). Limit: 256 KB per case.
- **Templates** in `templates/`: `investigation` (symptom, evidence, hypotheses, asks, findings, root cause,
  fix, verification, log), `sweep` (adds scope, coverage and anomalies N1...), `blank`.
- **Investigations and sweeps** as kinds of work next to the test cycle. `SKILL.md` tells the agent to take the
  kind from what the user said, and not to send `test_scenarios` or read `git diff` for a symptom or a sweep.
  New `references/investigation.md` covers the loop, the editing rules and merging. The backend, mobile and
  frontend playbooks each gained a section.
- **Dashboard**: a "Case files" list in the sidebar opens the latest version (rendered as plain text), updated
  live. `case_updated` can trigger a desktop notification.
- **Report**: a "Case files" section embeds each case used in the thread at its latest version.
- **MCP**: new `bridge_case` tool.
- 9 new tests.

- **Listening in tools without background wake-ups (Codex, Gemini CLI, Cursor).** The `setup-agent` block and
  `docs/other-agents.md` now spell out a foreground loop: `wait --timeout 1800` with the command timeout
  above it, re-run right after every batch and after timeouts, until `final_report` or the user stops it.
  They also give a prompt to paste. In a Codex field test the agent used a 45 s wait, stopped listening
  after one round and missed later messages. The `wait` timeout hint no longer says "background" only.

## 1.6.0: other coding agents

- **`bridge setup-agent --tool codex|gemini|cursor|copilot|generic [--project <dir>]`** adds a short
  instruction block to the file each tool reads: `AGENTS.md`, `GEMINI.md`, `.cursor/rules/agent-bridge.mdc`
  (with front matter) or `.github/copilot-instructions.md`. The block points to `SKILL.md` and the CLI by
  absolute path. Re-running updates it in place, and the rest of the file is kept. The command also prints an
  MCP config.
- **MCP server** (`scripts/mcp-server.mjs`, stdio, no dependencies) with the tools `bridge_host`,
  `bridge_connect`, `bridge_resume`, `bridge_send`, `bridge_wait`, `bridge_status`, `bridge_report`,
  `bridge_approval_request`, `bridge_approval_wait`, `bridge_dashboard` and `bridge_close`. Each runs the CLI,
  so the secret scan, batching and compact output apply. The secret-scan override is deliberately not exposed.
  A wait timeout is a normal result, and cancellation kills the running command.
- **`docs/other-agents.md`** covers setup per tool, what differs from Claude Code, and how to listen without
  background wake-ups (foreground `wait` with a timeout, never sleep-polling).
- **`AGENTS.md`** for agents that develop this repository.
- CI uses `actions/checkout@v5` and `actions/setup-node@v5`, so the Node 20 deprecation warning is gone.
- 6 new tests (51 total).

## 1.5.0: dashboard as a control panel, reports

- **Approvals.** `bridge approval request --title ... [--details ...] [--for ...]`, then `approval wait <id>`
  (background) and `approval resolve <id> --approve|--decline` for answers given in chat. Pending approvals
  are pinned at the top of the dashboard with Approve/Decline and an optional comment. Decisions are final,
  and a peer can never approve.
- **Notes to your agent.** A dashboard box sends a note to the local agent only. `wait` delivers it within
  ~10 s while the dashboard is open, labeled `user_note · from YOUR USER (dashboard)`, as the user's
  instruction. A peer message typed `user_note` stays peer data.
- **Reports.** `bridge report [--thread]` writes a Markdown report (summary, scenarios and results, bugs with
  open/fixed/verified status, test data, timeline) and prints only its path. The dashboard's "⬇ Report"
  downloads the same report for the selected thread.
- **Notifications.** A "🔔 Notify" toggle turns on desktop notifications for bug reports, approval requests,
  questions, fix_ready and final reports, and the tab title counts unseen items.
- Dashboard writes need the token in an `x-ab-token` header too (cross-site requests can't send it), and
  request bodies are capped. Note cursors survive host restarts and new connections, so notes aren't
  delivered twice.
- New eval `backend-no-ping-pong`: the scripted peer answers with a friendly ack plus a final_report. Both
  configurations stayed silent (4/4), so it is recorded as non-discriminating and kept as a regression
  guard. The harness's scripted peer can now react to the agent's messages (`on_message`).
- 8 new tests (45 total).

## 1.4.0

- **Outgoing secret scan.** `send` checks bodies and text attachments for credential shapes: private keys,
  JWTs, bearer tokens, AWS/Google/GitHub/Slack/Stripe keys, `user:pass@` URLs, cookies, and
  `*secret*`/`*token*`/`*password*`/`*api_key*` values. If it finds any, it refuses with exit code 5 and lists
  masked samples. Redacted values and normal test data pass. `--allow-secrets` overrides it for one message,
  and SKILL.md limits that to values the user explicitly agreed to share.
- **Fixed ngrok address.** `host --domain <name>`, or `AGENT_BRIDGE_NGROK_DOMAIN`, uses the account's ngrok
  domain, so the address survives restarts. Tested against a real ngrok account.
- **CI.** GitHub Actions runs the syntax check, all tests and the token measurement on Windows, macOS and
  Linux with Node 18 and 22. README badge.
- 4 new tests (37 total).

## 1.3.0: token budget

Measured with `node tests/token-measure.mjs`, where the peer sends a bug report, a progress update and an ack
in a burst. The listening agent went from **3 wake-ups and 6,026 characters to 1 wake-up and 3,687
characters**.

- **Batched delivery.** After the first message arrives, `wait` keeps collecting while more arrive within
  `--settle` seconds (default 3, capped), so a burst costs one turn instead of one turn per message.
- **Compact output.** Each message gets one header line (`[n] type · from … · #thread · id … · re …`) and its
  body as single-line JSON. The output has one data/instructions notice per batch instead of one per message,
  and a short footer.
- **Body cut-off.** Bodies longer than `--max-body` (default 3,000 chars) are cut in the output, and the full
  body is saved to `inbox/<id>/body.json` for the agent to open only if needed.
- **Fewer idle wake-ups.** The default `wait` timeout went from 10 min (SKILL.md said 30 min) to 6 h.
- **Oversized sends are flagged.** `send` notes bodies over 6,000 chars and suggests attachments. Its own
  output is shorter too.
- **SKILL.md "Token budget" rules.** Reply only when it moves the work forward (no thanks, "received", or
  replies to `ack`/`final_report`/`declined`), so two agents can't loop. Keep bodies dense, refer to items by
  id instead of echoing them, put evidence in attachments, don't poll `status`, and read references only
  when needed. The "check status before ending a turn" step is gone: re-arming `wait` already returns
  anything unread. `protocol.md` lists the types that need no reply.
- 5 new tests (33 total) and `tests/token-measure.mjs`.

## 1.2.0

- **Dashboard.** `bridge dashboard [--open]` starts a local, live, read-only web view of the conversation:
  agents with their versions and online state, threads, color-coded message types, readable bodies with the
  full JSON on demand, reply-to jumps, search and a type filter, and inline previews of received screenshots.
  It works on the host (the whole relay log) and on peers (their own log).
- Dashboard security: it binds to 127.0.0.1 on its own port, so the ngrok tunnel never reaches it. Requests
  need a random token, Host headers other than loopback are refused (DNS rebinding), and responses never
  contain key material. Peer content is rendered as text only under a strict nonce CSP. Attachment paths
  can't leave the inbox.
- `close` also stops the dashboard. 9 new tests (28 total).

## 1.1.0

Changes from the first two-machine field test (ngrok, backend ↔ mobile).

- **Listener reminders.** `send` warns when no `wait` is running on this machine, and `wait` output ends with
  the next step. SKILL.md now says to re-arm right after replying and to check for unread messages before
  ending a turn. In the field test a reply went unnoticed because the listener had not been restarted.
- **One conversation, one thread.** Without `--thread` or `--reply-to`, `send` continues the last thread
  (`--new-thread` sends with no thread). SKILL.md says not to open a second thread for the same
  conversation. In the field test the peer split one conversation across two threads.
- **`bridge resume <url>`.** After a host restart (a new ngrok URL), paired peers switch to the new address
  with their existing key; no new pairing code is needed. The host prints the `resume` line for them.
- **Versions.** `bridge version`. Peers report their version on every request, `status` and `connect` show
  it, and the CLI prints a note when the two sides differ. `hello` carries `skill_version`.
- **ngrok.** Finds ngrok in winget/Chocolatey/Scoop/Homebrew/snap folders when PATH isn't refreshed yet.
  It tells "agent too old" (run `ngrok update`) apart from "not signed in" and "another session running";
  the old message blamed the authtoken for all of them.
- **Plugin.** `.claude-plugin/plugin.json` and `marketplace.json`: install with
  `/plugin marketplace add Latth/agent-bridge`.
- Web frontend role (playbook, web-testing reference, eval case) and multi-agent relays, added after 1.0.0.

## 1.0.0

First release: encrypted relay + CLI, protocol, backend and mobile playbooks, security policy, evals.
