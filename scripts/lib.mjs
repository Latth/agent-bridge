// Shared helpers for agent-bridge: pairing, key exchange, authenticated encryption, files.
// Node >= 18, no external dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROTOCOL = 'agent-bridge/1';
// Skill/CLI release. The wire protocol above stays compatible; this tells peers which instructions the other side has.
export const SKILL_VERSION = '1.8.0';

/**
 * Classifies an ngrok error line. "too old" is checked first: ngrok words it as an authentication
 * failure, which used to send people to the authtoken instead of `ngrok update`.
 */
export function ngrokErrorKind(msg) {
  const m = String(msg ?? '');
  if (/too old|minimum supported agent version|ERR_NGROK_121/i.test(m)) return 'too_old';
  if (/authtoken|ERR_NGROK_4018|ERR_NGROK_105|ERR_NGROK_107/i.test(m)) return 'auth';
  if (/ERR_NGROK_108|simultaneous|limited to 1/i.test(m)) return 'busy';
  return 'other';
}

// ---------- outgoing secret scan ----------
// A second line of defense under the skill's redaction rules: `send` refuses a message that looks like it
// carries credentials, unless the user explicitly allows it. The patterns favor real credential shapes over
// recall, so ordinary test data (chip numbers, PINs, ids) passes.
const REDACTED = /^(\[?redacted\]?|\*{3,}|x{3,}|<[^>]*>|\.\.\.|…)$/i;
const SECRET_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}/g],
  ['bearer token', /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/gi],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{16,}/g],
  ['credentials in URL', /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"']{1,64}:([^\s@"'/]{3,})@[^\s"']+/gi],
  ['cookie', /\b(?:Set-)?Cookie\s*:\s*[^\s=;"]+=([^\s;"]{8,})/gi],
  ['secret-looking field', /["']?\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?([^\s"',}]{6,})/gi],
];
const mask = (s) => (s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 4)}…(${s.length} chars)`);

/** Returns [{ kind, sample }] for credential-looking content in `text` (empty if none). */
export function scanSecrets(text) {
  const found = [];
  const s = String(text ?? '');
  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const value = m[m.length - 1] ?? m[0];
      if (REDACTED.test(String(value).trim())) continue;
      if (kind === 'secret-looking field' && /^(true|false|null|required|optional|string|number|boolean|\[?redacted\]?)$/i.test(value)) continue;
      found.push({ kind, sample: mask(String(m[0]).slice(0, 80)) });
      if (found.length >= 10) return found;
    }
  }
  return found;
}

/** -1 / 0 / 1 for dotted numeric versions; unknown (null) sorts lowest. */
export function compareVersions(a, b) {
  const pa = String(a ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}
export const DEFAULT_PORT = 7878;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;        // whole HTTP body (base64 + JSON overhead included)
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;  // raw bytes, all attachments of one message
export const CLOCK_SKEW_MS = 120_000;
export const CODE_TTL_MS = 15 * 60_000;
export const MAX_PAIR_FAILURES = 5;
export const LONG_POLL_CAP_MS = 50_000;               // keep each HTTP request short enough for tunnels/proxies

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(String(s), 'base64url');
export const randomId = (prefix, bytes = 6) => `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;

// ---------- pairing code ----------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 Crockford-base32 chars (~50 bits), shown as XXXXX-XXXXX. Single use, short-lived. */
export function newPairingCode() {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += CROCKFORD[b & 31]; // 256 % 32 === 0, so no modulo bias
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Tolerate lowercase, missing dash, and the usual O/0 I/L/1 confusions when the code is typed by hand. */
export function normalizeCode(code) {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Proves knowledge of the pairing code without sending it. */
export function pairProof(code, label) {
  return crypto.createHmac('sha256', normalizeCode(code)).update(label).digest('base64url');
}

export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ---------- key exchange (X25519 + HKDF) ----------
export function genKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, pub: b64u(publicKey.export({ type: 'spki', format: 'der' })) };
}

/**
 * Session key = HKDF(ECDH(shared), salt = pairing code, info = both public keys + peer id).
 * The key itself never crosses the wire, so sniffing the pairing exchange on plain-HTTP LAN does not reveal it.
 */
export function deriveSessionKey(privateKey, peerPub, code, transcript) {
  const publicKey = crypto.createPublicKey({ key: fromB64u(peerPub), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  const key = crypto.hkdfSync('sha256', shared, Buffer.from(normalizeCode(code)), Buffer.from(`${PROTOCOL}|session|${transcript}`), 32);
  return Buffer.from(key);
}

// ---------- authenticated encryption (AES-256-GCM) ----------
export function seal(key, obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return { iv: b64u(iv), ct: b64u(ct), tag: b64u(c.getAuthTag()) };
}

/** Throws if the box was tampered with, encrypted with another key, or bound to different AAD. */
export function open(key, box, aad) {
  if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string' || typeof box.tag !== 'string') {
    throw new Error('malformed box');
  }
  const d = crypto.createDecipheriv('aes-256-gcm', key, fromB64u(box.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(fromB64u(box.tag));
  const pt = Buffer.concat([d.update(fromB64u(box.ct)), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// The AAD binds each request to its route, sender, time and nonce, so a captured request cannot be
// replayed elsewhere; the response is bound to the request nonce, so it cannot be swapped either.
export const requestAad = (method, route, peerId, ts, nonce) => `${PROTOCOL}|req|${method}|${route}|${peerId}|${ts}|${nonce}`;
export const responseAad = (nonce) => `${PROTOCOL}|resp|${nonce}`;

// ---------- files ----------
export function resolveStateDir(explicit) {
  return path.resolve(explicit || process.env.AGENT_BRIDGE_DIR || '.agent-bridge');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const gi = path.join(dir, '.gitignore');
  // The state dir holds session keys; never let it be committed by accident.
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic write; mode 0600 where the OS supports it (Windows ignores mode). */
export function writeJsonPrivate(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Keep only safe characters so a peer-supplied attachment name cannot escape the inbox folder. */
export function safeFileName(name, fallback = 'file') {
  const base = path.basename(String(name || '')).replace(/[^\w.\- ]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || fallback;
}

export const MESSAGE_TYPE_RE = /^[a-z][a-z0-9_]{0,39}$/;

// ---------- shared case files ----------
// A case file is one Markdown document per investigation or test sweep, stored on the relay with every version
// kept. Both agents read and edit it; messages only ring the doorbell (`case_updated`) and say what is asked.
export const CASE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_CASE_BYTES = 256 * 1024;

/**
 * Compact line diff from `a` to `b`: changed lines only, prefixed "- " / "+ ", with "@@ line N" markers.
 * Returns { lines, added, removed, truncated }. Common prefix/suffix are trimmed first; a middle too large for
 * an LCS table falls back to "all removed, all added".
 */
export function lineDiff(a, b, maxLines = 80) {
  const A = String(a ?? '').replace(/\r\n/g, '\n').split('\n');
  const B = String(b ?? '').replace(/\r\n/g, '\n').split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const x = A.slice(pre, A.length - suf);
  const y = B.slice(pre, B.length - suf);
  const ops = []; // [kind, text, lineInB]
  if (x.length * y.length > 4_000_000) {
    x.forEach((t) => ops.push(['-', t, pre + 1]));
    y.forEach((t, j) => ops.push(['+', t, pre + j + 1]));
  } else {
    const n = x.length;
    const m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) { i++; j++; ops.push(['=', null, pre + j]); }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { ops.push(['-', x[i], pre + j + 1]); i++; }
      else { ops.push(['+', y[j], pre + j + 1]); j++; }
    }
  }
  const lines = [];
  let added = 0;
  let removed = 0;
  let prevChanged = false;
  for (const [kind, text, at] of ops) {
    if (kind === '=') { prevChanged = false; continue; }
    if (kind === '+') added++; else removed++;
    if (!prevChanged) lines.push(`@@ line ${at}`);
    lines.push(`${kind} ${text}`);
    prevChanged = true;
  }
  const truncated = lines.length > maxLines;
  return { lines: truncated ? lines.slice(0, maxLines) : lines, added, removed, truncated };
}
