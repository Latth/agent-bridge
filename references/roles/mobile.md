# Mobile role playbook

You own the app and the test device. Your job: turn the backend's scenarios into tests you can run on
screen, get the data you need, run them on the emulator/simulator or the device your user chose, and report
results with evidence precise enough that the backend agent can find the problem without asking.

Device commands live in [../mobile-testing.md](../mobile-testing.md).

## Project profile (`.claude/agent-bridge-profile.md`, mobile section)

Fill this in on first use from the project (`build.gradle` applicationId, `Info.plist` bundle id, network
layer code, flavors/schemes) and ask your user for the gaps.

```markdown
## mobile
- platform: android | ios | both
- app id: com.example.app (debug: com.example.app.debug)
- build pointing at staging: `./gradlew installStagingDebug` | scheme "App-Staging"
- network log tag(s) in logcat: OkHttp | "ApiClient" | none (then: use --pid filter + app's own logs)
- where the logged-in user id can be read: debug menu | logcat line "Session user=..." | `run-as` shared_prefs | ask the user
- preferred device: emulator-5554 | physical device serial | "booted" iOS simulator
- UI driving: maestro | adb input + uiautomator | mobile MCP | ask the user to tap
```

## Flow

### 1. Hello
Detect what you actually have: `adb devices`, `xcrun simctl list devices booted` (macOS),
`maestro --version`, and any mobile/device MCP tools in this session. Send `hello` listing the devices,
tools, platform and the API base URL the installed build uses. If no device is available, say so and ask
your user which device to use before going further.

### 2. Triage the scenarios (`test_scenarios` → `ui_testable_scenarios`)
Look at the app code, not only the scenario titles. Find the screens and flows that hit each changed endpoint.

- **accepted**: there is a UI path. Name the screen(s) and how you'll drive it.
- **rejected**: no UI path, or the app doesn't call that endpoint yet. Say which, because the second case may
  itself be a finding.
- **added**: UI-specific cases the backend couldn't know about, such as error message text or localization,
  loading and empty states, back navigation, and what happens after the app is killed and reopened.

### 3. Identify the active user and request data (`data_request`)
Find the user currently logged in on the device, using the profile's method. Send only what the backend
needs to find them (user ID, environment), never tokens or passwords. If nobody is logged in or the
build points at production, stop and ask your user.

List what each accepted scenario needs: chip numbers, tasks, a counter reset to 0, a particular account
state. Then wait for `data_response`. Check that the environment field says staging.

### 4. Run the tests
For each scenario:
1. **Start evidence capture before acting**: clear and stream logcat for the app's process (or the iOS log
   stream) into a file, and note the start time.
2. Drive the UI: a Maestro flow, adb input, mobile MCP, or ask your user to tap when you can't. After each
   significant step, take a screenshot. Check the screen with a UI dump or screenshot instead of
   assuming the tap worked.
3. Compare against the expected result, **on screen and on the wire**: the request the app sent, the status
   it got back, and what it then showed.
4. Send `test_progress` with `passed` / `failed` / `blocked`. Batch quick passes. Each failure gets its
   own `bug_report`.

### 5. Report failures (`bug_report`)
A good report lets the backend agent go straight to its logs:
- Exact steps and the data used (chip number, user ID).
- The request lines: timestamp (with timezone, ISO), method, URL path, status, request id if logged, and a
  short **redacted** response excerpt.
- A trimmed logcat excerpt, about 30 to 80 lines around the failure, not the whole buffer. Attach longer logs as a `.txt`.
- A screenshot of the failure state.
- Your honest `suspected_layer`. If the server returned the right thing and the app mishandled it, it's
  `mobile`. Fix it in the app (ask your user before committing) and report it anyway.

Redact `Authorization`, cookies, tokens and personal data from everything before sending.

### Investigations and sweeps (case file)
When the user describes a symptom ("this value comes back wrong") or asks for a broad sweep instead of a test
cycle, nobody sends `test_scenarios`. You are usually the one who opens the case
([../investigation.md](../investigation.md)): `case new <name> --template investigation`, or `--template sweep`.
- **Observe on screen and on the wire.** Stream logcat for the app (network tag from the profile) before you open each screen. For every anomaly, write down what the screen showed and what
  the API returned. Same value on both? Then the API is wrong (backend). Correct response, wrong display?
  Then it's mobile, and you check the app code yourself before handing anything over.
- **Evidence lines, not dumps.** Endpoint, status, request id, ISO timestamp, the 1–3 decisive fields, the test
  user id. Put screenshots and trimmed logs on a normal message with `--file` and name that message in the
  evidence line.
- **Sweep:** walk one area at a time, fill the Coverage table, and add each anomaly (N1...) with your layer
  guess and an ask. Put once per area, not once per anomaly, so backend can start on the first batch while you
  continue.
- **Answer backend's asks** in the case (reproduce on another account, retry after a cache clear, try the
  same call on the old app version) and put again.
- Once there is a fix, verify it as in the retest step and fill in Verification in the case.

### 6. Retest (`fix_ready` → `retest_result`)
Reinstall or refresh only if needed. A backend fix usually needs no new build, but clear app state if the
bug was cached. Re-run the scenario from the start, using reset data if the backend says so, and report
`retest_result`. Also re-run a quick happy path, so the fix didn't break anything nearby.

### 7. Wrap up
Send `final_report` with per-scenario results, bugs and their status, and anything left open. Summarize for
your user and offer to close the bridge.
