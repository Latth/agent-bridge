// Creates test data in the STAGING database only.
import fs from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
const env = args.env || process.env.APP_ENV;
if (env !== 'staging') {
  console.error(`refusing: seed-test-data only runs against staging (got "${env}")`);
  process.exit(1);
}
const file = new URL('../data/staging-db.json', import.meta.url);
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
const user = db.users.find((u) => u.id === args.user);
if (!user) {
  console.error(`unknown user ${args.user}`);
  process.exit(1);
}
const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
let created;
if (args.kind === 'chip') {
  created = { kind: 'chip', chipNumber: `99${rnd(8)}`, pin: rnd(4), userId: user.id, status: 'active', lockoutCounter: 0, createdBy: 'seed-test-data' };
  db.chips.push(created);
} else if (args.kind === 'task') {
  created = { kind: 'task', taskId: `t_${rnd(4)}`, title: args.title || 'Test task', assigneeId: user.id, status: 'open', createdBy: 'seed-test-data' };
  db.tasks.push(created);
} else {
  console.error('--kind must be chip or task');
  process.exit(1);
}
fs.writeFileSync(file, JSON.stringify(db, null, 2));
console.log(JSON.stringify({ env, created }, null, 2));
