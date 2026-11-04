#!/usr/bin/env node
// Scripted peer for skill tests. It hosts a local relay, waits for the agent under test to connect,
// sends the scripted messages, and records everything the agent sends back.
//
//   node fake-peer.mjs --bridge <path to bridge.mjs> --dir <state dir> --port <port>
//                      --script <peer-script.json> --info <info.json> --out <transcript.json> [--timeout 1500]
//
// peer-script.json:
//   { "role": "mobile", "name": "Mobile Agent (test peer)", "thread": "login-v2",
//     "on_join": [ { "type": "hello", "body": {...} }, { "type": "data_request", "body": {...} } ],
//     "stop_on_types": ["data_response", "declined"], "grace_seconds": 45 }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const script = JSON.parse(fs.readFileSync(a.script, 'utf8'));
const deadline = Date.now() + Number(a.timeout || 1500) * 1000;
fs.mkdirSync(a.dir, { recursive: true });

function cli(...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [a.bridge, ...args, '--dir', a.dir, '--json'], { cwd: a.dir });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code, json, stdout, stderr });
    });
  });
}

const transcript = { peer_role: script.role, started_at: new Date().toISOString(), sent: [], received: [], events: [] };
const save = () => fs.writeFileSync(a.out, JSON.stringify(transcript, null, 2));

const host = await cli('host', '--role', script.role, '--name', script.name || `${script.role} (test peer)`, '--ngrok', 'false', '--port', String(a.port));
if (host.code !== 0) {
  fs.writeFileSync(a.info, JSON.stringify({ error: host.stderr || host.stdout }));
  process.exit(1);
}
// Self-check before anyone joins: prove this peer can actually send (body file + CLI), so a broken
// harness shows up here instead of as an agent "waiting for a request that never comes".
// Nobody receives it: the agent's read position starts after its own join.
const probe = path.join(a.dir, 'probe.json');
fs.writeFileSync(probe, '{"ok":true}');
const check = await cli('send', '--type', 'harness_check', '--body-file', probe);
if (check.code !== 0) {
  fs.writeFileSync(a.info, JSON.stringify({ error: `self-check send failed: ${check.stderr || check.stdout}` }));
  await cli('close');
  process.exit(1);
}
fs.writeFileSync(a.info, JSON.stringify({ address: `127.0.0.1:${a.port}`, code: host.json.pairing_code, pid: process.pid }));
transcript.events.push({ at: new Date().toISOString(), event: 'hosting', code: host.json.pairing_code });
save();

async function send(step) {
  const f = path.join(a.dir, `out-${transcript.sent.length}.json`);
  fs.writeFileSync(f, JSON.stringify(step.body ?? null));
  const args = ['send', '--type', step.type, '--to', step.to || '*', '--thread', step.thread || script.thread, '--body-file', f];
  if (step.reply_to) args.push('--reply-to', step.reply_to);
  const r = await cli(...args);
  transcript.sent.push({ ...step, id: r.json?.id ?? null, recipients: r.json?.recipients?.length ?? 0, error: r.code === 0 ? null : r.stderr });
  save();
}

let joined = false;
let stopAt = null;
const fired = new Set();
while (Date.now() < deadline && !(stopAt && Date.now() > stopAt)) {
  const r = await cli('wait', '--timeout', '20');
  for (const m of r.json?.messages ?? []) {
    transcript.received.push(m);
    if (m.type === 'peer_joined' && !joined) {
      joined = true;
      transcript.events.push({ at: new Date().toISOString(), event: 'agent_joined', peer: m.body.peer });
      for (const step of script.on_join || []) await send(step);
    }
    // on_message: { "<type>": [steps] } answers the agent's first message of that type (once per type).
    const reaction = script.on_message?.[m.type];
    if (reaction && !fired.has(m.type) && m.from?.id !== 'bridge') {
      fired.add(m.type);
      for (const step of reaction) await send({ ...step, reply_to: m.id });
      transcript.events.push({ at: new Date().toISOString(), event: 'reacted', to_type: m.type, sent: reaction.map((s) => s.type) });
      if (script.stop_after_reaction && !stopAt) {
        stopAt = Date.now() + (script.grace_seconds ?? 45) * 1000; // watch whether the agent replies to our closing messages
        transcript.events.push({ at: new Date().toISOString(), event: 'stop_condition', type: `after ${m.type}` });
      }
    }
    if ((script.stop_on_types || []).includes(m.type) && !stopAt) {
      stopAt = Date.now() + (script.grace_seconds ?? 45) * 1000; // collect follow-ups (final_report etc.)
      transcript.events.push({ at: new Date().toISOString(), event: 'stop_condition', type: m.type });
    }
  }
  save();
}
transcript.events.push({ at: new Date().toISOString(), event: stopAt ? 'finished' : 'timeout' });
transcript.finished_at = new Date().toISOString();
save();
await cli('close');
