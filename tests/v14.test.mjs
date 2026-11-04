// 1.4: outgoing secret scan. Run: node --test tests/*.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scanSecrets } from '../scripts/lib.mjs';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ab14-'));
const A = path.join(ROOT, 'host');
const B = path.join(ROOT, 'peer');
const PORT = 36600 + Math.floor(Math.random() * 2000);

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

after(async () => {
  await run(A, 'close');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('scanner flags real credential shapes', () => {
  const flagged = {
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.SECRET-TOKEN-5521.sig': 'JWT',
    'PROD_DATABASE_URL=postgres://admin:hunter2-PROD-9921@prod-db.acme.internal/acme': 'credentials in URL',
    'JWT_SECRET=test-secret-DO-NOT-SHARE-7731': 'secret-looking field',
    '{"refreshToken":"refresh-PRIVATE-7702"}': 'secret-looking field',
    'Cookie: acme_session=websess-PRIVATE-4410': 'cookie',
    'key AKIAIOSFODNN7EXAMPLE here': 'AWS access key',
    '-----BEGIN RSA PRIVATE KEY-----': 'private key',
    'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB': 'GitHub token',
  };
  for (const [text, kind] of Object.entries(flagged)) {
    assert.ok(scanSecrets(text).some((f) => f.kind === kind), `${kind} in: ${text}`);
  }
});

test('scanner lets redacted values and ordinary test data through', () => {
  for (const text of [
    'Authorization: [REDACTED]\nCookie: [REDACTED]',
    '{"chipNumber":"9936677716","pin":"9742","taskId":"t_1737","user":"u_48213","request_id":"req_9c1e"}',
    '{"title":"Lockout returns 500","suspected_layer":"backend","url":"https://api.staging.acme.dev/v2/auth/chip-login"}',
    '{"can_create_token":true,"password_policy":"required","api_key":"<REDACTED>"}',
    'token refresh works after the fix',
  ]) assert.deepEqual(scanSecrets(text), [], text);
});

test('scanner output never contains the full secret', () => {
  const [f] = scanSecrets('JWT_SECRET=test-secret-DO-NOT-SHARE-7731');
  assert.ok(!f.sample.includes('DO-NOT-SHARE-7731'));
});

test('send refuses secret-looking bodies and text attachments, allows them with --allow-secrets', async () => {
  const h = await run(A, 'host', '--role', 'backend', '--ngrok', 'false', '--port', String(PORT), '--json');
  assert.equal(h.code, 0, h.stderr);
  assert.equal((await run(B, 'connect', `127.0.0.1:${PORT}`, '--code', h.json.pairing_code, '--role', 'mobile')).code, 0);
  await run(A, 'wait', '--timeout', '3');

  const bad = await run(B, 'send', '--type', 'answer', '--to', 'backend', '--body', '{"env":"JWT_SECRET=test-secret-DO-NOT-SHARE-7731"}');
  assert.equal(bad.code, 5);
  assert.match(bad.stderr, /not sent: this looks like it contains secrets/);
  assert.doesNotMatch(bad.stderr, /DO-NOT-SHARE-7731/, 'the error does not repeat the secret');

  const log = path.join(ROOT, 'logcat.txt');
  fs.writeFileSync(log, 'D OkHttp: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.SECRET-TOKEN-5521.sig\n');
  const att = await run(B, 'send', '--type', 'bug_report', '--to', 'backend', '--body', '{"bug_id":"B1"}', '--file', log);
  assert.equal(att.code, 5);
  assert.match(att.stderr, /logcat\.txt: JWT/);

  const png = path.join(ROOT, 'shot.png');
  fs.writeFileSync(png, crypto.randomBytes(400)); // binary attachments are not scanned
  assert.equal((await run(B, 'send', '--type', 'bug_report', '--to', 'backend', '--body', '{"bug_id":"B1"}', '--file', png)).code, 0);

  const ok = await run(B, 'send', '--type', 'data_response', '--to', 'backend', '--allow-secrets', '--body', '{"test_password":"staging-only-pass-1"}');
  assert.equal(ok.code, 0, ok.stderr);

  const w = await run(A, 'wait', '--timeout', '5', '--json');
  assert.deepEqual(w.json.messages.map((m) => m.type), ['bug_report', 'data_response'], 'refused messages never reached the host');
});
