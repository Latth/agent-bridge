# Eval harness

These are behavior tests for the skill. Each case in `../../evals/` runs one agent, either with the skill or
without it (the baseline gets the CLI but no SKILL.md). The agent talks to a **scripted peer**
(`fake-peer.mjs`). The peer hosts a relay, sends the case's `peer-script.json` messages once the agent joins,
and records everything the agent sends back.

```bash
# 1. lay out an iteration (use a short path on Windows)
node tests/eval-harness/prepare-iteration.mjs . ../ab-evals/i1

# 2. start one scripted peer per run; prints address + pairing code for each (codes expire in 15 min)
node tests/eval-harness/start-peers.mjs . ../ab-evals/i1 32000

# 3. run an agent per run directory with the case's prompt.md, replacing {ADDRESS} and {CODE};
#    work in <run>/outputs/project and write <run>/outputs/final_message.md
#    (with_skill: point it at SKILL.md; without_skill: at ../ab-evals/cli-only/scripts/bridge.mjs)

# 4. grade: writes <run>/grading.json from the peer transcript, the project files and the final message
node tests/eval-harness/grade.mjs ../ab-evals/i1
```

`grade.mjs` checks most assertions programmatically: the messages the peer received, the database state,
and whether secrets leaked into messages or attachments. A few checks are heuristic and say so in their
evidence. Review those by hand.

The fixtures (`fixtures/acme-*`) are fake projects. The "secrets" in them (`.env`, tokens in logs and HAR)
are **deliberately fake markers** that let the tests detect leaks. They are not real credentials.
