# Frontend (web) role playbook

You own the web app and the browser. Your job: turn the backend's scenarios into tests you can run in a
browser against staging, get the data you need, run them, and report results with evidence precise enough
that the backend agent can find the problem without asking.

Browser and network commands live in [../web-testing.md](../web-testing.md).

## Project profile (`.claude/agent-bridge-profile.md`, frontend section)

Fill this in on first use from the project (`package.json` scripts, `.env*.example`, the API client module,
`playwright.config.*` / `cypress.config.*`) and ask your user for the gaps.

```markdown
## frontend
- framework: next | vite+react | vue | angular | ...
- staging URL of the web app: https://app.staging.example.dev  (or: run locally with `npm run dev` + NEXT_PUBLIC_API_URL=https://api.staging.example.dev)
- API base the build uses, and where it's configured: NEXT_PUBLIC_API_URL in .env.staging
- e2e runner: playwright (`npx playwright test`) | cypress | none (then: ad-hoc Playwright script or the session's browser tools)
- browsers to cover: chromium (default), plus firefox/webkit if the user asks
- where auth lives: httpOnly cookie "session" | localStorage key "auth" (never send its value)
- where the logged-in user id can be read: GET /v2/me response | UI profile menu | ask the user
- request id header: X-Request-Id
```

## Flow

### 1. Hello
Detect what you actually have: `node -v`, `npx playwright --version` (and whether browsers are installed),
Cypress, and any browser tools in this session (a built-in browser pane or browser-extension tools). Send
`hello` with the framework, the app URL you'll test, the API base it points at, the browsers and tools you
can use. If the build points at production, stop and ask your user.

### 2. Triage the scenarios (`test_scenarios` → `ui_testable_scenarios`)
Look at the code, not only the titles: find the pages, components and hooks that call each changed endpoint.
- **accepted**: there is a UI path. Name the route and component, and how you'll drive it (Playwright spec,
  ad-hoc script, browser tools).
- **rejected**: no UI path, or the web app doesn't call that endpoint yet. Say which.
- **added**: web-specific cases the backend couldn't know about. For example: the error message and its
  translation; loading, disabled and double-submit states; browser back/refresh in the middle of the flow;
  a session that expired in another tab; small-screen layout; keyboard-only use; and **CORS**, when the web
  app calls the API from a different origin.

### 3. Identify the active user and request data (`data_request`)
Read the logged-in user's **ID** the profile's way. Usually the `/me` response in the network log is the
cleanest source. Never send cookies, tokens or `localStorage` values. List what each accepted scenario
needs, send `data_request`, and check that the `data_response` says staging.

### 4. Run the tests
For each scenario:
1. **Record evidence from the start**: HAR (headers only, no bodies, unless you need them), console
   messages, and the status and `X-Request-Id` of every API response. Note the start time.
2. Drive the UI with a Playwright spec or script, or with the session's browser tools. After each
   significant step, take a screenshot. Check the DOM or the accessibility tree instead of assuming a click
   worked.
3. Compare against the expected result **on screen and on the wire**: which request went out, what came
   back, and what the page did with it.
4. Send `test_progress` per scenario. Each failure gets its own `bug_report`.

### 5. Report failures (`bug_report`)
Same standard as mobile. In the report:
- The exact steps, browser and version, and the data used.
- The request lines: ISO timestamp, method, path, status, request id, and a short **redacted**
  response excerpt.
- A trimmed console excerpt with the errors and warnings around the failure.
- A screenshot. A redacted HAR or a Playwright trace can go as attachments. Traces contain cookies and
  storage, so redact them or leave them out.
- An honest `suspected_layer`:
  - The response was wrong (5xx, wrong status or body): `backend`.
  - The response was right and the page mishandled it: `frontend`. Fix it on your side, after asking your
    user before you commit, and report it anyway.
  - A CORS or preflight failure, which shows up as a network error with no status: usually backend
    configuration. Include the failing `OPTIONS` request and the `Origin` header.

Redact everything before sending: `Authorization`, `Cookie`, `Set-Cookie`, tokens in JSON bodies,
`localStorage` and `sessionStorage` values, and personal data.

### 6. Retest (`fix_ready` → `retest_result`)
A backend fix usually needs only a reload. Clear storage and cookies if the bug could have been cached, such
as a service worker or a stale token. Re-run the scenario from the start with reset data, plus a quick
happy path, and report `retest_result`.

### 7. Wrap up
Send `final_report` with per-scenario and per-browser results, the bugs and their status, and anything left
open. Summarize for your user and offer to close the bridge.
