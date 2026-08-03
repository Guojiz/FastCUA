# FastCUA Technical Implementation

Comprehensive technical report for the whole software: architecture, components,
protocols, security model, the skill recorder subsystem, runtime identity and
release machinery, testing, and CI/CD. Companion to
[`control-center-window.md`](control-center-window.md) (standalone console window)
and [`skill-recorder-design.md`](skill-recorder-design.md) (recorder design notes).

- [1. Overview](#1-overview)
- [2. System architecture](#2-system-architecture)
- [3. Component deep dive](#3-component-deep-dive)
- [4. Communication protocols](#4-communication-protocols)
- [5. The skill recorder subsystem](#5-the-skill-recorder-subsystem)
- [6. Security model](#6-security-model)
- [7. Runtime identity, updates, and release](#7-runtime-identity-updates-and-release)
- [8. Testing](#8-testing)
- [9. CI/CD](#9-cicd)
- [10. Boundaries and known limitations](#10-boundaries-and-known-limitations)

## 1. Overview

FastCUA turns Windows GUIs into a fast, executable interface for AI agents. It is
a local-first Computer Use runtime with these defining properties:

- **Accessibility first, vision optional** — navigation prefers Windows UI
  Automation (UIA) text; screenshots and visual grid targeting are used only
  when pixels add information.
- **One warm control plane** — all agent clients share one resident daemon and
  one native host (one cursor). Window identity, approvals, pause, and
  interjection live in the control plane, not per click.
- **Many actions per model turn** — through MCP the agent gets a persistent JS
  environment (`sky.*`) where related keyboard, text, click, drag, and scroll
  work run sequentially in a single turn.
- **Safe by default, local by design** — unknown apps require human approval in
  safe mode; the console binds to loopback only; policy stays on the machine.

The runtime ships as a versioned Windows package: the MCP server, the daemon,
the compiled Rust native host, the WPF overlay, the web control center, the
skill recorder toolchain, and the complete Skills. A thin npm CLI (`fastcua`)
bootstraps installation; the real runtime is downloaded from the GitHub Release
and SHA-256 verified.

## 2. System architecture

```
Agent + computer-use Skill (any vendor client)
  │  stdio MCP (JSON-RPC, newline-delimited)
  ▼
server.mjs  "sky-computer-use"  (Node, per-client)
  │  named pipe: \\.\pipe\fastcua-<rootHash12>
  ▼
daemon.mjs  control plane (Node, single resident)
  │  stdio JSONL (newline-delimited)
  ▼
cua-native-host.exe (Rust, single shared helper)
  ├─ UI Automation (raw COM, hand-written bindings)
  ├─ Screenshot / grid overlay (GDI + PrintWindow/BitBlt)
  └─ SendInput keyboard & mouse
daemon.mjs also owns:
  ├─ Policy · pause · approval · interject
  ├─ HTTP console  http://127.0.0.1:<port>  (web.html, loopback only)
  └─ overlay.ps1 + card.xaml  (WPF dynamic island, F7/F8/F9/F10)
```

| Layer | Role | Who reads it |
|---|---|---|
| Skill `skills/computer-use/` | How to run a desktop task (bootstrap, tags, grid, safety) | Agent only |
| MCP `server.mjs` | Tools + persistent `js`/`sky` | Agent tools |
| Daemon + native host | Shared lifecycle, UIA, screenshots, input, policy | Runtime |
| README / self-host docs | Product + install for people | Humans |
| Overlay / console | Pause, approval, interject UI | Humans |

Data flow of a single action: the agent calls an MCP tool (or runs a JS cell) →
`server.mjs` forwards the request over the named pipe to the daemon → the daemon
checks approval/pause/interrupt state and forwards over stdio to the native
host → the host performs the Windows operation and returns a JSON result →
each hop carries a 30 s budget; a wedged UIA provider times out at ~1.5 s
inside the host without blocking the shared helper.

## 3. Component deep dive

### 3.1 MCP server — `server.mjs` (~814 lines)

- **Hand-written stdio JSON-RPC 2.0**; no MCP SDK. `process.stdin` is read
  line-by-line (newline-delimited JSON, not LSP Content-Length framing).
  Supports `initialize` (protocolVersion `2024-11-05`, capabilities `{tools:{}}`,
  serverInfo `sky-computer-use`), `initialized`, `tools/list`, `tools/call`;
  unknown methods return `-32601`, internal errors `-32603`.
- **Two daemon connections**: `DaemonClient` on the named pipe
  `runtimePipe(HERE)` for tools, plus a second `replDaemon` for the JS REPL.
  If the daemon is not running and `costartMode !== "manual"`, the server
  spawns `node daemon.mjs` detached and retries the pipe connection up to
  40 × 350 ms (~14 s cold-start budget).
- **MCP tools** (17): `runtime_info`, `list_apps`, `list_windows`,
  `get_window`, `launch_app`, `get_window_state`, `click`, `press_key`,
  `type_text`, `scroll`, `set_value`, `drag`, `perform_secondary_action`,
  `activate_window`, `close`, `js`, `grid_view`.
- **`js` REPL**: `vm.createContext` + `vm.Script` with a 30 s default budget
  (`FASTCUA_JS_TIMEOUT_MS` overrides). `AsyncLocalStorage` tracks the current
  cell; `trackedSetTimeout/Interval` bind timers to the cell lifecycle; ending a
  cell cancels in-flight `sky` calls (`cancelOwner`) so detached desktop side
  effects never land late. Image output is deliberately minimal — `grid_view`
  emits one annotated image; `get_window_state` returns all screenshots.
- **`sky` client helpers**: `sky.viewport(state)`, `sky.grid(...)` (Apple-style
  square packing; refine forces 3×3), `sky.grid_cell(grid, id)`. Click-safety
  mode: `grid_view` (select ≠ click) → `grid_refine` (crop drill-down) →
  `click_cell` (cell center) / `click_in_cell` (cell-local, out-of-bounds
  rejected) / `click_view` (point in view image, out-of-bounds rejected).
- **Client groups**: each server process generates a `CLIENT_GROUP =
  randomUUID()` sent with pipe requests, so interrupt latching and one-shot
  interjection are shared per client group.
- `close` closes both daemon connections and exits; the shared daemon stays up.

### 3.2 Resident daemon — `daemon.mjs` (~996 lines)

- **HTTP server**: Node built-in `node:http`, listening on `127.0.0.1` only.
  Port: `config.port` → `runtimeDefaultPort()` (release `8420`; development
  `18000 + (rootHash first 4 hex % 1000)`; `FASTCUA_HTTP_PORT` overrides).
- **Security headers on every response**:
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and
  `Content-Security-Policy: default-src 'self'; style-src 'unsafe-inline';
  script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:`.
- **POST origin check** (`trustedMutationOrigin`): no Origin header (e.g. curl)
  is trusted; with an Origin header it must be `http:` + hostname
  `127.0.0.1`/`localhost` + the daemon's own port, else `403 untrusted request
  origin`. POST bodies are size-capped (64 KB config, 16 KB actions).
- **API surface**:

  | Endpoint | Method | Purpose |
  |---|---|---|
  | `/`, `/index.html` | GET | `web.html` control center |
  | `/api/state` | GET | clients, `binaryPid`, `approvedApps`, `pendingApprovals`, `approvalPolicy`, `controlState`, uptime, runtime identity, update state, recent logs |
  | `/api/config` | GET/POST | read/update config; policy/whitelist changes clear `approvedApps`; costart changes rewrite the Run key |
  | `/api/skill-writer/config` | GET/POST | skill-writer subagent config; API key stored separately, POST returns only `hasApiKey`/last-4 hint — never the plaintext |
  | `/api/events?since=N` | GET | polling event stream (not SSE): events with `id > since`, plus `inflight`, `pendingApprovals`, `controlState` |
  | `/api/action` | POST | `killBinary`, `clearApprovals`, `pause`, `resume`, `allowOnce`, `allowAndWhitelist`, `alwaysApprove`, `fullAccess`, `denyApproval`, `restart`, `shutdown`, `stopAll` |
  | `/api/interject` | POST | inject interjection text (≤ 2000 chars); atomically cancels in-flight work, latches one instruction, auto-resumes |

- **Event model**: in-memory ring of 200 events; types `action_start`,
  `action_end`, `approval_required`, `approval_allowed`, `approval_denied`,
  `paused`, `resumed`, `interjection`, `interrupt`, `policy`, `shutdown`.
  The overlay polls `/api/events?since=` every 2 s.
- **Native host lifecycle**: binary discovery order — `config.cuaBinPath` →
  `CUA_BIN` env → local candidates (`native-host/target/release/`,
  `helper/`, repo root). Spawned with
  `--parent-pid <daemon pid>` so the host exits when the daemon dies, and with
  `FASTCUA_HOME`/`CODEX_HOME` pointed at the runtime data dir. One shared
  helper; a 30 s request budget; on timeout the daemon kills the whole tree
  (`taskkill /PID <pid> /T /F`) and resets (`resetBinary`). An exit guard
  (`proc !== child`) prevents stale exit callbacks from clearing the new
  generation's pending requests.
- **UIA quality profile**: persisted to `uia-profile.json` (30-day TTL),
  cleared on helper restart; known-bad apps get a 300 ms short probe.
- **Approval flow**: host responses may carry an `approvalRequest` → the daemon
  auto-allows if the app is whitelisted or policy is `full` (cached in
  `approvedApps`); otherwise a `pendingApprovals` entry is created with a
  `crypto.randomUUID()` token and a 60 s timeout (auto-deny). Decisions:
  `allow_once` / `allow_and_whitelist` (persists to the whitelist) /
  `full_access` (switch policy + allow all pending) / `deny`.
  Metadata keys `x-fastcua-approved-app` / `x-fastcua-request-budget-ms` are
  written alongside legacy `x-oai-cua-*` keys for compatibility.
- **Interrupts**: files written to
  `<dataDir>/cache/computer-use/interrupts/<session>/<turn>`; the agent sees
  prefixed error messages. Control-plane tags (agent contract):
  `[control_plane:stopped]`, `:paused`, `:shutdown`, `:awaiting_approval`,
  `:interjection` (the only "instruction", auto-resumes).
- **Co-start**: writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
  value name `FastCUA` (release) or `FastCUA-dev-<hash>` (development) so
  multiple installs coexist.
- **Overlay launch**: `spawn("powershell.exe", ["-NoProfile","-ExecutionPolicy",
  "Bypass","-WindowStyle","Hidden","-File", overlay.ps1, "-Port", port, ...])`
  when `overlayEnabled && FASTCUA_DISABLE_OVERLAY !== "1"`; stderr → overlay.log;
  process is `unref()`ed.

### 3.3 Native host — `native-host/` (Rust)

| File | Responsibility |
|---|---|
| `src/main.rs` (~290 lines) | DPI awareness, `--parent-pid` watchdog thread, overlay launch, stdin JSON dispatch, approval validation, interrupt file checks |
| `src/desktop.rs` (~2530 lines) | all desktop capability: window enum/launch/activate, UIA snapshot coordination, screenshots, grid, input |
| `src/uia.rs` (~820 lines) | hand-written raw COM bindings (no `windows` crate): snapshots, point-hit, focused-value read/write |
| `src/win32.rs` (~410 lines) | kernel32/user32/gdi32/shell32 FFI declarations |
| `src/overlay.rs` (~163 lines) | cursor glow overlay (GDI layered window, pulsing ring) |

- **Dependencies**: `base64`, `jpeg-encoder`, `serde`, `serde_json` only —
  no `windows`/`winapi` crates; all FFI is hand-written (COM called by vtable
  slot numbers via transmute). Release profile: `codegen-units=1, lto=true,
  opt-level="z", panic="abort", strip=true` for minimal size.
- **UIA**: `CoInitializeEx(MULTITHREADED)`; snapshots run on a dedicated thread
  with `recv_timeout(1500 ms)` so a wedged provider never blocks the host; that
  app's UIA is disabled for the session and calls fall back to the HWND tree
  with `uia.prefer_vision: true`.
- **Input**: `SendInput` (`INPUT`/`KEYBDINPUT`, Unicode text via
  `KEYEVENTF_UNICODE`), `SetCursorPos` + `SendInput` clicks, `keybd_event`
  chords. Every input is preceded by `MOVE_SETTLE_MS = 50` and
  `ensure_foreground_window` / `ensure_cursor_position` checks against
  drift-induced misclicks.
- **Window activation**: `ShowWindow` + `AttachThreadInput` +
  `BringWindowToTop` + `SetForegroundWindow`, retried 10 × 10 ms within a 1.5 s
  budget.
- **Screenshots**: `PrintWindow(PW_RENDERFULLCONTENT)` first, `BitBlt`
  (`SRCCOPY|CAPTUREBLT`) fallback for hung windows; BGRA→RGB; box-averaged
  downscale to `max_edge` (default 1568); FNV-1a `frame_hash` with 2 s TTL
  dedupe (`unchanged: true` reuses the previous image).
- **Grid targeting**: pure square packing, 5×7 bitmap digits drawn as
  semi-transparent outlined cells; refine forces 3×3.
- **No OCR**: visual targeting relies on UIA quality assessment plus the
  numbered square grid — this keeps the host dependency-free.
- **Communication**: stdin/stdout newline-delimited JSON
  `{id, method, params, meta}`; responses `{id, ok:true, result}` or
  `{id, ok:false, error}` or `{id, ok:false, approvalRequest}`. Method
  whitelist matches the MCP tools.
- **Per-call budgets**: UIA 1.5 s, activation 1.5 s, screenshot 3 s,
  WM_GETTEXT 300 ms, point-hit 800 ms. `FASTCUA_TEST_FORCE_UIA_FALLBACK=1`
  forces the HWND fallback for tests.

> Deep dive: how the host actually drives Windows — raw-COM UIA bindings and
> vtable slots, snapshot algorithm, hang protection, input injection timing,
> window activation, capture/dedupe, square-grid packing and CPU-pixel
> rendering, DPI coordinate contract, main-loop safety gates, and the
> concurrency model — see
> [`windows-control-internals.md`](windows-control-internals.md) (EN) /
> [`windows-control-internals_zh.md`](windows-control-internals_zh.md) (ZH).

### 3.4 Overlay island — `overlay.ps1` + `card.xaml`

- WPF dynamic island hosted by PowerShell (`Add-Type` on
  `PresentationFramework`), loaded from `card.xaml`.
- Global hotkeys via `RegisterHotKey`: `F7` pause + open control center,
  `F8` pause/resume, `F9` pause then interject, `F10` exit (agents must not
  self-restart).
- Polls `/api/state` + `/api/events?since=` every 2 s and reflects state color:
  active (compact island + click-through border), approval (amber, keys
  `1` once / `2` always / `3` full access / `4` deny), full access
  (purple/pink), paused (red).
- Settings button / F7 now opens the control center as a **standalone window**
  via `scripts/console.ps1` (Edge `--app` mode) instead of a browser tab.

### 3.5 Web control center — `web.html` (~424 lines)

- Single-page control center served by the daemon at `http://127.0.0.1:<port>/`
  (loopback only), Chinese/English bilingual, no build step.
- Same-origin `fetch('/api/...')` under the CSP above; interactive sections:
  runtime status, pending approvals (approve once/whitelist/full access/deny),
  activity timeline (polled events), settings (config + skill-writer
  subagent), update banner.

### 3.6 Skill layer — `skills/`

- `skills/computer-use/` — the single agent operating manual (SKILL.md +
  docs/api.md + guidance.md + confirmations.md). `allowed-tools:
  mcp__sky-computer-use mcp__sky-computer-use__*`. Mandates: bootstrap by
  listing apps/windows once, work through the MCP `js` tool + persistent `sky`
  object, never spawn the native host directly nor fall back to
  PowerShell/pyautogui, end each turn with `close`. Contains the
  `uia.quality/prefer_vision` decision table and the `[control_plane:*]` tag
  behavior mapping.
- `skills/skill-recorder/` — the seven-tool recorder playbook
  (record → compile → synthesize → lint → dry-run → frame-extract → promote)
  with safety invariants (never rebuild password/secure-desktop content,
  promotion always requires explicit approval, dry-run goes through the
  FastCUA control plane).

## 4. Communication protocols

| Hop | Transport | Framing | Authenticity |
|---|---|---|---|
| Agent ↔ MCP | stdio | JSON-RPC 2.0, newline-delimited JSON | pipe owner + local config |
| MCP ↔ daemon | named pipe `\\.\pipe\fastcua-<rootHash12>` | JSON-RPC-style `{id, method, params}` | pipe name is install-path-scoped |
| daemon ↔ native host | stdio | newline-delimited JSON `{id, method, params, meta}` | `--parent-pid` watchdog; approval tokens in `meta` |
| daemon ↔ web/overlay | HTTP loopback | REST JSON + polling `?since=` | Origin check + CSP; no auth token needed because loopback-only |

The named pipe name is derived from the canonical install root
(`sha256` prefix 12 hex), so every runtime root gets its own pipe — a
development checkout can never attach to an installed daemon.

## 5. The skill recorder subsystem

A standalone "record a skill" tool (issue #3, stages 2–5), modeled on Claude
Cowork's *Record a skill*. The user demonstrates a workflow on the real desktop
while narrating; the tool produces a **non-executable, explicitly unverified**
evidence package; a separately configured, tool-less subagent writes
natural-language `SKILL.md`; provenance lint rejects unsupported prose.

| Piece | Path | Responsibility |
|---|---|---|
| recorder (native) | `tools/skill-recorder/` (Rust, single file ~3300 lines) | capture |
| evidence compiler | `compile.mjs` | deterministic evidence + replay draft |
| dedicated writer | `synthesize.mjs` | natural-language Skill prose |
| provenance lint | `lint-skill.mjs` | reject missing/fabricated evidence |
| dry-run | `dryrun.mjs` | replay acceptance evidence |
| frame extractor | `frame-extract.mjs` | visual review aid |
| gated promotion | `promote.mjs` | owner-approved installation |

**Capture engine (Rust)**:
- Low-level hooks `WH_KEYBOARD_LL` + `WH_MOUSE_LL` + `SetWinEventHook(EVENT_OBJECT_FOCUS)`;
  hook callbacks stream to a writer thread that flushes `session.jsonl` line by
  line (a killed recorder still leaves a readable partial session).
- **Session format `fastcua-recording/1`**: line 0 header (tool version,
  machine context, redaction policy, hotkey map); then `key_down/up`,
  `mouse_down/up/move`, `wheel_*` (with `injected`/`lower_il` provenance and
  foreground window bounds; moves sampled ≤ 1/40 ms), `focus_change`/`heartbeat`
  (UIA snapshot of focused element incl. `is_password`, value class),
  `keyframe` (sparse JPEG q75, reasons `note`/`action`/`focus`/`periodic`,
  or `suppressed:true`), `note` (Ctrl+Alt+N dialog), `media` (audio track
  availability), `stats` (hook health + media counters).
- **Anchors**: pointer down/up do `ElementFromPoint` at both endpoints
  (300 ms bounded worker); keystrokes attach the most recent focus snapshot
  (≤ 800 ms → `confidence:"high"`, ≤ 2000 ms → `"low"`). Anchors carry
  `value_class` and, for text controls, a bounded `WM_GETTEXT` snapshot.
  **Typed text is only recovered from UIA/value snapshots — vk codes are never
  reverse-mapped to characters** (the redaction boundary).
- **Redaction**: password fields (UIA `IsPassword` **or** `ES_PASSWORD`) drop
  vk and value, mark `redacted:"password-field"`, record `suppressed:true`
  keyframes, and replace video frames with marker black frames logged as gaps
  (`reason:"password-focus"`). Secure desktop is detected via `OpenInputDesktop`
  (non-"default" → silent).
- **Media tracks**: hand-written RIFF MJPEG-in-AVI writer (zero dependency),
  full-screen `BitBlt`+`StretchBlt` HALFTONE downscale ≤ 1568, 4 fps default,
  `video/index.jsonl` for random frame access; WASAPI shared-mode capture
  PCM 16 kHz mono 16-bit → `audio/narration.wav` with graceful degradation
  (`t:media` note) when no microphone.
- **Hotkeys**: `Ctrl+Alt+N` note, `Ctrl+Alt+R` pause, `Ctrl+Alt+X` emergency
  stop. The recorder declares Per-Monitor-V2 DPI awareness so hooks,
  `ElementFromPoint`, and UIA bounds share one physical-pixel coordinate space.

**Compile** (`compile.mjs`): `session.jsonl` → canonical `evidence.json`/`md`
(non-executable) + deterministic `draft.json`/`md` (replay artifact) +
`synthesis-request.json` (for the writer). Key logic: `buildSteps` (type-run
merging, redacted-run marking, pointer-gesture click-vs-drag classification,
wheel as independent steps), `inferParameters` (date/filename/text
parameterization `{{param}}` with provenance), `sessionWarnings` (`⚠ unresolved`).
Snapshot selection prefers the fullest in-flight UIA value when a Windows
save dialog strips the directory path into the address bar on Tab (fixed in
`a1c8077`). **The compiler never writes SKILL.md.**

**Synthesize** (`synthesize.mjs`): OpenAI-compatible `chat/completions`,
optionally feeding the WAV directly as `input_audio` or via
`audio/transcriptions`; `audioMode: auto|direct|transcribe|typed` fallback
chain (`typed` keeps audio local). The API key lives separately
(`skill-writer-auth.json`, mode 0600, or env var). Output is linted before
atomic write.

**Lint** (`lint-skill.mjs`): frontmatter name/description/`verified:false`,
≤ 200 lines, mandatory Safety/Scope sections, every step/param/warning must
carry an `[evidence:*]` citation (fabrication rejected), no embedded base64
media, explicit user-approval boundary required.

**Dry-run** (`dryrun.mjs`): replays `draft.json` through the real control plane
(named pipe) with a **new parameter value**; UIA anchors resolve fresh, and
approval/pause stay fully active. Exit codes: 0 ok / 2 usage / 3 decisions
needed / 4 fail-safe abort / 5 control-plane stopped. `decisions.json`
acknowledges session warnings and per-step proceed/skip; out-of-bounds,
unresolvable anchors, and value mismatches abort safely. Redacted steps never
execute.

**Frame extract** (`frame-extract.mjs`): slices a single JPEG out of the AVI by
`off/len` with SOI/EOI validation; exits 4 on redaction gaps.

**Promote** (`promote.mjs`): gates — `--yes-i-reviewed`, `verified:false`
requires `--force-unverified`, existing target requires `--overwrite`;
`--detect-host` finds the active host Skill directory
(`FASTCUA_SKILLS_DIR` → Kimi Work → Claude Code → opencode). Nothing installs
silently.

End-to-end validated on the live machine by `tests/skill-recorder-validation.mjs`
(112 checks) and `tests/office-demo-e2e.mjs` (real Excel: record → compile →
dry-run with substituted parameters → openpyxl cell verification).

## 6. Security model

- **Network surface**: HTTP binds `127.0.0.1` only; strict Origin check on
  mutations; CSP `connect-src 'self'`; `nosniff`/`DENY`/`no-referrer` headers;
  body size caps. No HTTP auth token — loopback + origin validation is the
  boundary.
- **Approval & trust**: safe mode requires human approval for unknown apps;
  whitelist matches **exact** executable paths/names (never fuzzy substring);
  approval tokens are `crypto.randomUUID()`, auto-deny after 60 s; approval
  state is cached per session (`approvedApps`) and cleared on policy changes.
  Common local tools ship on a default whitelist that only skips the prompt —
  Skill safety bans (terminals, password managers, security UI) still apply.
- **Human control**: F7 pause+console, F8 pause/resume, F9 interject, F10 exit;
  interjections atomically cancel in-flight work and latch one instruction.
- **Redaction**: recorder never reverse-maps key codes to characters; password
  fields drop vk/value and suppress keyframes and video (marker frames);
  secure desktop is silently skipped; recorder's own windows are excluded from
  the event stream.
- **Version isolation**: pipe name, development HTTP port, data directory, and
  Run key are all derived from the canonical install root hash — multiple
  installs (dev checkout vs release) cannot attach to each other.
- **Supply chain**: every release asset is SHA-256 verified (zip + per-file
  manifest); the updater keeps `app.previous` for rollback and never overwrites
  a development checkout; development builds never phone home for updates.
- **Credential hygiene**: skill-writer API key stored separately
  (`~/.fastcua/skill-writer-auth.json`, 0600) and never returned by the API
  (only `hasApiKey`/last-4 hint).

## 7. Runtime identity, updates, and release

- **Runtime identity** (`lib/runtime.mjs`): `runtimeRootHash(root)` =
  `sha256(canonicalRoot)` prefix 12 hex; `runtimePipe(root)` =
  `\\.\pipe\fastcua-<hash>`; `runtimeDataDir` = `FASTCUA_HOME` >
  `FASTCUA_CACHE_DIR` > dev `root/.fastcua` > release `%LOCALAPPDATA%\FastCUA\data`;
  `runtimeDefaultPort` = release 8420 / dev `18000 + hash%1000`;
  `runtimeInfo` merges manifest + root/pipe/dataDir/configPath/port/pid.
  `compareVersions` implements semver (+prerelease) ordering.
- **Update check** (`lib/update-check.mjs`): state machine
  `development → disabled → cached(24 h) → available/current → error`; GitHub
  `releases/latest` with 8 s AbortController timeout; atomic write of
  `update-state.json` (tmp + rename). Installed releases check at most once a
  day and only notify.
- **Install / update / rollback** (`scripts/manage.ps1`, ~445 lines):
  - `Ensure-Node`: `winget install --id OpenJS.NodeJS.LTS --silent` when needed.
  - `Get-LatestRelease`: GitHub API `releases/latest` or a pinned tag.
  - `Assert-Runtime`: `runtime-manifest.json` schema (schemaVersion 1,
    platform win32-x64) + per-file SHA-256 verification.
  - `Get-ReleaseRuntime`: download zip + `SHA256SUMS.txt`, verify, extract,
    re-assert.
  - `Install-Runtime`: stop the installed daemon (`POST /api/action` shutdown)
    → move `app` → `app.previous` → stage the new package → write
    `install-state.json`; on failure restore `app.previous` (automatic
    rollback).
  - `Write-DesktopFiles`: desktop `FastCUA Console.url` + `FastCUA Agent
    Setup.txt` (the prompt that teaches the agent to install Skill + MCP).
  - `Invoke-Doctor`: checks installed runtime, scans AI client configs for
    `server.mjs` paths (`.codex/config.toml`, `.claude.json`, VS Code
    `mcp.json`, `repos/.mcp.json`), checks the live daemon's root matches,
    detects multiple daemons.
- **Thin npm CLI** (`bin/fastcua.mjs`): subcommands `install`/`update`/`check`/
  `doctor`/`version`/`help`; non-win32 refuses; each action spawns
  `powershell.exe ... manage.ps1 -Action <Action>`. The npm package ships only
  the CLI + `manage.ps1` + manifest — **not** the runtime; the runtime is
  downloaded and verified from the GitHub Release.
- **Release pipeline** (`scripts/build-release.ps1`): `cargo build --release
  --locked` for both Rust crates → copy the fixed file list to a stage dir →
  write `runtime-manifest.json` (version/channel/buildType/commit/buildTime/
  defaultPort + per-file SHA-256) → `Compress-Archive` to
  `dist/fastcua-runtime-win-x64.zip` → `SHA256SUMS.txt`.
- **Release package** (v0.3.0, commit 74c15bc, 30 files): `daemon.mjs`,
  `server.mjs`, `web.html`, `card.xaml`, `overlay.ps1`, `config.json`,
  `lib/runtime.mjs`, `lib/update-check.mjs`, `helper/cua-native-host.exe`,
  `install.ps1`, `uninstall.ps1`, `scripts/{manage,console}.ps1`, LICENSE,
  README(EN+ZH), complete `skills/computer-use/` and `skills/skill-recorder/`
  (SKILL.md + docs), and `tools/skill-recorder/` (`compile`, `dryrun`,
  `frame-extract`, `lint-skill`, `promote`, `synthesize`,
  `writer-config`.mjs + `target/release/skill-recorder.exe`). No git history,
  tests, recordings, logs, API keys, or credentials.

## 8. Testing

| Suite | What it verifies |
|---|---|
| `real-machine-validation.mjs` (65 checks) | real-machine: UIA path (Notepad/fixture edit readback), vision screenshots + `grid_view`, frozen app A/B/C (wedged UIA fast-fail, killed window, disconnect recovery), 5 click modes, dedupe, UIA profile short probe + recovery |
| `skill-recorder-validation.mjs` (112 checks) | real-machine recording of a fixture demo (incl. password redaction, injected annotation) → compile assertions → media tracks (AVI/index/WAV) → frame-extract redaction gate → promote gates (reject/force/overwrite) |
| `office-demo-e2e.mjs` (23 steps) | real Excel full chain: record (start page → workbook → 3 notes → SUM → F12 save-as) → compile → dry-run with **different** parameter values → openpyxl asserts the new values actually landed in cells |
| `approval-lifecycle.mjs` | drives the native host directly: launch triggers `approvalRequest` → retry with `x-oai-cua-approved-app` → close lifecycle |
| `control-plane-integration.mjs` (12 checks) | cross-origin POST 403, pause/resume, disconnect cancels in-flight, approval deny/allowOnce/allowAndWhitelist/fullAccess, orphan approval revocation, one-shot interjection, clientGroup |
| `runtime-identity-integration.mjs` | daemon `runtime_info` root/version/pipe/port/dataDir/nativeHost consistency |
| `runtime-release-contract.mjs` | dev/release isolation (pipe/port/data dir differ), four-component version consistency, update-check cache + dev never phones home |
| `protocol-regression.mjs` | native-host protocol: env precedence (`FASTCUA_HOME`/`CACHE_DIR`/`CODEX_HOME`), request/response shape |
| `fallback-regression.mjs` | `FASTCUA_TEST_FORCE_UIA_FALLBACK=1` HWND-tree fallback still works |
| `server-lifecycle.mjs` | mock daemon pipe drives `server.mjs`: MCP tool → sky → pipe method mapping, JS REPL, close behavior |
| `skill-writer-contract.mjs` | writer config normalization, key isolation, public view, synthesize env overrides, lint gate |
| `installer-contract.mjs` | static assertions of contract strings in install/manage/build-release/uninstall/config/web.html |
| `paint-drawing.mjs` | launches Paint, draws through the pipe protocol, outputs an audit JPG |

Support: `tests/Fixture.cs` + `build-fixture.ps1` (C# Win32 test fixture with
EDIT/BUTTON/LISTBOX/trackbar/ES_PASSWORD controls), `run-control-plane.ps1`
(spins up the daemon on a temp port/pipe/config, runs
control-plane-integration, shuts down).

## 9. CI/CD

- **`ci.yml`** (push main / PR, `windows-latest`): rust-toolchain@stable +
  setup-node@v4 (node 22). Static checks: `cargo fmt --check` +
  `cargo test --locked` for both crates, `node --check` on all `.mjs`,
  `[scriptblock]::Create` syntax check on all `.ps1`, `card.xaml` XML
  validation. Tests: installer-contract, runtime-release-contract,
  runtime-identity-integration, server-lifecycle; then build fixture + release
  build + approval-lifecycle. Best-effort real-machine regressions
  (`continue-on-error`): fallback-regression, protocol-regression.
- **`release.yml`** (tag `v*`, `permissions: contents: write`): enforces the
  **four-way version match** — tag must equal `runtime-manifest.json`,
  `package.json`, `native-host/Cargo.toml`, `tools/skill-recorder/Cargo.toml` —
  runs static checks + `build-release.ps1 -Version <tag> -Commit <sha>`,
  publishes 4 assets (`fastcua-runtime-win-x64.zip`, `SHA256SUMS.txt`,
  `runtime-manifest.json`, `install.ps1`), and `npm publish --access public`
  when `NPM_TOKEN` is configured.

## 10. Boundaries and known limitations

- Windows 11 x64 only. Secure Desktop, UAC elevation, auth dialogs, password
  managers, and Windows security UI are outside the normal path.
- Apps with little accessibility data need screenshot/grid targeting; element
  indexes belong to the latest UIA snapshot and must be refreshed after layout
  changes.
- No OCR inside the host — vision targeting is grid-based by design.
- The standalone console window is Edge `--app`-based (WebView2 managed DLLs
  were not available offline), window size is not persisted, and multi-instance
  behavior of the window is not yet managed (see
  [`control-center-window.md`](control-center-window.md)).
- The npm CLI is not yet published; README `npx fastcua` commands work only
  after `npm publish` (the release workflow is ready when `NPM_TOKEN` is set).
- The skill recorder is a validated preview: all end-to-end validation input so
  far is automation-injected; a short human-input comparison session is still
  owed.
- Hung target apps: UIA disabled per session, screenshots keep working via
  BitBlt, cross-process window text never blocks the host — a full helper
  restart is the last resort, not the default.
