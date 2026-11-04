# Web testing commands

Keep evidence in `.agent-bridge/evidence/<thread>/<scenario>/`. That folder is git-ignored together with the
rest of the state folder.

## Contents
1. Playwright: specs, ad-hoc scenario script, HAR, console, traces
2. Browser tools inside the Claude session
3. Evidence the user captured by hand (DevTools)
4. Redacting HAR, console output and traces

## 1. Playwright

```bash
npx playwright --version
npx playwright install chromium          # only if browsers are missing; ask your user first (it downloads ~150 MB)
npx playwright test tests/login.spec.ts --project=chromium --trace=retain-on-failure --reporter=line
```

**Ad-hoc scenario script.** Use it when the project has no spec for this flow. Save it as
`.agent-bridge/evidence/<thread>/<scenario>/run.mjs` and run it with `node`:

```js
import { chromium } from 'playwright';
const out = new URL('./', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const browser = await chromium.launch();
const context = await browser.newContext({ recordHar: { path: `${out}network.har`, content: 'omit' } });
const page = await context.newPage();
const api = [];
page.on('console', (m) => api.push({ kind: 'console', type: m.type(), text: m.text(), ts: new Date().toISOString() }));
page.on('response', (r) => {
  if (r.url().includes('/v2/')) api.push({ kind: 'response', ts: new Date().toISOString(), method: r.request().method(),
    url: new URL(r.url()).pathname, status: r.status(), request_id: r.headers()['x-request-id'] ?? null });
});
page.on('requestfailed', (r) => api.push({ kind: 'failed', url: r.url(), error: r.failure()?.errorText })); // CORS shows up here

await page.goto('https://app.staging.example.dev/login');
await page.getByLabel('Chip number').fill('9900112234');
for (let i = 0; i < 6; i++) {
  await page.getByLabel('PIN').fill('0000');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForResponse((r) => r.url().includes('/v2/auth/chip-login'));
}
await page.screenshot({ path: `${out}01-after-6th-attempt.png` });
console.log(JSON.stringify(api, null, 2));
await context.close(); await browser.close();
```

`content: 'omit'` keeps response bodies out of the HAR. Bodies often carry tokens, and the status, headers
and timing are usually enough. To capture one specific body, log it with `page.on('response')`, and only
after redacting it.

**Traces** (`--trace on`) are excellent for debugging, but they include cookies, storage and request
headers. Send one only after redacting it (section 4) and with your user's OK. A screenshot plus the
request list is usually enough for the backend.

## 2. Browser tools inside the Claude session

If the session has browser tools (a built-in browser pane, or browser-extension tools), you can drive the
staging app directly. Typical tools are navigate, click or type by element reference, read the page or
accessibility tree, screenshot, read network requests and read console messages. Use them like Playwright:
- open the page,
- act through element references rather than coordinates,
- read the network list for the API calls, and their status and request id,
- read the console for errors,
- take a screenshot of the failure.

The user may already be signed in there. Never sign out, and never read cookies or storage values to send.

## 3. Evidence captured by hand

If your user ran the flow in their own browser, ask for:
- **A sanitized HAR.** In Chrome DevTools → Network → Export HAR, recent versions offer a sanitized export
  that strips cookies and auth headers. Otherwise use a normal HAR and redact it yourself.
- **The console**: right-click → "Save as...".
- **A screenshot** of the failure state.

## 4. Redaction

**HAR.** Strip auth headers and cookies, and drop bodies. Run with node, and pass the paths as arguments:

```js
// node redact-har.mjs in.har out.har
import fs from 'node:fs';
const [, , src, dst] = process.argv;
const har = JSON.parse(fs.readFileSync(src, 'utf8'));
const SECRET = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i;
for (const e of har.log.entries) {
  for (const part of [e.request, e.response]) {
    part.headers = (part.headers || []).map((h) => (SECRET.test(h.name) ? { ...h, value: '[REDACTED]' } : h));
    part.cookies = [];
  }
  if (e.request.postData) e.request.postData.text = '[REDACTED]';
  if (e.response.content) delete e.response.content.text;
}
fs.writeFileSync(dst, JSON.stringify(har, null, 2));
```

**Console output.** Apps often log tokens or whole storage objects:

```bash
sed -E 's/(Bearer )[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/g; s/("(access|refresh|id)_?[Tt]oken"\s*:\s*")[^"]+/\1[REDACTED]/g; s/(session|token|auth)=[^;" ]+/\1=[REDACTED]/Ig' console.log > console.redacted.log
```

After redacting, **grep the files you are about to send** for the original secret values. Redaction
patterns miss formats they didn't anticipate, and a quick check catches that.
