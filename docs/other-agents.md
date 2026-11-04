# Using agent-bridge with other coding agents

agent-bridge is a plain Node.js CLI and a JSON protocol, so any agent that can run shell commands can take
part: Codex CLI, Gemini CLI, Cursor, GitHub Copilot's agent mode, Aider, or a human. Mixed pairs work too,
for example a Claude backend agent with a Codex mobile agent, because both sides only see protocol messages.

`SKILL.md` is the source of truth for *how* to behave: the workflow, the safety rules and the token budget.
It is written for Claude Code, so this page lists what changes elsewhere.

## Setup in your project

Install the skill folder anywhere, for example `git clone https://github.com/Latth/agent-bridge ~/agent-bridge`.
Then, from **your project's** root:

```bash
node ~/agent-bridge/scripts/bridge.mjs setup-agent --tool codex     # writes/updates AGENTS.md
node ~/agent-bridge/scripts/bridge.mjs setup-agent --tool gemini    # GEMINI.md
node ~/agent-bridge/scripts/bridge.mjs setup-agent --tool cursor    # .cursor/rules/agent-bridge.mdc
node ~/agent-bridge/scripts/bridge.mjs setup-agent --tool copilot   # .github/copilot-instructions.md
node ~/agent-bridge/scripts/bridge.mjs setup-agent --tool generic   # AGENTS.md (most tools read it)
```

`setup-agent` adds a short block between `<!-- agent-bridge:start -->` and `<!-- agent-bridge:end -->`, with
the absolute paths to `SKILL.md` and the CLI. Running it again updates the block in place. The rest of the
file is left alone. It also prints an MCP config snippet for tools that prefer MCP (see below).

After that, ask your agent: *"connect to the agent bridge: `<address>` code `<CODE>`, role mobile"*.

## What changes compared to Claude Code

| In SKILL.md | Elsewhere |
|---|---|
| `/agent-bridge host ...` slash command | Ask in words ("host an agent bridge as backend"), or run the CLI yourself. |
| `<skill-dir>` | The absolute path `setup-agent` wrote into your instruction file. |
| `run_in_background: true` for `bridge wait` | See **Listening** below. |
| Project profile `.claude/agent-bridge-profile.md` | Same file. The path is just a convention, and any tool can read and write it. |

### Listening without background wake-ups

Claude Code wakes the session when a background command exits. That is what makes the bridge cheap: no
tokens are spent while waiting. Other tools differ:

1. **If your tool can run a command in the background and notify the agent when it exits**, do exactly what
   SKILL.md says.
2. **Otherwise, run `bridge wait` in the foreground** with a timeout below your tool's command limit, for
   example `bridge wait --timeout 300` when commands may run for 5 minutes. The call blocks and costs nothing
   while it waits. When it returns with exit 0, handle the messages and run it again. With exit 2 (timeout),
   decide with your user whether to keep listening. Don't spin in a loop for hours unattended.
3. **Never poll with `sleep` + `inbox`/`status`.** Each poll is a model turn. `wait` returns the moment
   something arrives, and a burst comes as one batch.

If your tool kills long commands, lower `--timeout`. A shorter wait only means more turns while idle; no
messages are lost, because the relay keeps them until you read them.

### MCP instead of the shell

If your tool speaks MCP, you can register `scripts/mcp-server.mjs` as a stdio server. It exposes the CLI as
tools: `bridge_status`, `bridge_send`, `bridge_wait`, `bridge_report`, `bridge_approval_request`,
`bridge_approval_wait`. The CLI's guarantees still apply, because each tool runs the CLI underneath: the
secret scan, the compact batched output, the version checks. `setup-agent` prints a config snippet. Typical
shapes:

```jsonc
// Claude Code / Cursor / VS Code style: .mcp.json or the client's mcpServers setting
{ "mcpServers": { "agent-bridge": { "command": "node", "args": ["/abs/path/agent-bridge/scripts/mcp-server.mjs"], "env": { "AGENT_BRIDGE_DIR": "/abs/path/your-project/.agent-bridge" } } } }
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.agent-bridge]
command = "node"
args = ["/abs/path/agent-bridge/scripts/mcp-server.mjs"]
env = { AGENT_BRIDGE_DIR = "/abs/path/your-project/.agent-bridge" }
```

`bridge_wait` is a long tool call. Set its `timeout_seconds` below your client's tool-call timeout. Many
clients default to about 60 seconds, and most let you raise it.

## Status

The CLI, relay, dashboard and MCP server are covered by the automated tests on Windows, macOS and Linux. The
*agent behavior* evals (safety rules, protocol use, token budget) were run with Claude only. Other models
read the same instructions but have not been measured. If you try a mixed pair, please open an issue with
what you saw.
