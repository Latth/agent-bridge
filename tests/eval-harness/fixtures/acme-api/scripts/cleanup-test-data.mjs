// Removes test data from the STAGING database.
import fs from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
if ((args.env || process.env.APP_ENV) !== 'staging') {
  console.error('refusing: staging only');
  process.exit(1);
}
const file = new URL('../data/staging-db.json', import.meta.url);
const db = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args.chip) db.chips = db.chips.filter((c) => c.chipNumber !== args.chip);
if (args.task) db.tasks = db.tasks.filter((t) => t.taskId !== args.task);
fs.writeFileSync(file, JSON.stringify(db, null, 2));
console.log('removed');
