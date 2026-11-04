# Mobile testing commands

Collect all evidence in `.agent-bridge/evidence/<thread>/<scenario>/` so it's easy to attach and is
git-ignored with the rest of the state folder.

> **Windows PowerShell gotcha:** `>` redirection re-encodes output (UTF-16), which corrupts PNGs and makes
> logs hard to grep. For binary files, write to the device and `adb pull` them. For logs, use the Bash tool
> (Git Bash) or `| Out-File -Encoding utf8`.

## Contents
1. Android (adb, logcat)
2. iOS Simulator (macOS)
3. Driving the UI: Maestro, mobile MCP, raw input
4. Extracting network traffic from logs

## 1. Android

```bash
adb devices -l                                   # pick a serial; add -s <serial> to every command if more than one
adb -s emulator-5554 install -r app-staging-debug.apk
adb shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1    # launch
adb shell pidof -s com.example.app               # current process id (changes on every app restart)
```

**Logcat capture for one scenario.** Run this in the background, and stop it after the scenario:

```bash
adb logcat -c                                    # clear the buffer so the excerpt starts at this scenario
adb logcat -v threadtime,year,zone --pid=$(adb shell pidof -s com.example.app) > .agent-bridge/evidence/login-v2/S2/logcat.txt
# or by tag (e.g. OkHttp's HttpLoggingInterceptor), including the app's own error tags:
adb logcat -v threadtime,year,zone -s OkHttp:D AuthRepository:V *:E
```

If the app restarts mid-scenario its pid changes. Use the tag filter, or restart the capture.

**Screenshots and UI state:**

```bash
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png .agent-bridge/evidence/login-v2/S2/01-lockout.png
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml .agent-bridge/evidence/login-v2/S2/ui.xml
```

The UI dump gives every element's text and bounds. Use it to find tap coordinates and to check what is
really on screen instead of guessing.

**Debug-build data** (only `debuggable` builds):
`adb shell run-as com.example.app ls shared_prefs` lets you find where the logged-in user ID is stored. Read
only the ID. Prefs often also hold tokens; never send those.

`adb shell pm clear com.example.app` wipes app data and logs the user out. Ask your user first.

## 2. iOS Simulator (macOS only)

```bash
xcrun simctl list devices booted
xcrun simctl install booted build/App.app
xcrun simctl launch booted com.example.app
xcrun simctl io booted screenshot .agent-bridge/evidence/login-v2/S2/01.png
xcrun simctl openurl booted "exampleapp://login"          # deep link straight to a screen
xcrun simctl spawn booted log stream --style compact --level debug \
  --predicate 'subsystem == "com.example.app" OR process == "App"' > .agent-bridge/evidence/login-v2/S2/ios.log
```

Physical iOS devices: logs via Xcode's console, or `idevicesyslog` from libimobiledevice if installed.
UI driving on a physical device usually needs Maestro, XCUITest, or the user.

## 3. Driving the UI

Pick the most reliable option available. Say which one in `hello`.

- **Mobile MCP tools**, if present in the session: they usually offer element-aware tap/type plus
  screenshots. Use them before raw coordinates.
- **Maestro**: write a small flow per scenario in `.agent-bridge/evidence/<thread>/<scenario>/flow.yaml`:

  ```yaml
  appId: com.example.app
  ---
  - launchApp
  - tapOn: "Chip number"
  - inputText: "9900112234"
  - tapOn: "PIN"
  - repeat:
      times: 6
      commands:
        - inputText: "0000"
        - tapOn: "Log in"
  - assertVisible: "Too many attempts"
  - takeScreenshot: lockout
  ```
  Run it with `maestro test flow.yaml`; `maestro hierarchy` shows the current element tree.
- **Raw adb input**, as a fallback: `adb shell input tap X Y`, `adb shell input text "9900112234"`
  (`%s` for spaces), `adb shell input keyevent 66` (Enter), `4` (Back). Take a UI dump after each step to
  confirm the result.
- **Ask your user** to perform a step when nothing else works (biometrics, a physical card). Tell them
  exactly what to tap, then verify the result yourself from screenshots and logs.

## 4. Extracting network traffic

With OkHttp's `HttpLoggingInterceptor` (level BASIC/HEADERS/BODY), requests look like
`--> POST https://api.staging.example.dev/v2/auth/chip-login` and responses like
`<-- 500 https://... (312ms)`. Pull the lines out:

```bash
grep -E -- '--> (GET|POST|PUT|PATCH|DELETE)|<-- [0-9]{3}|X-Request-Id' logcat.txt
```

Then redact before sending:

```bash
sed -E 's/(Authorization|Cookie|Set-Cookie): .*/\1: [REDACTED]/I; s/("(access|refresh)_?[Tt]oken"\s*:\s*")[^"]+/\1[REDACTED]/g' logcat.txt > logcat.redacted.txt
```

Other stacks: Retrofit/Ktor/Volley, Flutter `dio` log interceptors, React Native (`ReactNativeJS` tag),
iOS `URLSession` logging. Find the app's network logging in its source to know what to grep for. If the
app logs no traffic, say so in `hello`, and rely on timestamps plus the backend's server logs for correlation.
