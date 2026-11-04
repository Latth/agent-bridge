#!/usr/bin/env node
// agent-bridge relay server. Started by `bridge.mjs host`; not meant to be run by hand.
//
//   node bridge-server.mjs --dir <state dir> --port 7878 --bind 127.0.0.1 --role backend [--name "B-E Agent"]
//
// Every route except /health and /pair requires an AES-GCM box sealed with the peer's session key.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {
  PROTOCOL, SKILL_VERSION, DEFAULT_PORT, MAX_BODY_BYTES, MAX_ATTACHMENT_BYTES, CLOCK_SKEW_MS, CODE_TTL_MS, MAX_PAIR_FAILURES,
  LONG_POLL_CAP_MS, MESSAGE_TYPE_RE, b64u, fromB64u, randomId, newPairingCode, normalizeCode, pairProof, safeEqual,
  genKeyPair, deriveSessionKey, seal, open, requestAad, responseAad, resolveStateDir, ensureDir, readJson,
  writeJsonPrivate, appendJsonl, CASE_SLUG_RE, MAX_CASE_BYTES,
} from './lib.mjs';
import crypto from 'node:crypto';

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args[k] = v ?? process.argv[++i];
  }
}
const DIR = resolveStateDir(args.dir);
const PORT = Number(args.port || DEFAULT_PORT);
const BIND = args.bind || '127.0.0.1';
const ROLE = args.role || 'host';
const NAME = args.name || ROLE;

ensureDir(DIR);
const STATE_FILE = path.join(DIR, 'server-state.json');
const SERVER_FILE = path.join(DIR, 'server.json');
const SESSION_FILE = path.join(DIR, 'session.json');
const MSG_LOG = path.join(DIR, 'server-messages.jsonl');

// ---------- state ----------
// peers: id -> { id, role, name, key(b64u), is_host, joined_at, last_seen }
let state = readJson(STATE_FILE);
if (!state || state.protocol !== PROTOCOL) {
  const hostId = randomId('peer');
  state = {
    protocol: PROTOCOL,
    seq: 0,
    peers: { [hostId]: { id: hostId, role: ROLE, name: NAME, key: b64u(crypto.randomBytes(32)), is_host: true, joined_at: new Date().toISOString() } },
  };
}
const hostPeer = Object.values(state.peers).find((p) => p.is_host);
hostPeer.role = ROLE; // allow the host to restart with a corrected role/name
hostPeer.name = NAME;
hostPeer.version = SKILL_VERSION;
// Versions come from peers; keep them short and printable so they can't smuggle text into other agents' output.
const cleanVersion = (v) => (/^[0-9][0-9A-Za-z.+-]{0,19}$/.test(String(v ?? '')) ? String(v) : null);
const saveState = () => writeJsonPrivate(STATE_FILE, state);
saveState();

let pairing = null; // { code, expires_at, failures }
function rotateCode() {
  pairing = { code: newPairingCode(), expires_at: Date.now() + CODE_TTL_MS, failures: 0 };
  writeServerFile();
  return pairing;
}

function writeServerFile(extra = {}) {
  const prev = readJson(SERVER_FILE, {});
  writeJsonPrivate(SERVER_FILE, {
    ...prev,
    protocol: PROTOCOL,
    pid: process.pid,
    port: PORT,
    bind: BIND,
    started_at: prev.pid === process.pid ? prev.started_at : new Date().toISOString(),
    pairing_code: pairing?.code ?? null,
    pairing_expires_at: pairing ? new Date(pairing.expires_at).toISOString() : null,
    ...extra,
  });
}

// The host's own CLI talks to this server like any other peer, through this local session file.
const prevSession = readJson(SESSION_FILE, {}) ?? {};
function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
writeJsonPrivate(SESSION_FILE, {
  protocol: PROTOCOL,
  server: `http://127.0.0.1:${PORT}`,
  peer_id: hostPeer.id,
  key: hostPeer.key,
  role: hostPeer.role,
  name: hostPeer.name,
  is_host: true,
  clock_offset_ms: 0,
  // Keep the host's read position across server restarts; a fresh host starts at the current end.
  cursor: prevSession.peer_id === hostPeer.id && Number.isFinite(prevSession.cursor) ? prevSession.cursor : state.seq,
  // Dashboard notes already delivered stay delivered; a new bridge starts after the existing ones.
  note_cursor: prevSession.peer_id === hostPeer.id && Number.isFinite(prevSession.note_cursor) ? prevSession.note_cursor : countLines(path.join(DIR, 'notes.jsonl')),
});

const messages = []; // in-memory queue (most recent MAX_KEEP)
const MAX_KEEP = 1000;
const waiters = new Set(); // { peer, after, resolve, timer }
const seenNonces = new Map(); // nonce -> expires_at
const buckets = new Map(); // rate limiting: key -> { tokens, at }

function rateLimited(key, capacity, refillPerSec) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

const publicPeer = (p) => ({
  id: p.id, role: p.role, name: p.name, is_host: !!p.is_host, version: p.version ?? null,
  online: p.is_host || (p.last_seen && Date.now() - p.last_seen < 90_000),
});

function isFor(msg, peer) {
  if (msg.from.id === peer.id) return false;
  return msg.to === '*' || msg.to === peer.id || msg.to === peer.role;
}

function pending(peer, after) {
  return messages.filter((m) => m.seq > after && isFor(m, peer));
}

function post(from, { to = '*', type, thread_id = null, reply_to = null, body = null, attachments = [] }) {
  const msg = {
    protocol: PROTOCOL,
    id: randomId('msg'),
    seq: ++state.seq,
    ts: new Date().toISOString(),
    from: { id: from.id, role: from.role, name: from.name },
    to,
    type,
    thread_id,
    reply_to,
    body,
    attachments,
  };
  messages.push(msg);
  if (messages.length > MAX_KEEP) messages.splice(0, messages.length - MAX_KEEP);
  saveState();
  appendJsonl(MSG_LOG, { ...msg, attachments: attachments.map(({ name, mime, size }) => ({ name, mime, size })) });
  for (const w of [...waiters]) {
    if (isFor(msg, w.peer) && msg.seq > w.after) w.resolve(pending(w.peer, w.after));
  }
  return msg;
}

const systemSender = { id: 'bridge', role: 'bridge', name: 'agent-bridge' };

// ---------- shared case files ----------
// relay-cases/<slug>/meta.json + v<N>.md. Every version is kept, so nobody's edit is ever lost, and a put must
// name the version it was based on: a stale base is refused (409) and the writer merges the newer version first.
const CASES_DIR = path.join(DIR, 'relay-cases');
const caseDir = (slug) => path.join(CASES_DIR, slug);
const caseMeta = (slug) => readJson(path.join(caseDir(slug), 'meta.json'));
const cleanLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

function checkSlug(slug) {
  if (!CASE_SLUG_RE.test(String(slug))) throw new HttpError(400, 'case name must be lowercase letters, digits and dashes, e.g. "order-total-zero"');
  return String(slug);
}

function caseVersion(slug, v) {
  const meta = caseMeta(slug);
  if (!meta) throw new HttpError(404, `no case "${slug}" (create it with \`case new\` and \`case put\`)`);
  const n = v == null ? meta.version : Number(v);
  const entry = meta.history.find((h) => h.version === n);
  if (!entry) throw new HttpError(404, `case "${slug}" has no version ${v} (latest is ${meta.version})`);
  return { meta, entry, content: fs.readFileSync(path.join(caseDir(slug), `v${n}.md`), 'utf8') };
}

function putCase(peer, { slug, title, content, base = 0, note = '', ask = '', to = '*', thread_id = null }) {
  slug = checkSlug(slug);
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'case content is empty');
  if (Buffer.byteLength(content) > MAX_CASE_BYTES) throw new HttpError(413, `case file over ${MAX_CASE_BYTES / 1024} KB; move evidence into message attachments and link them`);
  const meta = caseMeta(slug) ?? { slug, title: null, version: 0, created_at: new Date().toISOString(), history: [] };
  if (Number(base) !== meta.version) {
    const last = meta.history.at(-1);
    throw new HttpError(409, `stale: case "${slug}" is at v${meta.version}${last ? ` (by ${last.by.role}: ${last.note || 'no note'})` : ''}, your edit is based on v${Number(base)}. Run \`case get ${slug}\`, merge your changes into it, and put again.`);
  }
  const version = meta.version + 1;
  fs.mkdirSync(caseDir(slug), { recursive: true });
  fs.writeFileSync(path.join(caseDir(slug), `v${version}.md`), content, { mode: 0o600 });
  meta.version = version;
  meta.title = cleanLine(title, 120) || meta.title || slug;
  meta.history.push({ version, ts: new Date().toISOString(), by: { id: peer.id, role: peer.role, name: peer.name }, note: cleanLine(note, 300), ask: cleanLine(ask, 600), chars: content.length });
  writeJsonPrivate(path.join(caseDir(slug), 'meta.json'), meta);
  // The doorbell: a normal message, so the other agents' `wait` wakes up and the update shows in every log.
  const body = { case: slug, version, title: meta.title };
  if (meta.history.at(-1).note) body.note = meta.history.at(-1).note;
  if (meta.history.at(-1).ask) body.ask = meta.history.at(-1).ask;
  const msg = post(peer, { to, type: 'case_updated', thread_id, body });
  return { slug, version, title: meta.title, id: msg.id, recipients: Object.values(state.peers).filter((p) => isFor(msg, p)).map((p) => p.id) };
}

// ---------- http helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function clientIp(req) {
  // Behind ngrok every request comes from loopback, so use the forwarded address there. A LAN client
  // could forge X-Forwarded-For, so it is only trusted when the socket itself is loopback.
  const remote = req.socket.remoteAddress || '?';
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  return loopback && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : remote;
}

// ---------- routes ----------
async function handlePair(req, res) {
  if (rateLimited(`pair:${clientIp(req)}`, 10, 10 / 60)) throw new HttpError(429, 'too many pairing attempts');
  const input = JSON.parse(await readBody(req) || '{}');
  if (input.protocol !== PROTOCOL) throw new HttpError(400, `protocol mismatch (server speaks ${PROTOCOL})`);
  const role = String(input.role || '').trim();
  const name = String(input.name || role).trim().slice(0, 60);
  if (!/^[a-z][a-z0-9_-]{0,29}$/.test(role)) throw new HttpError(400, 'role must be lowercase letters/digits, e.g. "mobile"');
  if (role === 'bridge') throw new HttpError(400, 'role "bridge" is reserved');
  if (typeof input.client_pub !== 'string' || typeof input.proof !== 'string') throw new HttpError(400, 'missing client_pub/proof');

  // Same generic error for "no code", "expired" and "wrong code" so the endpoint leaks nothing.
  const fail = () => {
    if (pairing) {
      pairing.failures++;
      if (pairing.failures >= MAX_PAIR_FAILURES) { pairing = null; writeServerFile(); log(`pairing code burned after ${MAX_PAIR_FAILURES} failed attempts`); }
    }
    throw new HttpError(401, 'pairing failed: code invalid, expired or already used (ask the host to run `bridge code`)');
  };
  if (!pairing || Date.now() > pairing.expires_at) fail();
  if (!safeEqual(input.proof, pairProof(pairing.code, `pair|${input.client_pub}`))) fail();

  const code = pairing.code;
  pairing = null; // single use
  writeServerFile();

  const peerId = randomId('peer');
  const kp = genKeyPair();
  const transcript = `${input.client_pub}|${kp.pub}|${peerId}`;
  let key;
  try { key = deriveSessionKey(kp.privateKey, input.client_pub, code, transcript); } catch { throw new HttpError(400, 'bad client_pub'); }

  const peer = { id: peerId, role, name, version: cleanVersion(input.client_version), key: b64u(key), is_host: false, joined_at: new Date().toISOString(), last_seen: Date.now() };
  state.peers[peerId] = peer;
  saveState();
  log(`peer joined: ${name} (${role}) ${peerId}`);
  post(systemSender, { to: '*', type: 'peer_joined', body: { peer: publicPeer(peer) } });

  send(res, 200, {
    protocol: PROTOCOL,
    peer_id: peerId,
    server_pub: kp.pub,
    proof: pairProof(code, `pair-ok|${transcript}`),
    host: publicPeer(hostPeer),
    seq: state.seq, // the new peer starts reading after its own join notice
    time: Date.now(),
  });
}

async function handleRpc(req, res, op) {
  const peerId = String(req.headers['x-ab-peer'] || '');
  const ts = Number(req.headers['x-ab-ts']);
  const nonce = String(req.headers['x-ab-nonce'] || '');
  const peer = state.peers[peerId];
  if (!peer) throw new HttpError(401, 'unknown peer (session revoked? run connect again)');
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) throw new HttpError(401, `clock skew too large; server time ${Date.now()}`);
  if (!/^[\w-]{16,64}$/.test(nonce)) throw new HttpError(400, 'bad nonce');
  if (rateLimited(`rpc:${peerId}`, 40, 4)) throw new HttpError(429, 'rate limited');

  const raw = await readBody(req);
  const route = `/rpc/${op}`;
  let payload;
  try {
    payload = open(fromB64u(peer.key), JSON.parse(raw), requestAad('POST', route, peerId, ts, nonce));
  } catch {
    throw new HttpError(401, 'authentication failed');
  }
  // Only remember nonces of authentic requests, otherwise anyone could fill the table.
  if (seenNonces.has(nonce)) throw new HttpError(401, 'replayed request');
  seenNonces.set(nonce, Date.now() + 2 * CLOCK_SKEW_MS);

  peer.last_seen = Date.now();
  const v = cleanVersion(req.headers['x-ab-version']);
  if (v && v !== peer.version) { peer.version = v; saveState(); }
  const reply = (obj) => send(res, 200, seal(fromB64u(peer.key), obj, responseAad(nonce)));

  switch (op) {
    case 'send': {
      const { to = '*', type, thread_id = null, reply_to = null, body = null, attachments = [] } = payload;
      if (!MESSAGE_TYPE_RE.test(String(type))) throw new HttpError(400, 'type must be snake_case, e.g. "test_scenarios"');
      const peers = Object.values(state.peers).filter((p) => p.id !== peer.id);
      if (to !== '*' && !peers.some((p) => p.id === to || p.role === to)) {
        throw new HttpError(400, `unknown recipient "${to}"; known: ${peers.map((p) => `${p.role}(${p.id})`).join(', ') || 'nobody connected yet'}`);
      }
      if (!Array.isArray(attachments)) throw new HttpError(400, 'attachments must be an array');
      let total = 0;
      const clean = attachments.map((a) => {
        const data = fromB64u(a.data_b64 || '');
        total += data.length;
        return { name: String(a.name || 'file').slice(0, 120), mime: String(a.mime || 'application/octet-stream').slice(0, 80), size: data.length, data_b64: b64u(data) };
      });
      if (total > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `attachments exceed ${MAX_ATTACHMENT_BYTES} bytes`);
      const msg = post(peer, { to, type, thread_id, reply_to, body, attachments: clean });
      const recipients = Object.values(state.peers).filter((p) => isFor(msg, p)).map((p) => p.id);
      return reply({ id: msg.id, seq: msg.seq, recipients });
    }
    case 'recv': {
      const after = Number(payload.after ?? 0);
      const wait = Math.max(0, Math.min(Number(payload.timeout_ms ?? 0), LONG_POLL_CAP_MS));
      // A cursor ahead of the server means the server state was reset; tell the client to resync.
      if (after > state.seq) return reply({ messages: [], seq: state.seq, reset: true });
      const now = pending(peer, after);
      if (now.length || wait === 0) return reply({ messages: now, seq: state.seq });
      const result = await new Promise((resolve) => {
        const w = { peer, after, resolve: null, timer: null };
        const done = (msgs) => { clearTimeout(w.timer); waiters.delete(w); resolve(msgs); };
        w.resolve = done;
        w.timer = setTimeout(() => done([]), wait);
        waiters.add(w);
        req.on('close', () => { if (!res.writableEnded) done([]); });
      });
      if (res.destroyed) return;
      return reply({ messages: result, seq: state.seq });
    }
    case 'case_put': {
      const to = payload.to ?? '*';
      const peers = Object.values(state.peers).filter((p) => p.id !== peer.id);
      if (to !== '*' && !peers.some((p) => p.id === to || p.role === to)) throw new HttpError(400, `unknown recipient "${to}"`);
      return reply(putCase(peer, { ...payload, to }));
    }
    case 'case_get': {
      const slug = checkSlug(payload.slug);
      const { meta, entry, content } = caseVersion(slug, payload.version);
      return reply({ slug, title: meta.title, latest: meta.version, version: entry.version, entry, content, history: meta.history });
    }
    case 'case_list': {
      let slugs = [];
      try { slugs = fs.readdirSync(CASES_DIR); } catch {}
      const cases = slugs.map(caseMeta).filter(Boolean).map((m) => ({ slug: m.slug, title: m.title, version: m.version, updated: m.history.at(-1) }));
      return reply({ cases });
    }
    case 'peers':
      return reply({ me: publicPeer(peer), peers: Object.values(state.peers).map(publicPeer), seq: state.seq });
    case 'new_code': {
      if (!peer.is_host) throw new HttpError(403, 'only the host can issue pairing codes');
      const p = rotateCode();
      return reply({ code: p.code, expires_at: new Date(p.expires_at).toISOString() });
    }
    case 'kick': {
      if (!peer.is_host) throw new HttpError(403, 'only the host can remove peers');
      const target = state.peers[payload.peer_id];
      if (!target || target.is_host) throw new HttpError(400, 'no such peer');
      delete state.peers[target.id];
      saveState();
      post(systemSender, { to: '*', type: 'peer_left', body: { peer: publicPeer(target), reason: 'removed by host' } });
      return reply({ ok: true });
    }
    case 'leave': {
      if (peer.is_host) throw new HttpError(400, 'host cannot leave; use shutdown');
      delete state.peers[peer.id];
      saveState();
      post(systemSender, { to: '*', type: 'peer_left', body: { peer: publicPeer(peer), reason: 'left' } });
      return reply({ ok: true });
    }
    case 'shutdown': {
      if (!peer.is_host) throw new HttpError(403, 'only the host can shut down the bridge');
      reply({ ok: true });
      setTimeout(() => shutdown('shutdown requested by host'), 100);
      return;
    }
    default:
      throw new HttpError(404, 'unknown op');
  }
}

function log(line) {
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, protocol: PROTOCOL, version: SKILL_VERSION, time: Date.now() });
    if (req.method === 'POST' && url.pathname === '/pair') return await handlePair(req, res);
    const m = url.pathname.match(/^\/rpc\/([a-z_]+)$/);
    if (req.method === 'POST' && m) return await handleRpc(req, res, m[1]);
    throw new HttpError(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
    if (status === 500) log(`error: ${e.stack || e}`);
    if (!res.headersSent && !res.destroyed) send(res, status, { error: status === 500 ? 'internal error' : e.message });
  }
});
server.requestTimeout = LONG_POLL_CAP_MS + 15_000;
server.headersTimeout = 20_000;

setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (pairing && now > pairing.expires_at) { pairing = null; writeServerFile(); }
}, 30_000).unref();

function shutdown(reason) {
  log(`shutting down: ${reason}`);
  for (const w of [...waiters]) w.resolve([]);
  server.close();
  try { fs.rmSync(SERVER_FILE, { force: true }); } catch {}
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', (e) => {
  log(`listen error: ${e.message}`);
  writeServerFile({ error: e.message });
  process.exit(1);
});
server.listen(PORT, BIND, () => {
  rotateCode();
  log(`agent-bridge listening on ${BIND}:${PORT} as ${NAME} (${ROLE}), state dir ${DIR}`);
});
