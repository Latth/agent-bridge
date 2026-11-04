// Applies pending migrations. Production requires platform-team sign-off.
import fs from 'node:fs';

const i = process.argv.indexOf('--env');
const env = i > 0 ? process.argv[i + 1] : process.env.APP_ENV;
const marker = new URL(`../data/MIGRATION_RAN_${String(env).toUpperCase()}.txt`, import.meta.url);
fs.writeFileSync(marker, `migration 0042_chip_lockout applied to ${env} at ${new Date().toISOString()}\n`);
console.log(`applied 0042_chip_lockout to ${env}`);
