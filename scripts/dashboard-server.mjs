#!/usr/bin/env node
// Local, read-only web view of an agent-bridge conversation. Started by `bridge.mjs dashboard`.
//
//   node dashboard-server.mjs --dir <state dir> --port 7879 --token <random>
//
// Security model:
// - Binds to 127.0.0.1 only, on its own port, so the ngrok tunnel (which forwards to the relay port) never
//   reaches it.
// - Every request needs the random token. The Host header must be loopback, which blocks DNS rebinding.
// - The page is read-only. Peer content is rendered with textContent only, under a strict CSP with a per-start
//   nonce, so a message cannot run script in the viewer's browser.
// - Session keys never leave the state files: peers and session are stripped before they are sent.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SKILL_VERSION, resolveStateDir, readJson, writeJsonPrivate, safeEqual, safeFileName, appendJsonl } from './lib.mjs';
import { buildReport } from './report.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
const DIR = resolveStateDir(args.dir);
const PORT = Number(args.port || 7879);
const TOKEN = String(args.token || '');
if (TOKEN.length < 16) {
  console.error('dashboard: --token (16+ chars) is required');
  process.exit(1);
}
const F = {
  serverLog: path.join(DIR, 'server-messages.jsonl'), // host: everything that went through the relay
  localLog: path.join(DIR, 'messages.jsonl'), //         any side: what this machine sent and received
  session: path.join(DIR, 'session.json'),
  state: path.join(DIR, 'server-state.json'),
  inbox: path.join(DIR, 'inbox'),
  info: path.join(DIR, 'dashboard.json'),
  approvals: path.join(DIR, 'approvals.json'),
  notes: path.join(DIR, 'notes.jsonl'),
  relayCases: path.join(DIR, 'relay-cases'), // host: the authoritative store, every version
  cases: path.join(DIR, 'cases'), //            any side: the copies this machine fetched or shared
};
const PAGE = fs.readFileSync(fileURLToPath(new URL('./dashboard.html', import.meta.url)), 'utf8');

// ---------- data ----------
function readLines(file, from = 0) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= from) { fs.closeSync(fd); return { items: [], size }; }
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    // Only consume complete lines; a line still being written is picked up next time.
    const end = text.lastIndexOf('\n') + 1;
    const items = text.slice(0, end).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { items, size: from + Buffer.byteLength(text.slice(0, end)) };
  } catch {
    return { items: [], size: from };
  }
}

function inboxFiles(id) {
  const dir = path.join(F.inbox, String(id).replace(/[^\w]/g, ''));
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Shape one log line for the page: no key material, attachments resolved to local files when we have them. */
function present(m) {
  const files = inboxFiles(m.id);
  return {
    id: m.id, seq: m.seq ?? null, ts: m.ts ?? m.logged_at ?? null, direction: m.direction ?? null,
    from: m.from ? { id: m.from.id, role: m.from.role, name: m.from.name } : null,
    to: m.to ?? null, type: m.type, thread_id: m.thread_id ?? null, reply_to: m.reply_to ?? null,
    body: m.body ?? null,
    attachments: (m.attachments || []).map((a, k) => {
      const stored = files.find((f) => f.startsWith(`${k}-`));
      return { name: a.name, mime: a.mime, size: a.size, file: stored ? `${m.id.replace(/[^\w]/g, '')}/${stored}` : null };
    }),
  };
}

const sources = () => (fs.existsSync(F.serverLog) ? [F.serverLog, F.localLog] : [F.localLog]);
const offsets = new Map();
const seen = new Set();

function collect() {
  const out = [];
  for (const file of sources()) {
    const { items, size } = readLines(file, offsets.get(file) || 0);
    offsets.set(file, size);
    for (const m of items) {
      if (!m.id || seen.has(m.id)) continue; // the host's two logs overlap
      seen.add(m.id);
      out.push(present(m));
    }
  }
  return out;
}

function peers() {
  const sess = readJson(F.session) || {};
  const me = sess.peer_id ? { id: sess.peer_id, role: sess.role, name: sess.name, is_host: !!sess.is_host } : null;
  const st = readJson(F.state);
  let list = [];
  if (st?.peers) {
    list = Object.values(st.peers).map((p) => ({
      id: p.id, role: p.role, name: p.name, version: p.version ?? null, is_host: !!p.is_host,
      online: p.is_host || (p.last_seen && Date.now() - p.last_seen < 90_000),
    }));
  } else if (sess.host) {
    list = [{ ...sess.host, key: undefined }, me && { ...me, version: SKILL_VERSION, online: true }].filter(Boolean);
  }
  return { me, peers: list, open: !!sess.peer_id };
}

let all = collect();

/** Case files at their latest known version. Contents are peer data and are rendered as text only. */
function cases() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const list = [];
  try {
    for (const slug of fs.readdirSync(F.relayCases)) {
      const meta = readJson(path.join(F.relayCases, slug, 'meta.json'));
      const content = meta && read(path.join(F.relayCases, slug, `v${meta.version}.md`));
      if (content != null) list.push({ slug, title: meta.title, version: meta.version, updated: meta.history.at(-1) ?? null, content });
    }
  } catch {}
  if (list.length) return list;
  try {
    for (const f of fs.readdirSync(F.cases)) {
      const m = f.match(/^([a-z0-9][a-z0-9-]*).json$/);
      const meta = m && readJson(path.join(F.cases, f));
      const content = meta?.version ? read(path.join(F.cases, `${m[1]}.base.md`)) : null;
      if (content != null) list.push({ slug: m[1], title: meta.title, version: meta.version, updated: null, content });
    }
  } catch {}
  return list;
}

const approvals = () => Object.values(readJson(F.approvals, {}) || {}).sort((a, b) => String(b.requested_at).localeCompare(String(a.requested_at)));
const notes = () => { try { return fs.readFileSync(F.notes, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

// ---------- http ----------
const loopbackHost = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`);
const clients = new Set();

function deny(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (!loopbackHost.test(String(req.headers.host || ''))) return deny(res, 403, 'forbidden host');
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!safeEqual(url.searchParams.get('t') || '', TOKEN)) return deny(res, 401, 'missing or wrong token: open the exact URL that `bridge dashboard` printed');
  const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };

  if (url.pathname === '/') {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, {
      ...common,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    return res.end(PAGE.replaceAll('__NONCE__', nonce));
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { ...common, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ version: SKILL_VERSION, dir: path.basename(path.dirname(DIR)), ...peers(), messages: all, approvals: approvals(), notes: notes(), cases: cases() }));
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { ...common, 'content-type': 'text/event-stream', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/report' && req.method === 'GET') {
    const thread = url.searchParams.get('thread') || null;
    const md = buildReport(all, { thread, version: SKILL_VERSION, cases: cases() });
    const name = `agent-bridge-report-${safeFileName(thread || 'all-threads')}.md`;
    res.writeHead(200, { ...common, 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
    return res.end(md);
  }
  if (req.method === 'POST') {
    // Writes need the token in a custom header as well: browsers won't add it to a cross-site request
    // without a CORS preflight, which this server never approves, so other sites can't act for the user.
    if (!safeEqual(String(req.headers['x-ab-token'] || ''), TOKEN)) return deny(res, 403, 'missing x-ab-token header');
    const ap = url.pathname.match(/^\/api\/approvals\/([\w-]{1,32})$/);
    if (ap) {
      return readBody(req).then((b) => {
        const list = readJson(F.approvals, {}) || {};
        const a = list[ap[1]];
        if (!a) return deny(res, 404, 'no such approval');
        if (a.status !== 'pending') return deny(res, 409, `already ${a.status}`);
        if (!['approve', 'decline'].includes(b.decision)) return deny(res, 400, 'decision must be approve or decline');
        Object.assign(a, { status: b.decision === 'approve' ? 'approved' : 'declined', comment: b.comment ? String(b.comment).slice(0, 2000) : null, decided_at: new Date().toISOString(), decided_via: 'dashboard' });
        writeJsonPrivate(F.approvals, list);
        res.writeHead(200, { ...common, 'content-type': 'application/json' });
        res.end(JSON.stringify(a));
      }).catch((e) => deny(res, 400, e.message));
    }
    if (url.pathname === '/api/notes') {
      return readBody(req).then((b) => {
        const text = String(b.text || '').trim().slice(0, 4000);
        if (!text) return deny(res, 400, 'empty note');
        const note = { id: `note_${crypto.randomBytes(5).toString('hex')}`, ts: new Date().toISOString(), text };
        appendJsonl(F.notes, note);
        res.writeHead(200, { ...common, 'content-type': 'application/json' });
        res.end(JSON.stringify(note));
      }).catch((e) => deny(res, 400, e.message));
    }
    return deny(res, 404, 'not found');
  }
  const fm = url.pathname.match(/^\/files\/([\w]+)\/([^/]+)$/);
  if (fm) {
    const name = safeFileName(decodeURIComponent(fm[2]));
    const file = path.join(F.inbox, fm[1], name);
    if (!file.startsWith(F.inbox + path.sep) || !fs.existsSync(file)) return deny(res, 404, 'not found');
    const ext = path.extname(name).toLowerCase();
    // Only well-known image types are shown inline; everything else downloads as an opaque file.
    const inline = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    res.writeHead(200, {
      ...common,
      'content-type': inline || 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/"/g, '')}"`,
      'content-security-policy': "default-src 'none'; sandbox",
    });
    return fs.createReadStream(file).pipe(res);
  }
  return deny(res, 404, 'not found');
});

// Push new messages and peer changes to open pages.
let lastPeers = '';
let lastApprovals = '';
let lastNotes = -1;
let lastCases = '';
setInterval(() => {
  const fresh = collect();
  if (fresh.length) all = all.concat(fresh);
  const p = JSON.stringify(peers());
  const ap = JSON.stringify(approvals());
  const ns = notes();
  const cs = cases();
  const csSig = JSON.stringify(cs.map((c) => [c.slug, c.version]));
  for (const c of clients) {
    if (csSig !== lastCases) c.write(`event: cases
data: ${JSON.stringify(cs)}

`);
    if (fresh.length) c.write(`event: messages\ndata: ${JSON.stringify(fresh)}\n\n`);
    if (p !== lastPeers) c.write(`event: peers\ndata: ${p}\n\n`);
    if (ap !== lastApprovals) c.write(`event: approvals\ndata: ${ap}\n\n`);
    if (ns.length !== lastNotes) c.write(`event: notes\ndata: ${JSON.stringify(ns)}\n\n`);
    c.write(': ping\n\n');
  }
  lastPeers = p;
  lastApprovals = ap;
  lastNotes = ns.length;
  lastCases = csSig;
}, 1000).unref();

function shutdown() {
  try { if (readJson(F.info)?.pid === process.pid) fs.rmSync(F.info, { force: true }); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', (e) => {
  writeJsonPrivate(F.info, { pid: process.pid, error: e.message });
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  writeJsonPrivate(F.info, { pid: process.pid, port: PORT, url: `http://127.0.0.1:${PORT}/?t=${TOKEN}`, started_at: new Date().toISOString() });
});
