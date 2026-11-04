// Shared case files: create, share, wake the peer, diff on fetch, refuse stale writes, merge, report.
// Run: node --test tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineDiff } from '../scripts/lib.mjs';
import { buildReport } from '../scripts/report.mjs';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-case-'));
const BE = path.join(ROOT, 'be');
const MO = path.join(ROOT, 'mo');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const work = (dir) => path.join(dir, 'cases', 'order-total-zero.md');

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
  await run(BE, 'close');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('lineDiff shows only changed lines', () => {
  const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(d.lines, ['@@ line 2', '- b', '+ B', '@@ line 5', '+ e']);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.equal(lineDiff('same', 'same').lines.length, 0);
  assert.equal(lineDiff('', Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'), 10).truncated, true);
});

test('setup: backend hosts, mobile joins', async () => {
  const h = await run(BE, 'host', '--role', 'backend', '--lan', '--port', String(PORT), '--json');
  assert.equal(h.code, 0, h.stderr);
  const c = await run(MO, 'connect', `127.0.0.1:${PORT}`, '--code', h.json.pairing_code, '--role', 'mobile');
  assert.equal(c.code, 0, c.stderr);
  assert.equal((await run(BE, 'wait', '--timeout', '5')).code, 0);
});

test('case new writes a local draft from a template and shares nothing yet', async () => {
  const r = await run(MO, 'case', 'new', 'order-total-zero', '--title', 'Order total shows 0', '--template', 'investigation');
  assert.equal(r.code, 0, r.stderr);
  const text = fs.readFileSync(work(MO), 'utf8');
  assert.match(text, /^# Case: Order total shows 0/);
  assert.match(text, /## Root cause/);
  assert.match(text, /opened by mobile/);
  assert.match((await run(MO, 'case', 'list')).stdout, /no case files yet/);
  const bad = await run(MO, 'case', 'new', 'x', '--template', 'nope');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /investigation/);
  assert.equal((await run(MO, 'case', 'new', 'Bad Name')).code, 1);
});

test('case put shares v1 and wakes the peer with case_updated', async () => {
  fs.appendFileSync(work(MO), '\nE1 (mobile): GET /v2/orders/o_123 -> 200, "total": 0\n');
  const p = await run(MO, 'case', 'put', 'order-total-zero', '--note', 'symptom, E1', '--ask', 'A1: why is total 0?', '--to', 'backend');
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /v1 shared → 1/);
  const w = await run(BE, 'wait', '--timeout', '5');
  assert.match(w.stdout, /case_updated · from mobile/);
  assert.match(w.stdout, /"ask":"A1: why is total 0\?"/);
  assert.match(w.stdout, /case get order-total-zero/);
  assert.doesNotMatch(w.stdout, /E1 \(mobile\)/, 'the case content itself must not ride in the message');
});

test('case get: first copy, then only the diff', async () => {
  const g = await run(BE, 'case', 'get', 'order-total-zero');
  assert.equal(g.code, 0, g.stderr);
  assert.match(g.stdout, /v1 "Order total shows 0" · by mobile/);
  assert.match(g.stdout, /first copy/);
  assert.equal(fs.readFileSync(work(BE), 'utf8'), fs.readFileSync(work(MO), 'utf8'));
  fs.appendFileSync(work(BE), 'F1 (backend): discount applied twice in PriceService\n');
  const p = await run(BE, 'case', 'put', 'order-total-zero', '--note', 'F1', '--to', 'mobile');
  assert.match(p.stdout, /v2 shared/);
  await run(MO, 'wait', '--timeout', '5');
  const g2 = await run(MO, 'case', 'get', 'order-total-zero');
  assert.match(g2.stdout, /changes since v1 \(\+1 -0\)/);
  assert.match(g2.stdout, /\+ F1 \(backend\): discount applied twice/);
  assert.doesNotMatch(g2.stdout, /## Symptom/, 'unchanged lines are not printed');
  assert.match((await run(MO, 'case', 'get', 'order-total-zero')).stdout, /no changes since your copy/);
});

test('a stale put is refused, get keeps local edits, the merged put succeeds', async () => {
  fs.appendFileSync(work(BE), 'F2 (backend): only orders with coupons\n');
  assert.equal((await run(BE, 'case', 'put', 'order-total-zero', '--note', 'F2')).code, 0);
  await run(MO, 'wait', '--timeout', '5');
  // mobile edited v2 without fetching v3
  fs.appendFileSync(work(MO), 'E2 (mobile): o_124 shows 0 too\n');
  const stale = await run(MO, 'case', 'put', 'order-total-zero', '--note', 'E2');
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /stale: case "order-total-zero" is at v3 \(by backend: F2\)/);
  const g = await run(MO, 'case', 'get', 'order-total-zero');
  assert.match(g.stdout, /your unsent edits stay in/);
  assert.match(g.stdout, /\+ F2 \(backend\)/);
  assert.match(fs.readFileSync(work(MO), 'utf8'), /E2 \(mobile\)/, 'local edits are kept');
  assert.ok(fs.existsSync(path.join(MO, 'cases', 'order-total-zero.v3.md')));
  fs.appendFileSync(work(MO), 'F2 (backend): only orders with coupons\n'); // the merge
  const p = await run(MO, 'case', 'put', 'order-total-zero', '--note', 'E2 (merged v3)');
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /v4 shared/);
  const log = await run(BE, 'case', 'log', 'order-total-zero');
  assert.deepEqual(log.stdout.trim().split('\n').map((l) => l.split(/\s+/)[0]), ['v1', 'v2', 'v3', 'v4']);
  const old = await run(BE, 'case', 'get', 'order-total-zero', '--version', '1');
  assert.match(old.stdout, /v1 \(latest v4\)/);
});

test('put refuses an unchanged file and secrets', async () => {
  await run(BE, 'wait', '--timeout', '3');
  await run(BE, 'case', 'get', 'order-total-zero');
  const same = await run(BE, 'case', 'put', 'order-total-zero');
  assert.equal(same.code, 1);
  assert.match(same.stderr, /nothing changed/);
  fs.appendFileSync(work(BE), 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"\n');
  const sec = await run(BE, 'case', 'put', 'order-total-zero');
  assert.equal(sec.code, 5);
  assert.match(sec.stderr, /secrets/);
  assert.doesNotMatch(sec.stderr, /abcdefghijklmnop/);
});

test('case list and the report include the case', async () => {
  const l = await run(MO, 'case', 'list');
  assert.match(l.stdout, /order-total-zero\s+v4/);
  const r = await run(BE, 'report', '--json');
  assert.equal(r.code, 0, r.stderr);
  const md = fs.readFileSync(r.json.file, 'utf8');
  assert.match(md, /## Case files/);
  assert.match(md, /### Order total shows 0 \(`order-total-zero`, v4\)/);
  assert.match(md, /E2 \(mobile\): o_124 shows 0 too/);
  assert.doesNotMatch(md, /<!--/, 'template hints are stripped');
  assert.match(md, /`case_updated` · .*order-total-zero v1 · symptom, E1 · ask: A1/);
});

test('buildReport only embeds cases that belong to the thread', () => {
  const msgs = [{ id: 'm1', ts: '2026-11-04T10:00:00Z', type: 'case_updated', thread_id: 't1', from: { id: 'p', role: 'mobile' }, to: '*', body: { case: 'a', version: 1 } }];
  const cases = [{ slug: 'a', title: 'A', version: 1, content: '# A\n\n## Notes\nalpha\n' }, { slug: 'b', title: 'B', version: 1, content: '# B\nbeta\n' }];
  const md = buildReport(msgs, { thread: 't1', cases });
  assert.match(md, /alpha/);
  assert.match(md, /#### Notes/);
  assert.doesNotMatch(md, /beta/);
});
