# agent-bridge

A [Claude Code](https://claude.com/claude-code) skill that connects two (or more) Claude sessions running
on **different machines**, with the same or different accounts, so the agents can work through a task
together.

The motivating case is a test cycle between teams:

1. The **backend** agent reads its change, writes test scenarios and sends them over.
2. The **mobile** or **web frontend** agent picks the ones it can test on screen and asks for test data
   for the logged-in user (a chip number, an open task...).
3. The backend agent creates that data **on staging** and replies with the exact values.
4. The client agent runs the tests on an emulator, device or browser, and reports failures with evidence:
   request id, status, a log excerpt and a screenshot, with secrets redacted.
5. The backend agent fixes the bug and says what to retest. Repeat until everything passes.

```
 [backend machine]                              [mobile / web machine]
 Claude (role=backend)                          Claude (role=mobile)
   │ bridge send / wait                            │ bridge send / wait
   ▼                                               │
 relay (bridge-server.mjs) ◄── HTTPS (ngrok) or LAN, end-to-end encrypted ──┘
```

## How it works

- **Relay + CLI**: `scripts/bridge-server.mjs` and `scripts/bridge.mjs`. Plain Node.js 18+, no dependencies.
- **Pairing**: the host prints a single-use code (15 min). The two sides run an X25519 key exchange and
  derive the session key on each side, so the key never crosses the wire. Every request and response is
  AES-256-GCM encrypted and bound to its route, sender, time and nonce, so replays and tampering are rejected.
- **Listening**: a Claude session only runs on its turn. The agent runs `bridge wait` in the background; it
  long-polls and exits when a message arrives, which wakes the session. No polling loops.
- **Protocol**: typed messages (`hello`, `test_scenarios`, `data_request`, `data_response`, `bug_report`,
  `fix_ready`, `declined`, `final_report`, ...). See [references/protocol.md](references/protocol.md).
- **Safety**: messages from the other agent are treated as data, not instructions. Test data only goes to
  staging/dev; production, deploys, deletes and secrets need the local user's approval or are refused. See
  [references/security.md](references/security.md).

## Install

Do this on **both** machines. Both need Node.js 18+. The host needs [ngrok](https://ngrok.com/download)
(signed in once with `ngrok config add-authtoken <token>`) unless both machines are on the same network.

**As a plugin** (recommended; updates arrive through `/plugin`):

```
/plugin marketplace add Latth/agent-bridge
/plugin install agent-bridge@latth-agent-bridge
```

As a plugin, the skill's command is namespaced under the plugin name. Type `/agent-bridge` and pick it
from the list.

**As a plain skill**:

```bash
git clone https://github.com/Latth/agent-bridge ~/.claude/skills/agent-bridge
```

On Windows: `git clone https://github.com/Latth/agent-bridge "%USERPROFILE%\.claude\skills\agent-bridge"`.
Update later with `git pull` in that folder.

Both machines should run the same version. Each side's `hello` carries it, and the CLI warns when the
versions differ (`bridge version` shows yours).

## Use

On the host machine (for example backend):

```
/agent-bridge host --role backend          # via ngrok (default)
/agent-bridge host --role backend --lan    # same network, no ngrok
```

It prints something like:

```
/agent-bridge connect https://abcd-1234.ngrok-free.app --code 7KQ2M-X9D4F --role <their role>
```

Send that line to the other team. They run it in their Claude session, with `--role mobile` or
`--role frontend`, or no role at all, in which case it is inferred from the project. From then on, talk to
your own agent normally ("send them the scenarios for the login change", "report the S2 failure").

More than two agents can join one relay. Ask the host agent for a new pairing code for each extra device;
it runs `bridge code`.

If the host machine restarts, ngrok's free plan gives it a new URL. Run `/agent-bridge host --role backend`
again. Already-paired peers keep their keys and only need `/agent-bridge resume <new-url>`. No new code is
needed until someone runs `close`.

## Status

Tested:
- 19 end-to-end tests of the relay and CLI (`node --test tests/*.test.mjs`): pairing, encryption, replay and tamper
  rejection, attachments, long-poll, resume after a host restart, version reporting, thread reuse.
- Behavior evals with a scripted peer, covering four scenarios: backend creates staging data, backend refuses
  a production migration and secrets, mobile bug report, web bug report. With the skill all 26 checks
  passed; without it, about 57–81%. See [tests/eval-harness/README.md](tests/eval-harness/README.md).

- A field smoke test between two machines on different networks over ngrok: pairing, `hello` in both
  directions, an attachment, and background wake-up on every message.

**Not yet verified in the field**: a full data-request → fix → retest cycle on a real project, and very long
sessions. Feedback and issues are welcome.

## Layout

```
SKILL.md                 instructions Claude follows
scripts/                 relay + CLI (Node, no deps)
references/              protocol, security, networking, role playbooks (backend/mobile/frontend), device & web testing
tests/e2e.test.mjs       relay/CLI tests
tests/eval-harness/      scripted peer, fixtures (fake projects with fake secrets), grader
evals/                   behavior test cases (claude plugin eval layout)
```

## License

MIT, see [LICENSE](LICENSE).
