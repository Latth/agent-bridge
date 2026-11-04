#!/usr/bin/env node
// Measures what the listening agent pays for a typical burst: the peer sends a bug report, a progress update
// and an ack within ~1 s. Reports how many `wait` returns (agent turns) that burst takes and how many
// characters of output the agent has to read. Run: node tests/token-measure.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'abtok-'));
const A = path.join(ROOT, 'host');
const B = path.join(ROOT, 'peer');
const PORT = 30000 + Math.floor(Math.random() * 5000);
const run = (dir, ...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args, '--dir', dir]);
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bug = {
  bug_id: 'B1', scenario_id: 'S2', severity: 'high', title: 'Lockout returns 500 instead of 423',
  steps: ['Login screen', 'Chip 9900112234, wrong PIN x6'], expected: '423 + lockout message', actual: '500, generic error toast',
  suspected_layer: 'backend',
  evidence: {
    requests: Array.from({ length: 6 }, (_, i) => ({ ts: `2026-11-04T10:31:0${i}.882Z`, method: 'POST', url: '/v2/auth/chip-login', status: i < 5 ? 401 : 500, request_id: `req_9a0${i}` })),
    logcat_excerpt: Array.from({ length: 30 }, (_, i) => `11-04 13:31:07.${900 + i} E/AuthRepository: chip-login failed: HTTP 500 {"error":"internal"} attempt=${i}`).join('\n'),
  },
};

try {
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(PORT), '--json');
  const code = JSON.parse(h.out).pairing_code;
  await run(B, 'connect', `127.0.0.1:${PORT}`, '--code', code, '--role', 'mobile');
  await run(A, 'wait', '--timeout', '3'); // consume peer_joined
  const f = path.join(ROOT, 'bug.json');
  fs.writeFileSync(f, JSON.stringify(bug));

  // The listener is already waiting when the burst starts, as it would be in a real session.
  const turns = [];
  const listen = async () => {
    while (true) {
      const r = await run(A, 'wait', '--timeout', '4');
      if (/no new messages/.test(r.out)) break;
      turns.push(r.out);
    }
  };
  const listening = listen();
  await sleep(400);
  await run(B, 'send', '--type', 'bug_report', '--to', 'backend', '--thread', 'login-v2', '--body-file', f);
  await run(B, 'send', '--type', 'test_progress', '--to', 'backend', '--body', '{"scenario_id":"S2","status":"failed"}');
  await run(B, 'send', '--type', 'ack', '--to', 'backend', '--body', '{"received":"fix plan"}');
  await listening;
  const chars = turns.reduce((n, t) => n + t.length, 0);
  console.log(JSON.stringify({ turns: turns.length, chars, approx_tokens: Math.round(chars / 4), body_chars: JSON.stringify(bug).length }));
  if (process.argv.includes('--show')) console.log(turns.join('\n----- next turn -----\n'));
} finally {
  await run(A, 'close');
  fs.rmSync(ROOT, { recursive: true, force: true });
}
