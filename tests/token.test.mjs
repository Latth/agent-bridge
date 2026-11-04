// Token economy: bursts arrive as one batch, output stays compact, long bodies are cut but kept in full on disk,
// and oversized sends are flagged. Run: node --test tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'abtk-'));
const A = path.join(ROOT, 'host');
const B = path.join(ROOT, 'peer');
const PORT = 33500 + Math.floor(Math.random() * 3000);

function run(dir, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, '--dir', dir], { cwd: dir === A ? A : ROOT });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  await run(A, 'close');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('setup', async () => {
  fs.mkdirSync(A, { recursive: true });
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(PORT), '--json');
  assert.equal(h.code, 0, h.stderr);
  assert.equal((await run(B, 'connect', `127.0.0.1:${PORT}`, '--code', h.json.pairing_code, '--role', 'mobile')).code, 0);
  await run(A, 'wait', '--timeout', '3');
});

test('a burst of messages wakes the listener once, as one batch', async () => {
  const waiting = run(A, 'wait', '--timeout', '20', '--json');
  await sleep(500);
  for (const t of ['test_progress', 'bug_report', 'ack']) {
    await run(B, 'send', '--type', t, '--to', 'backend', '--body', `{"n":"${t}"}`);
    await sleep(300);
  }
  const w = await waiting;
  assert.equal(w.code, 0, w.stderr);
  assert.deepEqual(w.json.messages.map((m) => m.type), ['test_progress', 'bug_report', 'ack']);
});

test('--settle 0 returns on the first message', async () => {
  const waiting = run(A, 'wait', '--timeout', '20', '--settle', '0', '--json');
  await sleep(500);
  await run(B, 'send', '--type', 'note', '--to', 'backend', '--body', 'one');
  const w = await waiting;
  await run(B, 'send', '--type', 'note', '--to', 'backend', '--body', 'two');
  assert.equal(w.json.messages.length, 1);
  await run(A, 'wait', '--timeout', '2'); // drain "two"
});

test('output is compact: one header line per message, single-line bodies', async () => {
  const body = { scenario_id: 'S2', status: 'failed', nested: { a: [1, 2, 3], b: 'x' } };
  const waiting = run(A, 'wait', '--timeout', '20');
  await sleep(500);
  await run(B, 'send', '--type', 'test_progress', '--to', 'backend', '--thread', 'login-v2', '--body', JSON.stringify(body));
  const w = await waiting;
  const lines = w.stdout.trim().split('\n');
  assert.equal(lines.length, 4, `header, message header, body, footer:\n${w.stdout}`);
  assert.match(lines[1], /^\[1\] test_progress · from mobile ".*" → you · #login-v2 · id msg_\w+ · \d\d:\d\d:\d\dZ$/);
  assert.equal(lines[2], JSON.stringify(body));
});

test('long bodies are cut in the output, and the full body is saved to a file', async () => {
  const long = { log: 'x'.repeat(9000) };
  const waiting = run(A, 'wait', '--timeout', '20', '--max-body', '1000');
  await sleep(500);
  const s = await run(B, 'send', '--type', 'bug_report', '--to', 'backend', '--body', JSON.stringify(long));
  assert.match(s.stdout, /note: \d+-char body; the peer pays for every character/);
  const w = await waiting;
  assert.ok(w.stdout.length < 1600, `output stays small (${w.stdout.length} chars)`);
  const m = w.stdout.match(/full body: (\S+?)\]/);
  assert.ok(m, 'points to the full body');
  const saved = JSON.parse(fs.readFileSync(path.resolve(A, m[1]), 'utf8'));
  assert.equal(saved.log.length, 9000);
});
