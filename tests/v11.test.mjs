// Tests for the 1.1 additions: versions, resume after a host restart, thread reuse, listener reminder,
// ngrok error classification. Run: node --test tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ngrokErrorKind, compareVersions, SKILL_VERSION } from '../scripts/lib.mjs';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ab11-'));
const A = path.join(ROOT, 'host');
const B = path.join(ROOT, 'peer');
const PORT = 21000 + Math.floor(Math.random() * 10000);
const PORT2 = PORT + 1;

function run(dir, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, '--dir', dir], { cwd: ROOT });
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

test('ngrok errors are classified, "too old" before "authentication failed"', () => {
  assert.equal(ngrokErrorKind('authentication failed: Your ngrok-agent version "3.3.1" is too old. The minimum supported agent version for your account is "3.28.0".'), 'too_old');
  assert.equal(ngrokErrorKind('ERR_NGROK_4018: Usage of ngrok requires a verified account and authtoken'), 'auth');
  assert.equal(ngrokErrorKind('ERR_NGROK_108: Your account is limited to 1 simultaneous ngrok agent session'), 'busy');
  assert.equal(ngrokErrorKind('dial tcp: lookup connect.ngrok-agent.com: no such host'), 'other');
});

test('compareVersions orders dotted versions and treats unknown as oldest', () => {
  assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions(null, SKILL_VERSION), -1);
});

test('host and peer report their versions', async () => {
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(PORT), '--json');
  assert.equal(h.code, 0, h.stderr);
  const c = await run(B, 'connect', `127.0.0.1:${PORT}`, '--code', h.json.pairing_code, '--role', 'mobile', '--json');
  assert.equal(c.code, 0, c.stderr);
  assert.equal(c.json.version, SKILL_VERSION);
  const s = await run(A, 'status', '--json');
  assert.deepEqual([...new Set(s.json.peers.map((p) => p.version))], [SKILL_VERSION]);
  const joined = await run(A, 'wait', '--timeout', '5', '--json');
  assert.equal(joined.json.messages[0].body.peer.version, SKILL_VERSION);
  const v = await run(B, 'version');
  assert.match(v.stdout, new RegExp(`agent-bridge ${SKILL_VERSION.replace(/\./g, '\\.')}`));
});

test('send reminds when no listener runs, and keeps the conversation in one thread', async () => {
  const first = await run(B, 'send', '--type', 'hello', '--to', 'backend', '--thread', 'smoke', '--body', '{}', '--json');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.listener_running, false);
  const firstText = await run(B, 'send', '--type', 'note', '--to', 'backend', '--body', 'x');
  assert.match(firstText.stdout, /no listener running/);
  assert.match(firstText.stdout, /\(#smoke, continued\)/);
  const fresh = await run(B, 'send', '--type', 'note', '--to', 'backend', '--new-thread', '--body', 'y', '--json');
  assert.equal(fresh.json.thread_id, null);
  // a listener in the background silences the reminder (drain the host's unread messages first,
  // otherwise wait returns at once and is no longer running when we send)
  await run(A, 'wait', '--timeout', '0');
  const listening = run(A, 'wait', '--timeout', '8');
  await sleep(700);
  const quiet = await run(A, 'send', '--type', 'note', '--to', 'mobile', '--body', 'z');
  assert.doesNotMatch(quiet.stdout, /no listener running/);
  await listening;
});

test('after a host restart on a new address, the peer resumes without a new code', async () => {
  const srv = JSON.parse(fs.readFileSync(path.join(A, 'server.json'), 'utf8'));
  process.kill(srv.pid); // crash / reboot, not `close`: keys survive in server-state.json
  await sleep(600);
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(PORT2));
  assert.equal(h.code, 0, h.stderr);
  assert.match(h.stdout, /Already paired \(mobile\)/);
  assert.match(h.stdout, new RegExp(`resume 127\\.0\\.0\\.1:${PORT2}`));

  const r = await run(B, 'resume', `127.0.0.1:${PORT2}`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /resumed: mobile/);

  const s = await run(B, 'send', '--type', 'note', '--to', 'backend', '--body', 'after resume', '--json');
  assert.equal(s.code, 0, s.stderr);
  const w = await run(A, 'wait', '--timeout', '5', '--json');
  assert.ok(w.json.messages.some((m) => m.body === 'after resume'));
});

test('resume refuses cleanly once the host has closed the bridge', async () => {
  await run(A, 'close');
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(PORT2));
  assert.equal(h.code, 0, h.stderr);
  const r = await run(B, 'resume', `127.0.0.1:${PORT2}`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no longer knows this device/);
  const sess = JSON.parse(fs.readFileSync(path.join(B, 'session.json'), 'utf8'));
  assert.ok(!sess.resumed_at || Date.parse(sess.resumed_at) < Date.now() - 500, 'a failed resume does not rewrite the session');
});

test('resume is refused on the host itself', async () => {
  const r = await run(A, 'resume', `127.0.0.1:${PORT2}`);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /host does not resume/);
});
