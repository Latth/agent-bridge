#!/usr/bin/env node
// Lays out one eval iteration for every case in evals/ that has a peer-script.json.
//   node prepare-iteration.mjs <skill-dir> <iteration-dir> [case-name ...]
// Creates <iteration>/<case>/{with_skill,without_skill}/outputs/project (a copy of the case's files/),
// <iteration>/<case>/eval_metadata.json (prompt + grader statements), and <iteration>/../cli-only/scripts
// (the bridge CLI without SKILL.md, used by the baseline runs).
// Keep <iteration-dir> short on Windows: working directories longer than ~248 characters cannot start processes.
import fs from 'node:fs';
import path from 'node:path';

const [skillArg, iterArg, ...only] = process.argv.slice(2);
if (!skillArg || !iterArg) {
  console.error('usage: node prepare-iteration.mjs <skill-dir> <iteration-dir> [case-name ...]');
  process.exit(1);
}
const skill = path.resolve(skillArg);
const iter = path.resolve(iterArg);
const evals = path.join(skill, 'evals');

const cli = path.join(path.dirname(iter), 'cli-only', 'scripts');
fs.mkdirSync(cli, { recursive: true });
for (const f of fs.readdirSync(path.join(skill, 'scripts'))) fs.copyFileSync(path.join(skill, 'scripts', f), path.join(cli, f));

const body = (file) => fs.readFileSync(file, 'utf8').split('---').slice(2).join('---').trim();
const done = [];
for (const c of fs.readdirSync(evals)) {
  const dir = path.join(evals, c);
  if (!fs.existsSync(path.join(dir, 'peer-script.json')) || (only.length && !only.includes(c))) continue;
  const graders = fs.readdirSync(path.join(dir, 'graders')).filter((f) => f.endsWith('.md')).sort();
  const assertions = graders.map((g) => body(path.join(dir, 'graders', g))).filter((t) => !t.startsWith('The result matches this description'));
  fs.mkdirSync(path.join(iter, c), { recursive: true });
  fs.writeFileSync(path.join(iter, c, 'eval_metadata.json'), JSON.stringify({ eval_name: c, prompt: body(path.join(dir, 'prompt.md')), assertions }, null, 2));
  for (const cfg of ['with_skill', 'without_skill']) {
    const project = path.join(iter, c, cfg, 'outputs', 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.cpSync(path.join(dir, 'files'), project, { recursive: true });
  }
  done.push(`${c} (${assertions.length} assertions)`);
}
console.log(`prepared ${iter}\n  ${done.join('\n  ')}\nbaseline CLI: ${path.join(cli, 'bridge.mjs')}`);
