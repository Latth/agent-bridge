// Dashboard: access control, no key leaks, attachment serving, live updates. Run: node --test tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'abdash-'));
const A = path.join(ROOT, 'host');
const B = path.join(ROOT, 'peer');
const BASE = 24000 + Math.floor(Math.random() * 8000);
const [RELAY, DASH_A, DASH_B] = [BASE, BASE + 1, BASE + 2];

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

/** Raw GET so the Host header can be set (fetch does not allow it). */
function get(port, pathAndQuery, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, headers: { host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

let urlA;
let tokenA;
const png = crypto.randomBytes(500);

after(async () => {
  await run(B, 'dashboard', '--stop');
  await run(A, 'close');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('setup: a host, a peer and a few messages with an attachment', async () => {
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(RELAY), '--json');
  assert.equal(h.code, 0, h.stderr);
  const c = await run(B, 'connect', `127.0.0.1:${RELAY}`, '--code', h.json.pairing_code, '--role', 'mobile', '--json');
  assert.equal(c.code, 0, c.stderr);
  const shot = path.join(ROOT, 'shot.png');
  fs.writeFileSync(shot, png);
  assert.equal((await run(B, 'send', '--type', 'hello', '--to', 'backend', '--thread', 'smoke', '--body', '{"role":"mobile"}')).code, 0);
  assert.equal((await run(B, 'send', '--type', 'bug_report', '--to', 'backend', '--body', '{"bug_id":"B1","note":"<img src=x onerror=alert(1)>"}', '--file', shot)).code, 0);
  const w = await run(A, 'wait', '--timeout', '5', '--json'); // the host saves the attachment into its inbox
  assert.ok(w.json.messages.some((m) => m.type === 'bug_report'));
});

test('host dashboard starts on loopback and prints a tokenized URL', async () => {
  const d = await run(A, 'dashboard', '--port', String(DASH_A), '--json');
  assert.equal(d.code, 0, d.stderr);
  urlA = new URL(d.json.url);
  tokenA = urlA.searchParams.get('t');
  assert.equal(urlA.hostname, '127.0.0.1');
  assert.ok(tokenA && tokenA.length >= 24);
  const again = await run(A, 'dashboard', '--json');
  assert.equal(again.json.url, d.json.url, 'a second call reuses the running dashboard');
});

test('requests without the token, or with a foreign Host header, are refused', async () => {
  assert.equal((await get(DASH_A, '/')).status, 401);
  assert.equal((await get(DASH_A, '/api/state?t=wrong-token-wrong-token')).status, 401);
  assert.equal((await get(DASH_A, `/api/state?t=${tokenA}`, 'evil.example:80')).status, 403, 'DNS-rebinding style Host is rejected');
});

test('the page is served with a strict CSP and a fresh nonce', async () => {
  const r = await get(DASH_A, `/?t=${tokenA}`);
  assert.equal(r.status, 200);
  const csp = r.headers['content-security-policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(r.body.toString(), /__NONCE__/);
});

test('state has the conversation, resolves attachments, and leaks no keys', async () => {
  const r = await get(DASH_A, `/api/state?t=${tokenA}`);
  assert.equal(r.status, 200);
  const text = r.body.toString();
  const data = JSON.parse(text);
  assert.equal(data.me.role, 'backend');
  assert.deepEqual(data.peers.map((p) => p.role).sort(), ['backend', 'mobile']);
  const types = data.messages.map((m) => m.type);
  for (const t of ['peer_joined', 'hello', 'bug_report']) assert.ok(types.includes(t), `has ${t}`);
  // no session key material anywhere in the payload
  const sessKey = JSON.parse(fs.readFileSync(path.join(A, 'session.json'), 'utf8')).key;
  const peerKeys = Object.values(JSON.parse(fs.readFileSync(path.join(A, 'server-state.json'), 'utf8')).peers).map((p) => p.key);
  for (const k of [sessKey, ...peerKeys]) assert.ok(!text.includes(k), 'key must not appear');
  assert.ok(!data.peers.some((p) => 'key' in p));
  // the attachment the host received is served as an image
  const bug = data.messages.find((m) => m.type === 'bug_report');
  assert.ok(bug.attachments[0].file, 'attachment resolved to a local file');
  const f = await get(DASH_A, `/files/${bug.attachments[0].file.split('/').map(encodeURIComponent).join('/')}?t=${tokenA}`);
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-type'], 'image/png');
  assert.ok(png.equals(f.body));
});

test('file paths cannot escape the inbox', async () => {
  for (const p of ['/files/..%2F..%2Fsession.json', '/files/x/..%2F..%2Fsession.json', '/files/x/session.json']) {
    const r = await get(DASH_A, `${p}?t=${tokenA}`);
    assert.notEqual(r.status, 200, p);
  }
});

test('new messages arrive on the live stream', async () => {
  const got = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: DASH_A, path: `/api/events?t=${tokenA}`, headers: { host: `127.0.0.1:${DASH_A}` } }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('live-check-123')) { req.destroy(); resolve(buf); }
      });
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('no live event within 6s')); }, 6000);
  });
  await sleep(300);
  await run(B, 'send', '--type', 'note', '--to', 'backend', '--body', 'live-check-123');
  const stream = await got;
  assert.match(stream, /event: messages/);
});

test('a peer can run its own dashboard over its local log', async () => {
  const d = await run(B, 'dashboard', '--port', String(DASH_B), '--json');
  assert.equal(d.code, 0, d.stderr);
  const t = new URL(d.json.url).searchParams.get('t');
  assert.notEqual(t, tokenA, 'each dashboard has its own token');
  const data = JSON.parse((await get(DASH_B, `/api/state?t=${t}`)).body.toString());
  assert.equal(data.me.role, 'mobile');
  assert.ok(data.messages.some((m) => m.type === 'bug_report' && m.direction === 'out'));
});

test('close stops the dashboard', async () => {
  const pid = JSON.parse(fs.readFileSync(path.join(A, 'dashboard.json'), 'utf8')).pid;
  const c = await run(A, 'close');
  assert.match(c.stdout, /Dashboard stopped/);
  await sleep(400);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
  await assert.rejects(get(DASH_A, `/api/state?t=${tokenA}`));
});
