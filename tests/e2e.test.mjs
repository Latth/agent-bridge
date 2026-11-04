// End-to-end test: a host ("backend") and a peer ("mobile") on one machine, each with its own state dir.
// Run: node --test agent-bridge/tests/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seal, requestAad, fromB64u, b64u } from '../scripts/lib.mjs';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
const A = path.join(ROOT, 'backend');
const B = path.join(ROOT, 'mobile');
const C = path.join(ROOT, 'intruder');
const PORT = 20000 + Math.floor(Math.random() * 20000);

function run(dir, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, '--dir', dir], { cwd: ROOT, env: { ...process.env, NGROK_BIN: 'ngrok-does-not-exist-xyz' } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() }));
  });
}

after(async () => {
  await run(A, 'close');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let code;
let scenarioMsgId;

test('host refuses to default to ngrok when ngrok is missing, with install help', async () => {
  const r = await run(path.join(ROOT, 'nongrok'), 'host', '--role', 'backend', '--port', String(PORT + 1));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ngrok is not installed/);
  assert.match(r.stderr, /--lan/);
});

test('host starts a LAN relay and prints a pairing code', async () => {
  const r = await run(A, 'host', '--role', 'backend', '--name', 'BE Agent', '--lan', '--port', String(PORT), '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.status, 'started');
  assert.match(r.json.pairing_code, /^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  code = r.json.pairing_code;
  const again = await run(A, 'host', '--role', 'backend', '--lan', '--port', String(PORT), '--json');
  assert.equal(again.json.status, 'already_running');
  assert.ok(fs.readFileSync(path.join(A, '.gitignore'), 'utf8').includes('*'), 'state dir must be git-ignored');
});

test('wrong pairing code is rejected', async () => {
  const r = await run(C, 'connect', `127.0.0.1:${PORT}`, '--code', 'AAAAA-BBBBB', '--role', 'mobile');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pairing failed/);
});

test('peer connects with the code (typed lowercase, no dash)', async () => {
  const r = await run(B, 'connect', `127.0.0.1:${PORT}`, '--code', code.toLowerCase().replace('-', ''), '--role', 'mobile', '--name', 'Mobile Agent', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.me.role, 'mobile');
  assert.deepEqual(r.json.peers.map((p) => p.role).sort(), ['backend', 'mobile']);
});

test('pairing code is single use', async () => {
  const r = await run(C, 'connect', `127.0.0.1:${PORT}`, '--code', code, '--role', 'mobile');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /pairing failed/);
});

test('host is notified that the peer joined', async () => {
  const r = await run(A, 'wait', '--timeout', '5', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.messages[0].type, 'peer_joined');
  assert.equal(r.json.messages[0].body.peer.role, 'mobile');
});

test('long-poll wait wakes up on a message, attachments arrive intact', async () => {
  const shot = path.join(ROOT, 'screen.png');
  const bytes = crypto.randomBytes(3000);
  fs.writeFileSync(shot, bytes);

  const waiting = run(B, 'wait', '--timeout', '30', '--json');
  await new Promise((r) => setTimeout(r, 800));
  const second = await run(B, 'wait', '--timeout', '1');
  assert.equal(second.code, 4, 'a second concurrent listener must be refused');

  const started = Date.now();
  const body = JSON.stringify({ scenarios: [{ id: 'S1', title: 'Login with valid chip number' }] });
  const s = await run(A, 'send', '--type', 'test_scenarios', '--to', 'mobile', '--thread', 'login-v2', '--body', body, '--file', shot, '--json');
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.recipients.length, 1);
  scenarioMsgId = s.json.id;

  const w = await waiting;
  assert.equal(w.code, 0, w.stderr);
  assert.ok(Date.now() - started < 5000, 'wait should return promptly, not at timeout');
  const m = w.json.messages[0];
  assert.equal(m.type, 'test_scenarios');
  assert.equal(m.thread_id, 'login-v2');
  assert.equal(m.from.role, 'backend');
  assert.equal(m.body.scenarios[0].id, 'S1');
  const saved = fs.readdirSync(path.join(B, 'inbox', m.id.replace(/[^\w]/g, '')));
  assert.equal(saved.length, 1);
  assert.ok(bytes.equals(fs.readFileSync(path.join(B, 'inbox', m.id.replace(/[^\w]/g, ''), saved[0]))));
});

test('reply-to inherits thread and goes back to the sender', async () => {
  const s = await run(B, 'send', '--type', 'ui_testable_scenarios', '--reply-to', scenarioMsgId, '--body', 'S1 is testable on screen', '--json');
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.thread_id, 'login-v2');

  const inbox = await run(A, 'inbox', '--json');
  assert.equal(inbox.json.messages.length, 1, 'inbox shows the unread message');
  const inbox2 = await run(A, 'inbox', '--json');
  assert.equal(inbox2.json.messages.length, 1, 'inbox does not consume');

  const w = await run(A, 'wait', '--timeout', '5', '--json');
  const m = w.json.messages[0];
  assert.equal(m.reply_to, scenarioMsgId);
  assert.equal(m.body, 'S1 is testable on screen');
  const after = await run(A, 'wait', '--timeout', '0');
  assert.equal(after.code, 2, 'nothing left after wait consumed it');
});

test('unknown recipient and bad type are rejected with a useful error', async () => {
  const r = await run(A, 'send', '--type', 'test_result', '--to', 'ios', '--body', '{}');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown recipient "ios"; known: mobile/);
  const t = await run(A, 'send', '--type', 'Bad Type!', '--body', '{}');
  assert.equal(t.code, 1);
});

test('tampered, replayed and forged requests are rejected', async () => {
  const sess = JSON.parse(fs.readFileSync(path.join(B, 'session.json'), 'utf8'));
  const route = '/rpc/peers';
  const call = async (key, nonce, mutate) => {
    const ts = Date.now();
    const box = seal(key, {}, requestAad('POST', route, sess.peer_id, ts, nonce));
    if (mutate) box.ct = b64u(Buffer.from(fromB64u(box.ct)).map((b, i) => (i === 0 ? b ^ 1 : b)));
    const res = await fetch(`${sess.server}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ab-peer': sess.peer_id, 'x-ab-ts': String(ts), 'x-ab-nonce': nonce }, body: JSON.stringify(box) });
    return { status: res.status, body: await res.json() };
  };
  const key = fromB64u(sess.key);
  const nonce = b64u(crypto.randomBytes(18));
  assert.equal((await call(key, nonce)).status, 200);
  const replay = await call(key, nonce);
  assert.equal(replay.status, 401);
  assert.match(replay.body.error, /replayed/);
  assert.equal((await call(key, b64u(crypto.randomBytes(18)), true)).status, 401, 'flipped ciphertext bit');
  assert.equal((await call(crypto.randomBytes(32), b64u(crypto.randomBytes(18)))).status, 401, 'wrong key');
});

test('status reports peers and listener state', async () => {
  const r = await run(A, 'status', '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.me.is_host, true);
  assert.equal(r.json.reachable, true);
  assert.equal(r.json.listening, false);
  assert.deepEqual(r.json.peers.map((p) => p.role).sort(), ['backend', 'mobile']);
});

test('host can issue a fresh code; peer leaving notifies the host; host close revokes everything', async () => {
  const c = await run(A, 'code', '--json');
  assert.equal(c.code, 0, c.stderr);
  assert.notEqual(c.json.code, code);

  const leave = await run(B, 'close');
  assert.equal(leave.code, 0, leave.stderr);
  const w = await run(A, 'wait', '--timeout', '5', '--json');
  assert.equal(w.json.messages[0].type, 'peer_left');

  const srv = JSON.parse(fs.readFileSync(path.join(A, 'server.json'), 'utf8'));
  const closed = await run(A, 'close');
  assert.equal(closed.code, 0, closed.stderr);
  await new Promise((r) => setTimeout(r, 500));
  let alive = true;
  try { process.kill(srv.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'relay process stopped');
  assert.equal(fs.existsSync(path.join(A, 'server-state.json')), false, 'keys revoked');
  assert.ok(fs.existsSync(path.join(A, 'messages.jsonl')), 'message log kept');
});
