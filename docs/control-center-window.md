# FastCUA Control Center as a standalone window — technical report

**Date:** 2026-08-03
**Commit:** `546e39e` (`feat: open the control center in a standalone window (Edge --app)`)
**Scope:** `scripts/console.ps1` (new), `overlay.ps1` (modified), `README.md` / `README_zh.md` (documented)

---

## 1. Problem

FastCUA's control center is a single-file web app (`web.html`, 424 lines,
zh/en bilingual) served by the daemon over loopback HTTP. Until this change
the only way to open it was the overlay island's F7 / Settings action, which
did `Start-Process "$base/"` — i.e. it opened the **default web browser** as a
regular tab (address bar, tab strip, browser chrome, mixed with the user's
other tabs).

The request: make the control center a **standalone desktop window** — its own
taskbar entry, no browser chrome, independent of the user's normal browser
session.

---

## 2. Current architecture (what we are wrapping)

```
daemon.mjs                     Node.js long-running process
├─ HTTP server 127.0.0.1:<port>
│   ├─ GET /  →  web.html      (control center UI, inline CSS/JS, i18n zh/en)
│   └─ /api/*                  JSON API: state, config, events, action,
│                              interject, skill-writer config, ...
│   Security:
│     • binds 127.0.0.1 only   (loopback)
│     • CSP: default-src 'self'; style-src 'unsafe-inline';
│       script-src 'unsafe-inline'; connect-src 'self'
│     • POST requires trusted origin: http://127.0.0.1:<port> or
│       http://localhost:<port> (same port as daemon) — see
│       trustedMutationOrigin()
│     • X-Frame-Options: DENY, nosniff, Referrer-Policy: no-referrer
├─ named pipe (per runtime root)
└─ spawns overlay.ps1          PowerShell WPF floating island
    └─ F7 / Settings click  →  Open-Settings
        ├─ POST /api/action {action:"pause"}   (best-effort)
        └─ Start-Process "$base/"              ← browser tab (OLD behavior)
```

Key properties that make wrapping safe:

- The UI and the API are **same-origin** (`fetch('/api/...')` relative paths,
  CSP `connect-src 'self'`). A WebView2 / Edge app window pointing at
  `http://127.0.0.1:<port>/` keeps that same-origin invariant exactly — no
  CORS, no CSP violations, and the POST origin check still passes because the
  origin is `http://127.0.0.1:<port>`.
- The port is **not always 8420**: a development checkout derives a
  path-scoped port (`18000 + hash(root) % 1000`), the installed release uses
  `8420` (`runtimeDefaultPort()` in `lib/runtime.mjs`). Whatever component
  opens the console must use the daemon's *actual* port.

---

## 3. Options considered

| Option | Approach | Pros | Cons | Verdict |
|---|---|---|---|---|
| A. WebView2 shell | WPF/PowerShell window embedding the WebView2 control loading `http://127.0.0.1:<port>/` | True native window, full styling control | Requires `Microsoft.Web.WebView2.*` managed assemblies from NuGet (nuget.org unreachable in this environment); needs an extra runtime dependency and more code | Not chosen now |
| B. Edge `--app` mode | `msedge.exe --app=<url> --user-data-dir=<isolated>` | Zero new dependencies, ships with Windows 10/11, real standalone window, isolated profile | Window is Edge-rendered (visually identical to the web app anyway); needs Edge present (fallback provided) | **Chosen** |
| C. Rewrite the console in WPF | Reimplement web.html UI natively | Most "native" feel | Large effort, duplicates an already complete i18n UI, two UIs to maintain | Rejected |

Rationale: the UI already exists and is complete; the only problem is the
window it opens in. Edge `--app` gives a real desktop window (own taskbar
button, no tabs/address bar) with zero added dependencies and an isolated
profile, so it never mixes with the user's daily Edge session.

---

## 4. Implementation

### 4.1 New file: `scripts/console.ps1`

```
Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/console.ps1 [-Port 8420]
```

Behavior:

1. Builds the control-center URL `http://127.0.0.1:<Port>/`.
2. Locates Edge at the two standard install locations
   (`%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe`,
   `%ProgramFiles%\Microsoft\Edge\Application\msedge.exe`), first hit wins.
3. If Edge is found, launches it with:

   ```
   --app=<url>                      # app window: no tabs, no address bar
   --user-data-dir=%LOCALAPPDATA%\FastCUA\console-profile
                                    # isolated profile: cookies/extensions/sign-in
                                    # never collide with the user's Edge
   --no-first-run                   # skip first-run dialogs in the new profile
   --window-size=1180,860           # sensible default for the console layout
   ```

4. If Edge is absent (e.g. Chrome-only machines), falls back to
   `Start-Process <url>` (default browser), preserving the old behavior.

Notes:

- `--user-data-dir` is the critical flag: without it the app window would
  share the user's real Edge profile (their tabs, logins, extensions). The
  isolated profile dir lives under `%LOCALAPPDATA%\FastCUA\console-profile`.
- The script is idempotent-ish: Edge reuses an existing app window for the
  same URL rather than spawning unlimited windows (Edge dedupes app windows
  by URL within the same user-data-dir).

### 4.2 Modified: `overlay.ps1` — `Open-Settings()`

Before:

```powershell
Start-Process "$base/" | Out-Null          # browser tab
```

After:

```powershell
$consoleScript = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "scripts\console.ps1"
if (Test-Path $consoleScript) {
  Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$consoleScript`"",
    "-Port", $Port
  ) -WindowStyle Hidden | Out-Null
} else {
  Start-Process "$base/" | Out-Null
}
```

Key points:

- The overlay already receives the daemon's **actual** port as `-Port`
  (`daemon.mjs` spawns overlay with `-Port String(config.port)`), so the
  console window is always pointed at the right endpoint — including the
  dev-checkout dynamic port case.
- `-WindowStyle Hidden` prevents a transient console window flashing before
  Edge appears; the PowerShell launcher exits immediately after `Start-Process`.
- The `Test-Path` guard keeps the old browser fallback if the script is ever
  missing from a packaged runtime.

### 4.3 Documentation: `README.md` / `README_zh.md`

The "Local control center" line now mentions F7 opens a standalone window and
shows the manual invocation for people who want to run it themselves.

---

## 5. Verification

Performed on this machine (Windows, Edge + WebView2 Runtime present):

| Check | Result |
|---|---|
| `scripts/console.ps1 -Port 18723` (dev-checkout dynamic port) launches Edge app window | ✅ msedge processes spawn with `--app=` |
| `GET http://127.0.0.1:18723/` returns web.html | ✅ HTTP 200, ~40 KB |
| overlay `Open-Settings` path resolves `scripts\console.ps1` relative to overlay's own dir | ✅ |
| Browser fallback branch (no Edge) — code path reviewed, not executed (Edge present) | — |

Note: the dev checkout uses a path-scoped port (`18723` here); the installed
release uses `8420`. Both are handled because the port is threaded through
daemon → overlay → console.ps1.

---

## 6. Limitations & follow-ups

- **Edge-only for the "real window" path.** Chrome/Firefox would fall back to
  a normal browser tab. A WebView2 shell (option A) is the natural upgrade if
  a dependency on the WebView2 SDK becomes acceptable; everything else in
  this design stays the same (same-origin URL, isolated profile).
- **Window geometry** is a fixed `1180×860`; no persistence of size/position.
  Could be added later by reading/writing a small state file under
  `%LOCALAPPDATA%\FastCUA`.
- **Multiple instances**: Edge dedupes app windows per URL+profile, but if a
  stale daemon is on a different port, a second window could appear. Acceptable.
- The isolated profile accumulates cookies/site data over time; harmless for a
  loopback-only app, but could be periodically cleared.

---

## 7. Security notes

- The window only ever talks to `127.0.0.1:<port>`; no remote content.
- The daemon's existing protections are unchanged and still apply:
  loopback bind, CSP `connect-src 'self'`, trusted-origin POST check,
  `X-Frame-Options: DENY`.
- The isolated Edge profile contains no user credentials (fresh profile), so
  it cannot leak or reuse the user's real browsing identity.
