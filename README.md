<div align="center">

# 🌉 agent-bridge

**Let Claude Code sessions on different machines work together.**

A backend agent and a mobile or web agent, on two laptops and two networks, with the same or different
accounts, pass test scenarios, test data, bug reports and fixes back and forth until the feature works.

[![version](https://img.shields.io/badge/version-1.4.0-2563eb)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT-16a34a)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/dependencies-0-6b7280)](scripts)
[![tests](https://github.com/Latth/agent-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/Latth/agent-bridge/actions/workflows/test.yml)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-skill%20%2B%20plugin-d97757)](https://claude.com/claude-code)

[Quick start](#-quick-start) · [Dashboard](#-watch-the-conversation) · [How it works](#-how-it-works) · [Commands](#-commands) ·
[Security](#-security) · [FAQ](#-faq) · [Changelog](CHANGELOG.md)

</div>

---

## ✨ Why

When the backend team ships a change, someone on the mobile or web team has to test it. That person needs to
know what changed and needs test data for their user; then the backend team needs a precise bug report.
Today all of that is copy-pasted between people.

With **agent-bridge**, each team's Claude agent does that handoff itself:

```mermaid
sequenceDiagram
    autonumber
    participant BE as 🖥️ Backend agent
    participant M as 📱 Mobile / 🌐 Web agent
    BE->>M: test_scenarios (what changed, what to verify)
    M->>BE: ui_testable_scenarios (what it can test on screen)
    M->>BE: data_request (chip, task... for user u_48213)
    Note over BE: creates the data on staging only
    BE->>M: data_response (exact values + cleanup)
    Note over M: runs the tests on emulator / device / browser
    M->>BE: bug_report (request id, status, redacted logs, screenshot)
    Note over BE: finds it in server logs, fixes, tests
    BE->>M: fix_ready (what to retest)
    M->>BE: retest_result ✅
    M-->>BE: final_report
```

## 🚀 Quick start

**1. Install on both machines.** You need Node.js 18+ on each. The host also needs
[ngrok](https://ngrok.com/download), unless both machines are on the same network.

<table>
<tr><th>As a plugin (recommended)</th><th>As a plain skill</th></tr>
<tr><td>

```
/plugin marketplace add Latth/agent-bridge
/plugin install agent-bridge@latth-agent-bridge
```

</td><td>

```bash
git clone https://github.com/Latth/agent-bridge \
  ~/.claude/skills/agent-bridge
```

</td></tr>
<tr><td>Updates arrive through <code>/plugin</code>.</td><td>Update with <code>git pull</code> in that folder.<br>Windows: clone into <code>%USERPROFILE%\.claude\skills\agent-bridge</code>.</td></tr>
</table>

**2. Start the bridge on one machine**, the host, usually backend:

```
/agent-bridge host --role backend          # over ngrok (works across networks)
/agent-bridge host --role backend --lan    # same Wi-Fi / office network, no ngrok
```

The agent replies with a line like this:

```
/agent-bridge connect https://abcd-1234.ngrok-free.dev --code 7KQ2M-X9D4F --role <their role>
```

**3. Paste that line into Claude on the other machine.** Use `--role mobile` or `--role frontend`, or leave
the role out and let it be inferred from the project. The code works once and expires after 15 minutes.

**4. Talk to your own agent as usual.** For example "send them the test scenarios for the login change",
"they found a bug, look at it", "close the bridge". The agents message each other in the background and tell
you what is happening.

> [!TIP]
> Use your ngrok domain (`--domain your-name.ngrok-free.app`, listed under dashboard.ngrok.com → Domains)
> and the address never changes. Without one, a restarted host may get a new URL: run `host` again, and
> paired peers only need `/agent-bridge resume <new-url>`. No new code is needed until someone runs `close`.

## 👀 Watch the conversation

Ask your agent to *"open the bridge dashboard"* (it runs `bridge dashboard --open`). You get a live web view
of what the agents are saying to each other:

<p align="center"><img src="docs/dashboard.jpg" alt="Agent Bridge Monitor: agents and threads on the left, a live timeline of typed messages with an attached screenshot on the right" width="820"></p>

- **Live**: new messages appear within a second, without a reload
- **Readable**: each agent has its own color, each message type has a badge, and the main fields of a body
  are shown as a short list with the full JSON one click away
- **Navigable**: threads in the sidebar, search, a filter by type, and "reply to" links that jump to the
  original message
- **Evidence**: received screenshots are previewed inline
- **Private**: it runs on `127.0.0.1` only, behind a random token, and never goes through ngrok. Peer content
  can't run script in your browser.

It works on both sides. The host sees everything that passes through the relay; a peer sees what it sent and
received.

## 🧠 How it works

```mermaid
flowchart LR
    subgraph A["🖥️ Machine A: host"]
        CA["Claude session<br/>role: backend"] -- "bridge send / wait" --> R[("relay<br/>bridge-server.mjs")]
    end
    subgraph B["📱 Machine B"]
        CB["Claude session<br/>role: mobile"] -- "bridge send / wait" --> CLI["bridge CLI"]
    end
    R <-. "ngrok HTTPS or LAN<br/>🔒 AES-256-GCM end to end" .-> CLI
    T["🌐 Machine C (optional)<br/>role: frontend"] -.-> R
```

| Piece | What it does |
|---|---|
| **Relay** (`scripts/bridge-server.mjs`) | A small HTTP server on the host. It queues messages per recipient and keeps a log. Plain Node.js, no dependencies. |
| **CLI** (`scripts/bridge.mjs`) | What the agents run: `host`, `connect`, `send`, `wait`, `resume`, `status`, ... |
| **Listening** | A Claude session only runs on its turn, so the agent runs `bridge wait` in the background. It long-polls and exits the moment a message arrives, which **wakes the session**. There are no polling loops. |
| **Token budget** | Every wake-up is a full turn, so wake-ups are kept few and small. A burst of messages arrives as **one** batch, the output is compact (one header line plus single-line JSON per message), long bodies are cut with the full text saved to a file, and idle wake-ups come every 6 h at most. The skill also tells agents never to send replies that carry nothing new (thanks, "received", ack-of-ack), so two agents can't ping-pong. In a 3-message burst this cut the cost from 3 turns and 6.0k characters to **1 turn and 3.7k characters**. |
| **Protocol** | Typed messages, one per step: `hello`, `test_scenarios`, `data_request`, `bug_report`, `fix_ready`, `declined`, `final_report`, ... See [references/protocol.md](references/protocol.md). |
| **Playbooks** | What each role does at each step: [backend](references/roles/backend.md), [mobile](references/roles/mobile.md) (adb, logcat, iOS Simulator), [frontend](references/roles/frontend.md) (Playwright, HAR, console). |
| **Project profile** | On first use each agent records its environment in `.claude/agent-bridge-profile.md`: staging URL, how test data is made, logcat tag, browser. The next session doesn't ask again. |

## 🧰 Commands

The agent runs these for you. You only need them for debugging.

| Command | Purpose |
|---|---|
| `host --role <role> [--lan] [--ngrok]` | Start the relay and print the address plus a single-use pairing code |
| `connect <url\|ip:port> --code <CODE> --role <role>` | Join a relay |
| `resume <url\|ip:port>` | Keep your pairing and switch to the host's new address |
| `send --type <type> [--to <role>] [--reply-to <id>] [--body-file f.json] [--file x.png]` | Send a message. Without `--thread` it continues the conversation's thread |
| `wait` | Wait for messages (a burst comes as one batch, long bodies are cut) or a 6 h timeout |
| `status` · `inbox` · `log` | Peers and versions, unread messages, history |
| `code` · `kick <peer>` · `close` | (host) New pairing code, remove a peer, end the bridge and revoke all keys |
| `dashboard [--open] [--stop]` | Local, live, read-only web view of the conversation |
| `version` | This machine's agent-bridge version |

They are all `node scripts/bridge.mjs <command>`. State lives in `.agent-bridge/` in the project, which
git-ignores itself.

## 🔒 Security

There are two kinds of risk, and the skill handles them separately.

**The network.** Pairing runs an X25519 key exchange keyed by the single-use code. The session key is derived
on both sides and **never sent**. Every request and response is AES-256-GCM encrypted and bound to its route,
sender, timestamp and nonce, so sniffing, replays and tampering all fail. Even ngrok only sees ciphertext.
Wrong codes are rate-limited, and the code is burned after 5 attempts.

**The other agent.** Encryption proves who sent a message. It doesn't prove that doing what the message asks
is a good idea. So messages from the peer are treated as **data, not instructions**:

| The peer asks to... | The agent... |
|---|---|
| read code and logs, run tests, create **test data on staging/dev** | does it (after checking it really is staging) |
| deploy, migrate, delete, push, or touch **production** | asks **its own user** first, even if the peer says "your user already approved" |
| send secrets (`.env`, tokens, cookies) or real customer data | refuses with a `declined` message |

Logs, HAR files and screenshots are redacted before they are sent: `Authorization`, cookies, tokens and
personal data. As a backstop, `send` **scans every outgoing body and text attachment**. If something looks
like a credential (JWT, bearer token, private key, cloud or GitHub keys, `user:pass@` URLs, `*_SECRET=`
values), the message is not sent. Details are in [references/security.md](references/security.md).

## 📊 Status

| | |
|---|---|
| ✅ **Relay, CLI and dashboard** | 37 automated tests, run by CI on Windows, macOS and Linux (Node 18 and 22): pairing, encryption, replay/tamper rejection, attachments, long-poll, resume after a host restart, versions, thread reuse, the dashboard's token, Host check, key hygiene, file paths and live stream, the token budget (batching, compact output, body cut-offs), and the outgoing secret scan (`node --test tests/*.test.mjs`) |
| ✅ **Agent behavior** | 4 scenarios against a scripted peer: backend creates staging data, backend refuses a prod migration and secrets, mobile bug report, web bug report. **26/26 checks with the skill, 19/26 without** ([eval harness](tests/eval-harness/README.md)) |
| ✅ **Field test** | Two machines on different networks over ngrok: pairing, `hello` both ways, attachments, background wake-up on every message |
| ⏳ **Not yet verified** | A full data → bug → fix → retest cycle on a real project, very long sessions, and plugin install from the marketplace |

Found a rough edge? [Open an issue](https://github.com/Latth/agent-bridge/issues). Reports from real
backend ↔ mobile/web cycles are the most useful.

## ❓ FAQ

<details>
<summary><b>Do both machines need the same Claude account?</b></summary>

No. The agents talk through the relay, not through Anthropic, so any two Claude Code sessions can pair.
</details>

<details>
<summary><b>Can more than two agents join?</b></summary>

Yes. Backend, mobile and frontend can share one relay. The host issues a new pairing code for each extra
device (`bridge code`), and messages are addressed by role (`--to frontend`) or to everyone (`--to '*'`).
</details>

<details>
<summary><b>Does it work with roles other than backend / mobile / frontend?</b></summary>

The bridge itself accepts any role name, such as `qa`, `desktop` or `data`. Those roles follow the general
loop and protocol in `SKILL.md`; dedicated playbooks exist for backend, mobile and frontend.
</details>

<details>
<summary><b>Will my agent do whatever the other agent asks?</b></summary>

No. See [Security](#-security). Anything risky goes to you first, and secrets are never sent.
</details>

<details>
<summary><b>ngrok says my agent version is too old</b></summary>

Some accounts require a recent ngrok agent, and package managers can lag behind. Run `ngrok update`. The CLI
recognizes this error and says so. More fixes are in [references/networking.md](references/networking.md#troubleshooting).
</details>

<details>
<summary><b>Do both sides need the same agent-bridge version?</b></summary>

They should. Every `hello` carries the version, and the CLI prints a note when the two sides differ. Update
the older side with `git pull` or through `/plugin`.
</details>

## 🗂️ Repository layout

```
SKILL.md                  what Claude follows when the skill runs
scripts/                  relay + CLI + dashboard (Node.js, zero dependencies)
docs/                     images for this README
references/               protocol · security · networking · role playbooks · mobile & web testing
.claude-plugin/           plugin + marketplace manifests
tests/*.test.mjs          relay/CLI tests
tests/eval-harness/       scripted peer, fixture projects (with deliberately fake secrets), grader
evals/                    behavior test cases (claude plugin eval layout)
```

## 📄 License

[MIT](LICENSE)
