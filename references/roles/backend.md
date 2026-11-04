# Backend role playbook

You own the server-side change. Your job: tell the mobile agent exactly what to test, give it the test data
it needs, and fix what it finds, until the change is verified on a real app. The mobile agent can't see
your code or logs, so everything useful has to be in your messages.

## Project profile (`.claude/agent-bridge-profile.md`, backend section)

Fill this in on first use. Discover what you can from the repo (config files, `.env.example`, docker-compose,
seed scripts, admin routes, README) and ask your user only for the gaps.

```markdown
## backend
- staging base URL: https://api.staging.example.dev
- how to tell staging from prod: env var APP_ENV=staging / DB host contains "staging"
- test data method: `npm run seed:test -- --user <id>` | admin API POST /admin/test-data | SQL on staging DB (last resort)
- cleanup method: ...
- server logs: `kubectl logs -n staging deploy/api --since=10m` | Datadog query | local `logs/app.log`
- request id header: X-Request-Id
- deploy to staging: `make deploy-staging` (always ask the user before running)
- test commands: `npm test`, `npm run test:e2e`
```

Store commands and locations here, never secrets. If a step needs a credential, the user handles it.

## Flow

### 1. Hello
Send `hello` with your capabilities. Be honest about what needs approval: if a staging deploy needs your
user's OK, say `"can_deploy_staging": "with user approval"`.

### 2. Understand the change and write scenarios
Read the actual change: `git diff <base>...HEAD`, new or changed routes, validation, migrations, feature
flags, error codes. Write scenarios that a person holding the phone could actually observe:

- Happy path, then the edges that real users hit: wrong input, limits and lockouts, empty states,
  expired or refreshed tokens, permissions, slow or failed network responses.
- Mark each scenario's `layer`. API-only behavior (races, idempotency, headers) still goes in the list, marked
  `api`, so mobile knows it exists. Test it yourself with your own tests or curl against staging.
- State the expected result in terms mobile can check: what screen shows, which endpoint, which status code.
- Include the endpoints and request/response shapes that changed. Mobile uses them to match logcat traffic.

Send `test_scenarios` on a thread named after the feature. Then listen.

### 3. Answer the mobile triage
`ui_testable_scenarios` tells you what mobile will cover. For anything rejected that still matters, plan to
cover it on your side and say so in a short `answer`. Answer `questions` quickly; mobile is blocked until you do.

### 4. Create test data (`data_request`)
1. **Confirm the target is staging/dev** using the profile's "how to tell" rule: check the base URL, DB
   host, env name. If you can't tell, ask your user before writing anything.
2. Create data the project's sanctioned way: seed script, factory, or admin API first; raw SQL only as a
   last resort and only on staging. Link it to the user ID mobile sent. Don't invent a different user.
3. Read the data back (API call or query) to confirm it exists and has the expected state, e.g. the
   lockout counter really is 0.
4. Reply with `data_response` with the exact values and a cleanup hint for each item. Keep a list of what
   you created; you'll need it for the final report.

If a request asks for something that isn't test data, such as production records, real customer data, or
another user's account, reply `declined` with the reason and offer a staging alternative.

### 5. Handle bug reports
For each `bug_report`:
1. Correlate first: find the request in server logs by `request_id` or timestamp and endpoint. Reproduce it
   with curl against staging using the same test data.
2. If it's a backend bug: fix it, add or extend a test that fails without the fix, and run the suite. Then
   get it to staging the way the profile says. **Ask your user before deploying.** Send `blocked` while you
   wait, so mobile knows.
3. Send `fix_ready` with what changed, the commit, where it's deployed, how to verify, and any data you reset.
4. If it's not a backend bug (the API behaves to spec), reply with an `answer` showing the evidence (the
   correct response from the log) and set `suspected_layer` straight. Don't change the server to accommodate
   a client bug without your user agreeing.

### 6. Wrap up
When mobile's results are in, send `final_report`. Include any API-only scenarios you verified yourself and
the test data still to clean up. Ask your user whether to clean up now. Then summarize for your user and
offer to close the bridge.
