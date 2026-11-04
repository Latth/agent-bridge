# Networking: ngrok, LAN, troubleshooting

## ngrok (default, works across networks)

The relay listens only on `127.0.0.1`. ngrok gives it a public HTTPS address, so no router or firewall
change is needed.

One-time setup on the **host** machine. The user does this; the authtoken is their secret:
1. Install: Windows `winget install ngrok.ngrok`, macOS `brew install ngrok`, Linux: see ngrok.com/download.
2. Create a free account at dashboard.ngrok.com and copy the authtoken.
3. In their own terminal: `ngrok config add-authtoken <token>`.

Then `bridge host --role backend` starts the relay and the tunnel and prints the `https://....ngrok-free.app`
address. Notes:
- On the free plan the URL changes every time ngrok restarts. When the host machine restarts, run `host`
  again with the same role. Peers that were already paired keep their keys: they run
  `bridge resume <new-url>`, which the host's output prints, and need no new code. Only `close` ends the
  pairings.
- **A fixed address.** Every ngrok account has a domain of its own (dashboard.ngrok.com → Domains; free
  accounts get one such as `something-random.ngrok-free.dev`). Pass it with `--domain <name>`, or set
  `AGENT_BRIDGE_NGROK_DOMAIN`, and save it in the project profile. The address then survives restarts, and
  peers can reconnect with the same line. On many free accounts ngrok already uses that domain by default.
- ngrok sets a **minimum agent version per account**, so a fresh install from a package manager can be too old
  ("Your ngrok-agent version ... is too old"). The CLI recognizes this and tells you to run `ngrok update`.
- The free plan allows one ngrok agent at a time. If another ngrok is already running, the error mentions
  `ERR_NGROK_108`: close the other one, or use `--lan`.
- The CLI finds ngrok on PATH and in the usual install folders (winget, Chocolatey, Scoop, Homebrew, snap),
  so it works right after `winget install`, before a new shell has picked up PATH. For anything else, pass
  `--ngrok-bin <path>` or set `NGROK_BIN`.

## LAN (same office or Wi-Fi)

`bridge host --role backend --lan` binds the relay to all interfaces on port 7878 and prints the LAN
address(es). The other machine connects with `bridge connect 192.168.1.20:7878 --code ...`.
- **The first time, the OS firewall asks** whether to let Node.js accept connections. The user should allow
  it on **private** networks only. On Windows, if no prompt appeared and connections fail, the user can allow
  `node.exe` in Windows Defender Firewall for private networks.
- Guest or corporate Wi-Fi often isolates clients from each other. If `connect` can't reach the address,
  try ngrok instead.
- VPNs can route LAN traffic away. Try with the VPN off, or use ngrok.
- Quick reachability check from the other machine: `curl http://192.168.1.20:7878/health` should print `{"ok":true,...}`.

`--lan --ngrok` together enables both. The printed `connect` line uses the ngrok URL.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cannot reach ...: ECONNREFUSED` | Relay not running, or wrong port | Host runs `bridge status`; restart with `bridge host ...` |
| `cannot reach ...: ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT` | Firewall, client isolation, VPN, wrong IP | See the LAN notes; or use ngrok |
| `401 pairing failed` | Code typed wrong, expired (15 min), already used, or burned by failed attempts | Host runs `bridge code` and shares the new one |
| `could not prove it knows the pairing code` | Wrong address (another service), or interception | Double-check the URL with the host; do not proceed otherwise |
| `the relay no longer knows this device` | Host ran `close`, or `kick`ed you | Pair again with a fresh code |
| `cannot reach https://....ngrok-free...` after it worked before | Host restarted, so ngrok has a new URL | Host runs `bridge host` again; the peer runs `bridge resume <new-url>` |
| ngrok "agent version ... is too old" | Package-manager ngrok is older than the account's minimum | `ngrok update`, then `bridge host` again |
| `note: ... runs agent-bridge 1.0 ...` | The two machines run different skill versions | Update the older side (`git pull` in the skill folder, or update the plugin) |
| `clock skew` | Device clocks differ by more than 2 min | The CLI resyncs automatically once; if it repeats, fix the system clock |
| `429 rate limited` | Too many requests in a burst | Slow down; never poll in a loop, use `wait` |
| ngrok `ERR_NGROK_4018` / authtoken error | ngrok not signed in | The user runs `ngrok config add-authtoken <token>` |
| `port busy` / `EADDRINUSE` | Something else is on 7878 | `bridge host ... --port 7879` (and `ip:7879` on the other side) |

Logs on the host: `.agent-bridge/server.log` (relay) and `.agent-bridge/tunnel.log` (ngrok).
