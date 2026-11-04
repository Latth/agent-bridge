#!/usr/bin/env node
// Starts one scripted peer per run directory of an iteration and prints their addresses/codes.
//   node start-peers.mjs <skill-dir> <iteration-dir> [base-port]
// Each run dir (<iteration>/<case>/<config>/) gets: peer/ (peer state), outputs/peer-transcript.json, peer-info.json.
// The peers keep running detached until their stop condition or timeout (25 min).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [skillDir, iterDir, basePortArg] = process.argv.slice(2);
const bridge = path.resolve(skillDir, 'scripts', 'bridge.mjs');
const peerScript = path.resolve(skillDir, 'tests', 'eval-harness', 'fake-peer.mjs');
let port = Number(basePortArg || 31000);
const result = {};

for (const c of fs.readdirSync(iterDir)) {
  const caseDir = path.join(iterDir, c);
  const script = path.resolve(skillDir, 'evals', c, 'peer-script.json');
  if (!fs.statSync(caseDir).isDirectory() || !fs.existsSync(script)) continue;
  for (const cfg of fs.readdirSync(caseDir)) {
    const run = path.join(caseDir, cfg);
    if (!fs.existsSync(path.join(run, 'outputs'))) continue;
    const info = path.join(run, 'peer-info.json');
    fs.rmSync(info, { force: true });
    const log = fs.openSync(path.join(run, 'peer.log'), 'a');
    const child = spawn(process.execPath, [peerScript, '--bridge', bridge, '--dir', path.join(run, 'peer'), '--port', String(port++),
      '--script', script, '--info', info, '--out', path.join(run, 'outputs', 'peer-transcript.json'), '--timeout', '1500'],
    { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    result[`${c}/${cfg}`] = info;
  }
}

const deadline = Date.now() + 20_000;
const out = {};
while (Date.now() < deadline && Object.keys(out).length < Object.keys(result).length) {
  await new Promise((r) => setTimeout(r, 300));
  for (const [k, f] of Object.entries(result)) {
    if (out[k]) continue;
    try { out[k] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  }
}
console.log(JSON.stringify(out, null, 2));
