# agent-bridge message protocol

Every message is an envelope created by the relay. You set `type`, `to`, `thread_id`, `reply_to`, `body` and
attachments. The relay adds `id`, `seq`, `ts` and `from`.

```json
{
  "id": "msg_3f9a1c2b7e4d", "seq": 12, "ts": "2026-11-04T10:15:02.114Z",
  "from": { "id": "peer_a1b2c3d4e5f6", "role": "backend", "name": "BE Agent" },
  "to": "mobile", "type": "test_scenarios", "thread_id": "login-v2", "reply_to": null,
  "body": { "...": "..." },
  "attachments": [{ "name": "flow.png", "mime": "image/png", "size": 48211 }]
}
```

- `to`: a role (`mobile`), a peer id, or `*` for everyone else. Address by role unless several peers share one.
- `type`: snake_case. Use the types below so the other agent knows what to do. Invent a new one only when
  none fits, and say in the body what you expect back.
- `body`: JSON is preferred. Plain text is fine for `question` and `answer`.
- Keep field names in English. Free text (titles, notes) can be in the team's language.
- Keep bodies lean. The examples below show every useful field, but send only those that carry
  information. Leave out empty fields and put long evidence in attachments. The receiving agent pays for every
  character.
- **No reply needed** to `ack`, `final_report`, `declined`, `peer_left`, or an `answer` that settles a
  question. Reply to them only if you now have something new to say.

## Contents

1. Session: `hello`, `peer_joined` / `peer_left` (system)
2. Test planning: `test_scenarios`, `ui_testable_scenarios`
3. Test data: `data_request`, `data_response`
4. Execution: `test_progress`, `bug_report`, `fix_ready`, `retest_result`
5. Conversation and control: `question`, `answer`, `ack`, `declined`, `blocked`
6. Wrap-up: `final_report`

## 1. Session

**`hello`** is sent right after connecting by both sides. It tells the other agent what you can and cannot do.

```json
{
  "role": "mobile",
  "skill_version": "1.6.0",
  "project": { "name": "acme-mobile", "platform": "android", "branch": "feature/login-v2" },
  "environment": "staging",
  "capabilities": {
    "devices": ["emulator-5554 (Pixel 7, Android 14)"],
    "tools": ["adb", "logcat", "maestro"],
    "can_create_test_data": false
  },
  "notes": "App build points at staging API https://api.staging.acme.dev"
}
```

A backend `hello` lists capabilities such as `can_create_test_data`, `can_deploy_staging`
(only with user approval), `can_read_server_logs`, and the `staging_base_url`.

**`peer_joined` / `peer_left`** come from `agent-bridge (system)`. On `peer_joined`, the host greets the new
peer with its own `hello`.

## 2. Test planning

**`test_scenarios`** goes from backend to mobile: what changed and what should be verified.

```json
{
  "feature": "Login v2: chip number login",
  "change_summary": "New POST /v2/auth/chip-login; old /auth/login still works. Lockout after 5 failed attempts.",
  "endpoints": [
    { "method": "POST", "path": "/v2/auth/chip-login", "notes": "body: { chipNumber, pin }" }
  ],
  "scenarios": [
    { "id": "S1", "title": "Login with a valid chip number", "priority": "high", "layer": "both",
      "preconditions": "User has an active chip", "steps": ["Open login", "Enter chip + PIN", "Submit"],
      "expected": "Home screen; GET /v2/me returns the user" },
    { "id": "S2", "title": "Lockout after 5 wrong PINs", "priority": "high", "layer": "both",
      "expected": "6th attempt shows the lockout message; API returns 423" },
    { "id": "S3", "title": "Token refresh race", "priority": "medium", "layer": "api",
      "expected": "Only one refresh succeeds" }
  ]
}
```

`layer` is `api` (backend-only), `ui` or `both`. It is a hint; the UI side (mobile or frontend) decides what it can test on screen.

**`ui_testable_scenarios`** is the UI side's answer (mobile or frontend): which scenarios it will test on the device or in the browser, which it can't,
and what it needs.

```json
{
  "accepted": [
    { "id": "S1", "screen": "LoginScreen -> HomeScreen", "how": "Maestro flow on emulator" },
    { "id": "S2", "screen": "LoginScreen", "how": "enter wrong PIN 6 times" }
  ],
  "rejected": [ { "id": "S3", "reason": "No UI path triggers a concurrent refresh; API-only" } ],
  "added": [ { "id": "S4", "title": "Lockout message is localized (tr)", "derived_from": "S2" } ],
  "questions": []
}
```

## 3. Test data

**`data_request`** goes from mobile to backend. It identifies the test user by ID only and lists what each
scenario needs.

```json
{
  "environment": "staging",
  "user": { "id": "u_48213", "source": "logged-in user on emulator-5554" },
  "needs": [
    { "scenario_id": "S1", "kind": "chip_number", "details": "active chip linked to u_48213, PIN known" },
    { "scenario_id": "S2", "kind": "chip_number", "details": "a second chip whose lockout counter is 0" },
    { "scenario_id": "S4", "kind": "task", "details": "one open task assigned to u_48213" }
  ]
}
```

**`data_response`** goes from backend to mobile: what was created, the exact values, and how to clean up.

```json
{
  "environment": "staging",
  "created": [
    { "scenario_id": "S1", "kind": "chip_number", "values": { "chipNumber": "9900112233", "pin": "4821" },
      "cleanup": "DELETE /admin/test-chips/9900112233" },
    { "scenario_id": "S4", "kind": "task", "values": { "taskId": "t_7781", "title": "Test task" } }
  ],
  "failed": [ { "scenario_id": "S2", "reason": "chip pool exhausted on staging; asked the user" } ]
}
```

Test PINs and IDs that exist only on staging are fine to send. Real credentials never are.

## 4. Execution

**`test_progress`** is a short status per scenario. Send it at start and end, not for every tap.

```json
{ "scenario_id": "S1", "status": "passed", "duration_s": 42, "notes": "Home loaded, /v2/me 200 in 310 ms" }
```

`status` is one of `running`, `passed`, `failed`, `blocked`, `skipped`.

**`bug_report`** is a UI side (mobile or frontend) reporting a failure with enough evidence for backend to locate it without asking.

```json
{
  "bug_id": "B1", "scenario_id": "S2", "severity": "high",
  "title": "Lockout returns 500 instead of 423 on 6th attempt",
  "steps": ["Login screen", "Chip 9900112234, wrong PIN x6"],
  "expected": "423 + lockout message", "actual": "500, generic error toast",
  "suspected_layer": "backend",
  "evidence": {
    "requests": [
      { "ts": "2026-11-04T10:31:07.882Z", "method": "POST", "url": "/v2/auth/chip-login",
        "status": 500, "request_id": "req_9c1e", "response_excerpt": "{\"error\":\"internal\"}" }
    ],
    "logcat_excerpt": "11-04 13:31:07.901 E/AuthRepository: chip-login failed: HTTP 500 ...",
    "attachments": ["0-lockout.png", "1-logcat.txt"]
  }
}
```

A frontend report uses `console_excerpt` in place of `logcat_excerpt` and adds `"browser": "chromium 131"`.
It may attach a redacted HAR.

`suspected_layer` is `backend`, `mobile`, `frontend` or `unknown`. When the fault is on the reporter's own
side, it fixes it there and still reports it, so the final report is complete.

**`fix_ready`** goes from backend to mobile: what changed, where it's deployed, and how to verify.

```json
{ "bug_ids": ["B1"], "change_summary": "Lockout path no longer dereferences null attempt record",
  "deployed_to": "staging", "commit": "a1b2c3d", "how_to_verify": "Repeat S2; expect 423 on 6th attempt",
  "data_reset": "Lockout counter for chip 9900112234 reset to 0" }
```

**`retest_result`** has the same shape as `test_progress`, plus `bug_ids`.

## 5. Conversation and control

- **`question` / `answer`**: free text or `{ "text": "...", "about": "S2" }`. Answer with `--reply-to`.
- **`ack`**: "received, working on it". Send it only when the work will take more than a few minutes, so
  the other side knows not to wait idle.
- **`declined`**: `{ "request_id": "msg_...", "reason": "Needs production DB access; my user must approve" }`.
  Use it whenever the safety rules stop you, so the peer isn't left waiting.
- **`blocked`**: `{ "reason": "Waiting for my user to approve the staging deploy", "eta": "unknown" }`.

## 6. Wrap-up

**`final_report`** is sent by each side at the end. It's also what you summarize for your user.

```json
{
  "thread_id": "login-v2",
  "summary": "4 scenarios: 3 passed, 1 fixed and retested. No open bugs.",
  "scenarios": { "S1": "passed", "S2": "passed after fix B1", "S3": "api-only (backend tests)", "S4": "passed" },
  "bugs": [ { "bug_id": "B1", "status": "fixed", "commit": "a1b2c3d" } ],
  "test_data_to_clean_up": [ "DELETE /admin/test-chips/9900112233" ],
  "open_items": []
}
```
