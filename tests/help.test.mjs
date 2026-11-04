// `bridge help`: the user-facing list of what the bridge can do (HELP.md). Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/bridge.mjs', import.meta.url));
const HELP = fs.readFileSync(fileURLToPath(new URL('../HELP.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-help-'));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', path.join(EMPTY, 'state')], { cwd: EMPTY, encoding: 'utf8' });
const topics = [...HELP.matchAll(/^## (\w+): /gm)].map((m) => m[1]);

test('help works without any bridge session', () => {
  const r = run('help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# agent-bridge: what it can do/);
  assert.ok(!fs.existsSync(path.join(EMPTY, 'state')), 'help must not create state');
});

test('every section is reachable as a topic and listed in the header', () => {
  const header = HELP.split('\n## ')[0];
  assert.ok(topics.length >= 8);
  for (const t of topics) {
    assert.ok(header.includes(t), `topic "${t}" missing from the header list`);
    const r = run('help', t);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /\n## /, `help ${t} prints only its own section`);
  }
  assert.match(run('help', ':case').stdout, /shared case file/);
});

test('unknown topic lists the topics', () => {
  const r = run('help', 'nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(topics.join(', ')));
});

test('the commands section names every CLI command', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const names = [...src.match(/const commands = \{([^}]*)\}/)[1].matchAll(/'?([\w-]+)'?:/g)].map((m) => m[1]);
  const section = HELP.split('## commands:')[1];
  for (const n of names) assert.match(section, new RegExp(`\`${n}[\` ]`), `HELP.md commands section is missing "${n}"`);
});
