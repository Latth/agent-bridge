# Changelog

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
