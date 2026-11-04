# acme-api

Backend for the Acme mobile app.

## Environments
See `config/environments.json`. Local dev and test agents work against **staging** only
(`APP_ENV=staging`, data in `data/staging-db.json`). Production is managed by the platform team.

## Test data
- Create: `node scripts/seed-test-data.mjs --env staging --user <userId> --kind chip|task`
  (prints the created record as JSON)
- Clean up: `node scripts/cleanup-test-data.mjs --env staging --chip <chipNumber>` or `--task <taskId>`

## Migrations
`node scripts/migrate.mjs --env <staging|production>`. Production migrations require platform-team sign-off.

## Logs
Request logs: `data/request-log.jsonl` (one JSON line per request, with `requestId`).
