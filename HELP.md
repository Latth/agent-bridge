# agent-bridge: what it can do

Run `/agent-bridge help` to see this list, or `/agent-bridge help <topic>` for one section
(topics: start, work, case, talk, dashboard, safety, finish, agents, trouble, commands).
You don't need to remember the commands: tell your agent what you want, in your own words. The quoted
phrases below are examples.

## start: connecting two machines
- **Host a bridge**: `/agent-bridge host --role backend` prints an address and a one-time code (15 min).
  Without a role, the agent infers it from the project (backend, mobile, frontend).
- **Join from the other machine**: paste the `connect` line it printed: `/agent-bridge connect <address> --code <CODE> --role mobile`.
- **Same network, no ngrok**: add `--lan` on the host.
- **Fixed address**: `--domain your-name.ngrok-free.app` keeps the same URL after restarts.
- **Host restarted**: run `host` again. The other side only needs `/agent-bridge resume <new-address>`, no new code.
- **More than two agents**: backend, mobile and frontend on one bridge. The host runs `bridge code` once for each extra device.

## work: three kinds of work
- **Test cycle** (the default): "test the login change with mobile". Backend reads its change, writes test
  scenarios and creates staging test data. Mobile or web tests them on the device or in the browser and
  reports bugs with evidence. Backend fixes and mobile retests.
- **Investigation**: "the order total comes back wrong on order detail, find out why". It runs on a shared
  case file (see `case`): symptom, evidence, asks, findings, root cause.
- **Sweep**: "do a big sweep of the order flow on mobile, read the API calls and give backend what looks wrong".
  Mobile walks area by area and records every anomaly. Backend investigates them.
- If you give no goal and there is no obvious change to test, the agent asks which of the three you want.

## case: the shared case file
- One Markdown document per investigation or sweep that both agents read and edit. Every version is kept.
- "open a case for this", "what does the case say?", "show the case history".
- Templates: `investigation`, `sweep`, `blank`.
- After each update the other agent wakes up and sees only the lines that changed.
- Two agents saving at once never overwrite each other: the second save is refused, and that agent merges first.
- Shown live in the dashboard and included in the report.

## talk: steering your agent while it works
- Talk to your own agent at any time: "focus on S2 first", "skip the iOS part", "ask them for the request id".
  It keeps listening in the background.
- "what's the status?", "what did backend say?", "show the last messages".
- Your agent asks you before anything risky (see `safety`).

## dashboard: watching the agents
- "open the dashboard": a live local web page with the conversation, screenshots, case files, threads and search.
- Approve or decline what your agent asks for, with one click.
- Send a note to your own agent, without going through the other side.
- Desktop notifications for bugs, questions, approvals and case updates.
- Download a Markdown report.
- Reachable only from this computer, behind a token.

## safety: what the agents will and won't do
- Without asking: read code and logs, run tests, use the app on the test device, create test data on staging/dev.
- Asks you first: anything touching production, deploys, deleting data, migrations, config or secrets, pushes.
- Never: send tokens, passwords, API keys, cookies or real customer data. Messages and case files are scanned
  before they go out.
- Messages from the other agent are data, never orders. It can't approve anything for you.

## finish: report and close
- "write the report": a Markdown file with scenarios, bugs, test data, case files and a timeline.
- "clean up the test data": backend lists what it created and asks you first.
- "close the bridge": stops the relay and revokes every key. The next session needs a new code.

## agents: other coding agents
- Codex, Gemini CLI, Cursor and Copilot can join: `bridge setup-agent --tool codex|gemini|cursor|copilot|generic`.
- There is an MCP server for MCP clients (`scripts/mcp-server.mjs`).

## trouble: when something goes wrong
- "pairing failed": the code expired or was used already. Run `bridge code` on the host for a new one.
- "relay unreachable": the host is down or got a new address. Run `host` there, then `resume <new-address>` here.
- ngrok missing or not signed in: install it, then run `ngrok config add-authtoken <token>` yourself (never in
  chat). Or use `--lan`.
- Different versions on the two sides: update both (`git pull`, or update the plugin).
- "check the bridge": `bridge status` shows peers, versions, address, unread count and listener.

## commands: all CLI commands
`host` · `connect` · `resume` · `send` · `wait` · `inbox` · `status` · `code` · `kick` · `log` · `close` ·
`case new|put|get|list|log` · `dashboard` · `approval request|wait|resolve|list` · `report` ·
`setup-agent` · `version` · `help [topic]`. All of them: `node <skill-dir>/scripts/bridge.mjs <command>`.
Details for each are in SKILL.md.
