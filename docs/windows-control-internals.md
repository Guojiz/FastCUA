# FastCUA Windows Control Internals

How the native host actually drives Windows: UI Automation navigation, input
injection, window activation, screenshot capture, visual grid targeting, DPI
coordinate spaces, hang protection, and the safety gates in the main loop.
All facts below are read from the source (`native-host/src/`); line numbers
refer to `main.rs`, `desktop.rs`, `uia.rs`, `win32.rs`, `overlay.rs` at commit
`d0613e9`.

- [1. The control chain at a glance](#1-the-control-chain-at-a-glance)
- [2. UI Automation](#2-ui-automation)
- [3. Input injection](#3-input-injection)
- [4. Window management](#4-window-management)
- [5. Screenshots and the visual grid](#5-screenshots-and-the-visual-grid)
- [6. DPI and the coordinate contract](#6-dpi-and-the-coordinate-contract)
- [7. Main loop and safety gates](#7-main-loop-and-safety-gates)
- [8. Concurrency and resource model](#8-concurrency-and-resource-model)
- [9. Engineering trade-offs worth knowing](#9-engineering-trade-offs-worth-knowing)

## 1. The control chain at a glance

Every request travels
`daemon (JSONL over stdio) → main.rs → dispatch → desktop.rs/uia.rs → Win32 API`.
The host is a single shared process (one cursor). Three design constraints
shape everything below:

1. **Every cross-process call is bounded.** UIA snapshot 1.5 s, activation
   1.5 s, capture 3 s, WM_GETTEXT 300 ms, point-hit 800 ms — a wedged app may
   degrade but never hang the host.
2. **Coordinates are physical pixels of the target window's screenshot.**
   DPI awareness is declared up front so `GetWindowRect`, UIA bounds,
   `PrintWindow` bitmaps, and click coordinates all live in one space.
3. **Input is injected through the same APIs a human uses**
   (`SendInput`/`keybd_event`/`SetCursorPos`), never synthetic window
   messages — dialogs and DirectUI controls ignore synthesized `BM_CLICK`
   but accept real input.

## 2. UI Automation

### 2.1 Hand-written COM bindings (no `windows` crate)

The host talks COM at the ABI level. `method<T>(object, index)`
(`uia.rs:773-777`) reads the vtable pointer from the object, indexes slot
`index`, and `mem::transmute_copy`s the function pointer to the target
signature. Slots are hard-coded and were validated empirically:

| Interface | Slot | Method |
|---|---|---|
| IUnknown | 0 / 2 | QueryInterface / Release |
| IUIAutomation | 5 / 6 / 7 / 8 / 14 | GetRootElement / ElementFromHandle / ElementFromPoint / GetFocusedElement / ControlViewWalker |
| IUIAutomationElement | 16 / 21 / 23 / 29 / 36 / 43 | GetCurrentPattern / CurrentControlType / CurrentName / CurrentAutomationId / CurrentNativeWindowHandle / CurrentBoundingRectangle |
| IUIAutomationValuePattern | 3 / 4 / 5 | SetValue / get_CurrentValue / get_CurrentIsReadOnly |

Objects are created with `CoCreateInstance(CLSID_CUI_AUTOMATION
ff48dba4-…, IID_IUI_AUTOMATION 30cbe57d-…)` under
`CoInitializeEx(COINIT_MULTITHREADED)`; BSTRs cross the boundary via
`SysAllocStringLen`/`SysFreeString` and are converted lossily from UTF-16.
`HRESULT` handling tolerates `RPC_E_CHANGED_MODE` (a thread already in another
COM mode may continue), and `CoUninitialize` runs only when this call actually
initialized COM (`uia.rs:185-189`).

### 2.2 Snapshot algorithm (`snapshot_inner`, `uia.rs:476-615`)

1. Run on a dedicated thread `cua-uia-snapshot`; the caller waits
   `recv_timeout(1500 ms)`.
2. Probe: create the UIA object and `GetRootElement` once (discarded — it only
   proves the provider answers).
3. Get the **ControlViewWalker** (control view, not raw tree).
4. Root element: prefer `ElementFromHandle(hwnd)` — `ElementFromPoint(center)`
   can hit an overlapping window or Office's floating task panes and degrade
   the tree into fragments (`uia.rs:526-531`). On FromPoint fallback, walk
   parents up to 20 levels until the element's `NativeWindowHandle` equals the
   target hwnd.
5. **Manual recursion** (`walk_element`, `uia.rs:617-696`) — not `FindAll`:
   `GetFirstChildElement` + `GetNextSiblingElement`, bounded by `depth > 12`
   and `visited >= 600` nodes.
6. Per node: Name (23), AutomationId (29), ControlType (21, default
   `UIA_CUSTOM`), Bounds (43).

**Text-tree encoding** (`uia.rs:643-665`) — this string is what the agent
parses, so its shape is a contract:

```
\t{index} {role} #{automationId} {name} [no-hit]? [Secondary Actions: Raise]?
```

- `{index}` is the 1-based line number used by `click({element_index})`.
- AutomationId is the **restart-stable key** used by the recorder to re-resolve
  anchors (name changes are cosmetic).
- `[no-hit]` marks elements without bounding rects (not clickable).
- index 0 always gets `" Secondary Actions: Raise"` (the only supported
  secondary action, exposed as `perform_secondary_action`).

The tree is rejected if it has ≤ 1 line ("empty tree"); the snapshot also
returns `focused_element` and `document_text` (concatenated text parts).

### 2.3 Reading and writing focused value

`get_focused_value` (`uia.rs:305-427`): the current window must be the
foreground (`ensure_target_foreground`) → GetFocusedElement → GetCurrentPattern
(10002, `UIA_VALUE_PATTERN_ID`) → QI to ValuePattern → `get_CurrentValue`.
Writes (`set_focused_value_inner`, `uia.rs:429-474`) first check
`get_CurrentIsReadOnly` and refuse ("focused value is read-only"), then
`SetValue` with a `SysAllocStringLen` BSTR. Reads/writes run on the
**synchronous request thread** (not a detached worker) because a destructive
write must never be stranded on a detached worker.

### 2.4 Hang protection (the bad-app mechanism)

- Timeout workers (`cua-uia-snapshot`, `cua-uia-point`, `cua-uia-focused-value`)
  use mpsc + `recv_timeout`; on timeout the worker thread is **detached** (it
  only touches its own COM/GDI objects, so it cannot poison the host).
- A timeout marks the app: `UIA_TIMEOUT_APPS: HashSet<String>` keyed by
  `window.app`. Subsequent requests for that app fail fast with
  "UI Automation disabled after provider timeout" — no more blocking waits
  this session.
- **Short probe**: the daemon may send `x-fastcua-uia-probe-ms` (default
  300 ms) in meta; `snapshot_with_timeout` replaces the 1.5 s budget. A
  healthy provider answers within the probe and the app is "rehabilitated";
  a wedged one fails fast and stays disabled. The probe is echoed in
  `uia_meta.probe_ms`.
- `FASTCUA_TEST_FORCE_UIA_FALLBACK=1` forces the HWND fallback for tests.

### 2.5 UIA quality assessment (`assess_uia_quality`, `desktop.rs:561-664`)

Each snapshot produces a `{quality, prefer_vision, confidence, reason}` triple
that drives the agent's text-vs-vision decision:

| Condition | quality / prefer_vision | reason |
|---|---|---|
| provider error (timeout/disabled) | broken / true | `timeout_or_provider_disabled` |
| empty tree | broken / true | `empty_tree` |
| all roles ∈ shell set or actionable < 3 | broken / true | `only_shell` |
| `[no-hit]` ≥ 50 % | weak / true | `high_no_hit` |
| actionable < 5 | weak / true | `few_actionable` |
| otherwise | good / false | — |

`confidence` starts from a tiered base (0.05 error … 0.75 good) and is
adjusted by `+0.2*actionable_ratio − 0.3*no_hit_ratio`, clamped to
`[0, 0.98]`.

### 2.6 HWND fallback tree

When the provider is unresponsive (`provider_unresponsive=true`) the host
builds an accessibility tree from `EnumChildWindows` instead (`desktop.rs:
518-558`): visible children only, class-name → role mapping (`"edit"`→Edit,
`"button"`→Button, `"msctls_trackbar32"`→Slider, …), no bounds. Window text is
read with `SendMessageTimeoutW(WM_GETTEXTLENGTH/WM_GETTEXT, 300 ms,
SMTO_ABORTIFHUNG|SMTO_BLOCK)`; a hung app short-circuits to
`InternalGetWindowText` (reads the text stored in the window structure, no
message pump needed). `uia.prefer_vision` is set so the agent switches to
grid/screenshots.

## 3. Input injection

### 3.1 Click sequence (`click`, `desktop.rs:1784-1908`)

```
activate_window → resolve (x,y) → optional snap → invalidate_capture_dedup
→ move_and_settle (SetCursorPos + Sleep 50ms)
→ ensure_cursor_position → ensure_foreground_window
→ per click (1..3, clamp): ensure_foreground_window → dispatch_click → Sleep 35ms
```

- **Coordinate resolution**: explicit `x,y` win; otherwise `element_index`
  looks up the element's cached bounds center, clamped into
  `[left+1, right-2]` when outside the outer HWND.
- **Snap** (`snap:true`, used by `click_cell`): `ElementFromPoint` at the
  point, 800 ms bounded; if the hit element is a real control, click its
  **center**; any failure falls back to the original coordinates. A hit whose
  bounds match the window rect within ±2 px is treated as "the window
  background itself" and ignored (anti-hijack).
- **Move vs click split**: movement uses `SetCursorPos` (fast, absolute);
  the click itself uses `SendInput` (`INPUT` with MOUSEEVENTF_LEFTDOWN/UP)
  because real input is accepted where synthesized `BM_CLICK` is ignored.
  Down → Sleep 20 ms → up; the release has up to 3 retries (Sleep 5 ms).
- **Pre-flight checks**: `ensure_cursor_position` re-reads `GetCursorPos` and
  aborts ("cursor moved; action cancelled") if the cursor is not where we put
  it — a human grabbing the mouse cancels the action instead of misclicking.
  `ensure_foreground_window` re-checks the foreground HWND before every click.

### 3.2 Keyboard

- **Text** (`send_text`, `desktop.rs:1983-2037`): each UTF-16 code unit is a
  pair of `SendInput` INPUTs — `(wVk=0, wScan=unit, KEYEVENTF_UNICODE)` +
  `(KEYEVENTF_UNICODE|KEYEVENTF_KEYUP)` — batched 256 per flush with an
  `ensure_foreground_window` between batches. If `SendInput` reports an odd
  `sent` count (stuck down), a compensating KEYUP is sent, up to 3 times,
  preventing key-stick.
- **Chords** (`press_key`, `desktop.rs:2039-2066`): `"Control_L+a"` is split
  on `+`, each token mapped via `key_to_vk` (modifiers → `VK_CONTROL`/`VK_SHIFT`/
  `VK_MENU`; single chars via `VkKeyScanW`; `F1`-`F20` by prefix; `KP_*`/`NUMPAD_*`
  numpad constants). Keys are **pressed in order** via `keybd_event`
  (`MapVirtualKeyW` → scan code, Sleep 8 ms each), then **released in reverse**
  (Sleep 4 ms each). Rationale: keybd_event for chorded VK keys, SendInput for
  Unicode text — each API is used where it is most reliable.
- **Value writes** go through UIA `ValuePattern.SetValue` (see 2.3), not
  keystrokes, when the control is writable — this is what `type_text
  {replace:true}` uses.

### 3.3 Drag (`desktop.rs:2087-2127`)

`move_and_settle(from)` → `send_mouse(LEFTDOWN)` → **20 linear-interpolation
steps** (`x = from_x + (to_x − from_x)*step/20`), each step re-verifies
`ensure_foreground_window` + `ensure_cursor_position(previous)` before
`set_cursor_position`, Sleep 8 ms → final position verify → `send_mouse_release`.
Drag release failures are merged into the reported error.

### 3.4 Scroll (`desktop.rs:2068-2085`)

`move_and_settle` to the target, then vertical → `MOUSEEVENTF_WHEEL` with
`(−vertical)` (sign flip: positive delta = up), horizontal →
`MOUSEEVENTF_HWHEEL`. `scroll_element` is the same function; elements are only
used to derive coordinates.

## 4. Window management

### 4.1 Enumeration and filtering (`list_windows`, `desktop.rs:209-266`)

`EnumWindows` with filters: skip invisible windows, `PID == 0`, `PID == self`,
empty titles, and processes whose image path cannot be resolved
(`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
`QueryFullProcessImageNameW`). Window id is the **hwnd as u64** — stable for
the session. `list_apps` groups windows by app via `BTreeMap`.

### 4.2 Activation (`activate_window_inner`, `desktop.rs:439-473`)

The Windows foreground lock only lets the thread that owns the input queue
call `SetForegroundWindow` successfully. The algorithm works around it:

```
GetForegroundWindow → already target? done (preserves collapsed selection)
IsHungAppWindow check
worker thread "cua-activate", caller recv_timeout(1500 ms):
  ShowWindow(SW_RESTORE)
  if foreground thread ≠ current: AttachThreadInput(current, fg, TRUE)  ← merge queues
  BringWindowToTop → SetForegroundWindow → SetActiveWindow
  AttachThreadInput(FALSE)
retry loop ×10: Sleep 10 ms → GetForegroundWindow == hwnd? else re-Bring+Set
timeout → Err
```

The outer 1.5 s budget (worker + `recv_timeout`) guarantees activation cannot
exceed the daemon's per-request budget.

### 4.3 Launch validation (`validate_launch_app`, `desktop.rs:319-403`)

Three accepted forms, strictly validated:

1. `paint` / `mspaint` / `mspaint.exe` alias → packaged
   `shell:AppsFolder\Microsoft.Paint_8wekyb3d8bbwe!App` (case-insensitive);
   missing `mspaint.exe` also falls back to the packaged app.
2. `shell:AppsFolder\` prefix → AUMID must contain `!` (PackageFamily!AppId)
   and each part may contain only `[A-Za-z0-9._-]`.
3. Otherwise: **absolute path + `.exe` extension (case-insensitive) +
   `is_file()`**, then `canonicalize()`.

Launch uses `ShellExecuteW(null, "open", target, …)`, failure = return ≤ 32.

## 5. Screenshots and the visual grid

### 5.1 Capture pipeline (`capture_window_rgb_inner`, `desktop.rs:1137-1218`)

`cua-capture` worker thread, caller `recv_timeout(3000 ms)`:

```
GetWindowRect (≤ u16::MAX sanity) → GetWindowDC → CreateCompatibleDC/Bitmap
if IsHungAppWindow || PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT) fails:
    BitBlt(SRCCOPY | CAPTUREBLT)          ← works even for wedged windows
GetDIBits → 32-bit BGRA (negative biHeight = top-down)
BGRA → RGB per pixel ([B,G,R] → [R,G,B])
```

Why BitBlt works on hung windows: it reads the window's current surface
directly without pumping the target's message queue; `CAPTUREBLT` includes
regions occluded by other/layered windows.

### 5.2 Downscale and dedupe

- Box-averaged downscale to `max_edge` (default **1568**; `FASTCUA_MAX_EDGE`
  or per-request override; ≤ 0 disables): `scale = long_edge/max_edge`,
  each output pixel is the mean of its source region — no interpolation
  artifacts, and it is cheap.
- `frame_hash`: FNV-1a over 4096-byte chunks (offset 0xcbf29ce4…, prime
  0x100000001b3). 2 s TTL cache keyed `"{id}:shot"`; a hit returns
  `unchanged:true` with metadata only — no image payload. **Any input action
  invalidates the cache** (`invalidate_capture_dedup`), so a post-click state
  is always freshly captured.
- JPEG quality: 82 for plain screenshots, **72 for grid images** (smaller,
  they are targeting aids).

### 5.3 Square grid packing (`pack_square_cells`, `desktop.rs:1270-1334`)

Pure **square** cells (Apple-style, no rectangles):

- refine=false: try 3 rows (`side = rh/3`, `cols = floor(rw/side)`); if
  `cols < 2` retry with 2 rows; if `cols < 1` degenerate to a single
  1×1 cell. Grid is centered with `(gl, gt)` offsets.
- refine=true: forced 3×3 (`side = min(rw,rh)/3`, centered).
- Cell ids increment row-major from 1 — this is the number the agent "selects".

### 5.4 Rendering is pure CPU pixel ops (no GDI/Direct2D)

Grids are drawn directly into the RGB buffer: semi-transparent cyan
`(80,220,255)` borders at `alpha 0.38`, line width `(side/90).clamp(1,2)`;
numbers from a hand-coded 5×7 bitmap font (`DIGIT_FONT`), drawn twice —
1 px black outline ring (alpha ≈ 0.385) then white fill (alpha 0.72), scaled
`(side*0.045).round().clamp(1,3)`, centered on the cell click point. `refine`
re-captures only the requested region via `capture_region_rgb` (BitBlt of the
region, skipping the full-window buffer).

### 5.5 Grid response contract

`{window, path, select_only, unchanged, phase, viewport, view, grid{…, cells[{id,row,col,left,top,right,bottom,cx,cy,width,height,square}]}, screenshots[1]}` —
one annotated image (base64 JPEG), `grid.cells[].cx/cy` are the click points,
`select_only:true` reminds the agent that selecting a number does not click.

## 6. DPI and the coordinate contract

`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2 = -4)` at startup
(`main.rs:33-35`). Without it, on 125 %/150 % displays `GetWindowRect` returns
a **virtualized** rect that does not match the PrintWindow bitmap or UIA
bounds. With V2 awareness, window rect, screenshot pixels, UIA bounds, and
injected coordinates all share one physical-pixel space — which is why the
README can promise "click x,y are in window screenshot pixels". The skill
recorder declares the same awareness so hooks, `ElementFromPoint`, and UIA
bounds line up (physical-pixel anchoring on scaled displays).

## 7. Main loop and safety gates

### 7.1 Dispatch loop (`main.rs:43-115`)

`stdin.lock().lines()` — one JSON request per line; empty lines skipped;
parse errors `eprintln` + continue; `method == "close"` ends the loop (and
deletes the interrupt file for the session). `dispatch` matches the method
whitelist, everything else → `Err("unsupported method")`.

### 7.2 Approval gate

`request_app` derives the target app: `list_apps`/`list_windows`/`close` are
approval-free; `launch_app` validates its argument; anything with
`params.window` uses the window's app. The gate compares meta
`x-fastcua-approved-app` (or legacy `x-oai-cua-approved-app`) against the
target — a mismatch returns
`{ok:false, approvalRequest:{app, displayName, riskLevel:"low"}}`.
`risk_level` is currently always `"low"`; the daemon decides whether to show
a prompt (whitelist / policy / cached approval).

### 7.3 Interrupt gate

`interrupt_path` builds `<home>/cache/computer-use/interrupts/<session>/<turn>`
(home = `FASTCUA_HOME` → `FASTCUA_CACHE_DIR` → `CODEX_HOME`), sanitizing both
segments to `[A-Za-z0-9._-]`. If the file exists the request fails with the
`INTERRUPT_MESSAGE` — the exact text the agent is expected to echo back
("Computer Use was stopped by the user with the physical Escape key…").
Only `close` clears the marker.

### 7.4 Parent watchdog

`--parent-pid <pid>` → `OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)`
→ dedicated thread `WaitForSingleObject(INFINITE)` → on signal `process::exit(0)`.
The native host is a child of the daemon by construction; if the daemon dies,
the host follows within one wait period.

### 7.5 Cursor glow overlay (`overlay.rs`)

A separate `cua-cursor-overlay` thread creates a layered top-most
click-through window spanning the virtual screen:
`WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE`,
magenta color-key transparency (`SetLayeredWindowAttributes(0x00ff00ff)`,
`WM_NCHITTEST → HTTRANSPARENT`). `SetTimer(33 ms)` ≈ 30 fps repaint: three GDI
circles — violet (139,92,246) 2 px outer ring with a `pulse = 17 + phase/3`
breathing radius (triangular wave over 30 phases), cyan (34,211,238) 3 px
mid ring at radius 12, solid white 4 px center dot. This is the visual
"here is what the agent is doing" signal.

## 8. Concurrency and resource model

- **Global state**: `UIA_TIMEOUT_APPS`, `UIA_ELEMENT_MAPS`, `LAST_CAPTURE_SCALE`,
  `CAPTURE_DEDUP` — all `OnceLock<Mutex<…>>` (lazy, serialized).
- **Threads**: `cua-uia-snapshot`, `cua-uia-point`, `cua-uia-focused-value`,
  `cua-capture`, `cua-activate`, `cua-cursor-overlay`, plus the parent
  watchdog. All timeout workers are detached and touch only their own
  COM/GDI objects.
- **Memory**: every COM object is released (slot 2); `FocusedValuePattern`
  releases + `CoUninitialize`s via `Drop`; BSTRs freed after read; bitmap
  pipeline fully cleans up (`DeleteObject/DeleteDC/ReleaseDC`). `unsafe` is
  confined to FFI declarations (win32.rs), vtable dereference + transmute
  (uia.rs:773-777), `from_raw_parts` BSTR/slice construction, and Win32
  callbacks.

## 9. Engineering trade-offs worth knowing

1. **UIA without a crate**: hand-written ABI-level COM keeps the host
   dependency-free (4 crates total) and the release self-contained, at the
   cost of hard-coded vtable slots that are version-sensitive to UIAutomationCore
   — hence the extensive empirical validation in `tests/real-machine-validation.mjs`.
2. **CPU-pixel rendering instead of GDI/Direct2D**: the grid is drawn in the
   RGB buffer because the pipeline is already BGRA→RGB and downscaled;
   adding a GDI surface would couple capture to the DC and complicate the
   worker-thread ownership story. Cost: trivial at grid resolutions.
3. **Three input APIs by purpose**: `SetCursorPos` for absolute fast movement,
   `SendInput` for clicks and Unicode text (real input beats synthetic
   messages), `keybd_event` for chorded VK keys. Each is chosen where it is
   most reliable, not for uniformity.
4. **Detached timeout workers**: the host never waits unbounded on a provider;
   workers that time out are simply orphaned. Combined with the bad-app set
   this converts "a hung app" from a blocker into a per-session degradation.
5. **No OCR by design**: visual targeting is grid-based; the host stays
   dependency-free and the agent's vision model does the actual reading —
   tokens are spent where vision adds information (per design principle 1).
