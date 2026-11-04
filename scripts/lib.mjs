// Shared helpers for agent-bridge: pairing, key exchange, authenticated encryption, files.
// Node >= 18, no external dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROTOCOL = 'agent-bridge/1';
// Skill/CLI release. The wire protocol above stays compatible; this tells peers which instructions the other side has.
export const SKILL_VERSION = '1.1.0';

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
