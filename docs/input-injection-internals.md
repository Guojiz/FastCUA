# Input Injection in FastCUA: A Deep Analysis

**Abstract.** Automating a Windows GUI requires producing input that real
applications accept as if it came from a human. This is deceptively hard:
Windows exposes at least three different ways to generate input events, and
they differ not in what they produce but in *where in the input pipeline the
event enters*. FastCUA's correctness on dialogs, DirectUI controls, and
modern packaged apps rests on a deliberate, well-reasoned choice of injection
point for each kind of action. This report analyzes the Windows input stack,
explains why the intuitive approaches fail, and documents the exact mechanism
FastCUA uses — with the defensive sequencing that keeps an agent from
misclicking when the user or the OS moves the goalposts. All code references
are to `native-host/src/desktop.rs` and `native-host/src/win32.rs` at commit
`40f0f71`.

- [1. The problem](#1-the-problem)
- [2. Background: the Windows input pipeline](#2-background-the-windows-input-pipeline)
- [3. Why synthetic messages fail](#3-why-synthetic-messages-fail)
- [4. FastCUA's injection architecture](#4-fastcuas-injection-architecture)
- [5. Mechanism details](#5-mechanism-details)
- [6. Defensive sequencing](#6-defensive-sequencing)
- [7. Comparative analysis](#7-comparative-analysis)
- [8. Limitations and discussion](#8-limitations-and-discussion)
- [9. Conclusion](#9-conclusion)

## 1. The problem

An agent acting on a desktop must produce *pointer motion, clicks, text, key
chords, drags, and scrolls* that the target application treats as genuine. Two
failure modes dominate naive implementations:

1. **Acceptance failure** — the event is delivered but ignored or misrouted by
   the target (common for dialogs and DirectUI controls when the event is a
   synthesized *window message*).
2. **Interference failure** — the event is correct in isolation, but a human
   hand, another automation, or the OS itself changes the foreground window or
   cursor position between the moment of planning and the moment of effect,
   so the action lands on the wrong thing.

FastCUA addresses both. Its design premise is that these are *separate*
problems with *separate* mechanisms: acceptance is a property of *which API
and which payload* you use; interference is a property of *when you check the
world and what you do when it disagrees*.

## 2. Background: the Windows input pipeline

To reason about injection one must know where events originate. A physical
event follows a fixed path:

```
hardware interrupt
  → kernel driver (kbdclass / mouclass)
  → raw input thread (RIT, in win32k)
  → per-application message queue (WM_MOUSEMOVE / WM_KEYDOWN / …)
  → application GetMessage/DispatchMessage → WndProc
```

Windows offers three injection points, each entering this pipeline at a
different depth:

| Injection point | API | Where it enters | Consequences |
|---|---|---|---|
| **Message level** | `SendMessage`/`PostMessage` (`BM_CLICK`, `WM_LBUTTONDOWN`, `WM_SETTEXT`, …) | *Into the target's queue directly*, bypassing the RIT | Never touches the input stack; carries no input provenance; many controls reject or mishandle it; synchronous `SendMessage` blocks on the target's message pump |
| **Virtual input level** | `SendInput`, `keybd_event`, `mouse_event` | *Into the keyboard or mouse input stream* | Serialized and routed by the input system rather than directly to one WndProc; low-level hooks can still distinguish injected events; subject to input-security rules |
| **Driver level** | Interception, virtual HID | *Below the USER injection APIs* | Requires a driver or virtual device, with materially different deployment and security costs |

FastCUA operates at the **virtual input level** — the deepest documented
USER-mode injection point it uses without a kernel driver. Two OS mechanisms
constrain what is possible there:

- **UIPI (User Interface Privilege Isolation)** — `SendInput` is permitted only
  into applications at an equal or lower integrity level. A normal-integrity
  host therefore cannot use this path to drive an elevated application. The
  current implementation observes only a generic short-insertion failure;
  neither the return value nor `GetLastError` identifies UIPI as the cause.
- **The injected-input flag** — low-level keyboard and mouse hooks can test
  `LLKHF_INJECTED` / `LLMHF_INJECTED` (and the lower-integrity variants). The
  events therefore share the normal USER input stream but are not
  observationally identical to hardware events. Software may choose policy
  based on those flags; FastCUA does not attempt to conceal them.

## 3. Why synthetic messages fail

The naive approach — `SendMessage(hwnd, BM_CLICK, …)` or posting
`WM_LBUTTONDOWN/UP` — fails on a large class of modern controls for structural
reasons:

1. **Provenance.** A synthesized window message has no input provenance.
   Common item dialogs, DirectUI, and many packaged-app controls are written
   to respond to *input*, not to *messages*. FastCUA's own code comment
   records the empirical finding
   (`desktop.rs:1891-1892`): *"Common item dialogs / DirectUI often ignore
   SendMessage(BM_CLICK) / synthetic WM_LBUTTON\* while still accepting
   SendInput."*
2. **Synchrony.** `SendMessage` is synchronous across process boundaries: the
   call blocks until the target's WndProc returns. A wedged target therefore
   wedges the caller — exactly the hang FastCUA's architecture exists to
   avoid. Where a message is genuinely the right tool (reading window text,
   setting an Edit's text), FastCUA always uses the **bounded** form
   `SendMessageTimeoutW(…, SMTO_ABORTIFHUNG|SMTO_BLOCK, timeout)` (300 ms for
   `WM_GETTEXT`, 1 s for `WM_SETTEXT`) — never the unbounded form.
3. **Security.** Cross-process messages are subject to UIPI message filtering;
   permission also depends on the specific message and target.

The conclusion FastCUA draws is deliberately scoped: **messages are used for
bounded reads and narrow value writes; pointer and keyboard interaction uses
the Windows input stream.** This is an architectural rule, not a claim that
injected events are indistinguishable from hardware or accepted by every
application.

## 4. FastCUA's injection architecture

Injection is decomposed by *purpose*, and each purpose currently uses a
different API — the deployed split, with its relative strengths, is:

| Purpose | API | Rationale |
|---|---|---|
| Absolute pointer motion | `SetCursorPos` | Fast, absolute, no relative-drift; position is then **verified** |
| Clicks, Unicode text, scroll | `SendInput` | Inserts events into the system input stream and exposes an inserted-event count; a single submitted array is not interspersed with other input |
| Key chords (Ctrl+A, F12, …) | `keybd_event` (current implementation) | Explicit per-key VK/scan down/up ordering; Microsoft marks this API as superseded — migration to batched `SendInput` is recommended |
| Text value replacement | UIA `ValuePattern.SetValue` | Destructive writes do not enter the input stream; current call is synchronous and has no local timeout |

This decomposition records the current implementation. It is not all equally
strong: the `SendInput` paths are observable by return count, while the chord
path is not; the synchronous UIA replacement path preserves write ownership
but retains a provider-liveness risk. The stronger target design is described
in §8.

### The `INPUT` ABI

FastCUA hand-writes the `INPUT` union it passes to `SendInput`
(`win32.rs:177-210`), because it carries no `windows` crate:

```rust
#[repr(C)] pub struct MOUSEINPUT { dx, dy, mouseData, dwFlags, time, dwExtraInfo }
#[repr(C)] pub struct KEYBDINPUT { wVk, wScan, dwFlags, time, dwExtraInfo }
#[repr(C)] pub union  INPUT_0    { mi: MOUSEINPUT, ki: KEYBDINPUT }
#[repr(C)] pub struct INPUT      { r#type: DWORD, Anonymous: INPUT_0 }
```

`#[repr(C)]` fixes the exact layout the API expects. FastCUA uses only two
`type` discriminants: `INPUT_MOUSE` (0) and `INPUT_KEYBOARD` (1). For keyboard
events it uses three `dwFlags`: `KEYEVENTF_KEYUP` (0x2), `KEYEVENTF_UNICODE`
(0x4), and their union. For mouse it uses the `MOUSEEVENTF_*DOWN/UP/WHEEL/
HWHEEL` constants (`win32.rs:82-89`). `dwExtraInfo` is left 0 — FastCUA does not tag its own events. This is a
valid simplification for the single-injector host, but it also means a future
low-level-hook diagnostic cannot identify its own events by an application
cookie; the recorder must rely on Windows' generic injected provenance flags.

### 4.1 Formal coordinate model

The agent does **not** send desktop coordinates. It supplies either normalized
window coordinates, pixels in the latest (possibly downscaled) screenshot, or
full window pixels. Let the physical outer window rectangle be
`R = (L,T,W,H)`, the last capture scale be `s ≥ 1`, and the supplied point be
`p=(x,y)`.

- Normalized mode is selected only when **both** coordinates lie in `[0,1]`:
  `P_w = (round(x(W−1)), round(y(H−1)))`.
- Screenshot-pixel mode (default for numeric values outside that joint
  normalized range): `P_w = (round(sx), round(sy))` when `s>1`; otherwise
  `P_w=(round(x),round(y))`.
- Explicit `space:"window_pixels"`: `P_w=(round(x),round(y))`, bypassing the
  scale inversion (used by `click_cell` / `click_view`, which already computed
  full window pixels).
- After proving `0 ≤ P_w.x < W` and `0 ≤ P_w.y < H`, the desktop point is
  `P_s = (L + P_w.x, T + P_w.y)`.

This chain is implemented by `screen_point_from_params` and `screen_point`
(`desktop.rs:2254-2335`). It explains why `SetCursorPos`, which takes screen
coordinates, can be driven from an image observed by the model without
coordinate drift. The corresponding real-machine test checks two screenshot
points separated by 10 px and accepts ≤2 px error after downscale inversion
(`tests/real-machine-validation.mjs:619-653`).

### 4.2 Action state machines and invariants

Let `F(t)` be the foreground HWND, `C(t)` the actual cursor position, `T` the
target HWND, and `P` the intended desktop point. FastCUA enforces these
preconditions at the point of effect:

- **I1 Foreground ownership:** `F(t_effect)=T`.
- **I2 Cursor ownership:** `C(t_effect)=P`.
- **I3 Balanced transitions (safety goal):** every injected down must be
  followed by the corresponding up, or cleanup must be attempted and the
  action reported failed. The current text and mouse paths implement cleanup;
  the legacy chord path does not yet establish this property.
- **I4 Bounded interaction (partial):** message reads/writes, activation,
  snapshots, point-hit, and capture have explicit budgets. Synchronous UIA
  `ValuePattern.SetValue` is intentionally kept on the request thread to avoid
  a late destructive write, but it has no local timeout; therefore a universal
  bounded-wait invariant is not yet proven.
- **I5 Coordinate containment:** window-relative points are rejected before
  translation if outside `[0,W)×[0,H)`.
- **I6 Fail stop:** a failed range, ownership, or insertion check terminates the
  high-level action rather than continuing optimistically.

The click state machine is:

```
Idle → Activated → Positioned → Settled → Verified(F,C)
     → ButtonDown → ButtonUp → Reverified(C) → Complete
                        └ failure → ReleaseCleanup → Failed
```

The drag state machine extends the held state:

```
ButtonDown → for i=1..20: Verify(F,C_prev) → Move(P_i) → delay
           → Verify(F,C_end) → ButtonUp
```

These are **detect-and-abort** invariants, not mutual exclusion. The host does
not lock the physical device; instead it re-observes shared state as close as
practicable to each irreversible transition and fails if another actor changed
it. The residual time-of-check/time-of-use interval is discussed in §6.

## 5. Mechanism details

### 5.1 Move vs. act: the split and why

`SetCursorPos` moves; `SendInput` clicks. They are not interchangeable:
`SendInput` with `MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE` could move, but its
absolute coordinate space is the 0–65535 normalized virtual-screen range,
which must be converted from physical pixels and is error-prone under
multi-monitor and DPI. FastCUA therefore moves with `SetCursorPos` (physical
pixels, the same space as `GetWindowRect` and UIA bounds), then **confirms**
the position with `GetCursorPos` before acting. Motion is cheap; correctness
is worth one syscall.

### 5.2 The click (`dispatch_input_click`, `desktop.rs:1898-1908`)

A click is two `SendInput` events — down, then up — with a 20 ms dwell:

```
send_mouse(MOUSEEVENTF_LEFTDOWN, 0)
Sleep(20 ms)
send_mouse_release(MOUSEEVENTF_LEFTUP)
```

The dwell gives the target's WndProc time to observe a distinct down/up pair
(a 0 ms pair can be coalesced or ignored by controls that require a real
press duration). The release is wrapped in `send_mouse_release`
(`desktop.rs:2354-2368`), which retries up to 3 times with 5 ms backoff — a
released-left-in-down-state mouse is far more dangerous than a failed click
(it would leave subsequent motion interpreted as a drag), so release is
given extra resilience.

`SendInput` itself is checked for **complete insertion**
(`send_inputs`, `desktop.rs:1961-1981`): it returns the number of events
actually inserted, and any shortfall is an error — because a partially
inserted batch is precisely the state (e.g. down without up) that corrupts
later actions.

### 5.3 Unicode text (`send_text`, `desktop.rs:1983-2037`)

Text is injected per UTF-16 code unit, bypassing keyboard layout entirely —
`KEYEVENTF_UNICODE` tells the input system "this is a character, not a key":

```
for unit in text.encode_utf16():
    push INPUT(type=KEYBOARD, ki={wVk:0, wScan:unit, flags:KEYEVENTF_UNICODE})
    push INPUT(type=KEYBOARD, ki={wVk:0, wScan:unit, flags:KEYEVENTF_UNICODE|KEYEVENTF_KEYUP})
    every 256 INPUTs: ensure_foreground_window → flush batch
```

`wVk = 0` is the sentinel that makes `wScan` be interpreted as a Unicode code
unit. Each character is a down/up pair, so the event stream is self-balancing.
Batches are capped at 256 `INPUT`s and the foreground window is re-verified
between batches — so a long paste aborts early if focus is lost, rather than
streaming characters into the wrong window.

**Anti key-stick recovery** (`send_text_inputs`, `desktop.rs:1999-2037`): if
`SendInput` reports an **odd** inserted count, FastCUA treats the successful
set as the leading prefix of its alternating down/up array; under that model
the prefix ends on a down event. It reads that unit's scan code and issues a
compensating `KEYUP`, up to 3 times. This is a sensible defensive recovery, but
the proof has an explicit premise: Microsoft documents the inserted count and
serial ordering of inserted events, yet the API page does not explicitly
specify short insertion as a successful *prefix*. A fault-injection shim or
low-level-hook trace is needed to validate that premise empirically.

### 5.4 Key chords (`press_key`, `desktop.rs:2039-2066`)

Chords like `"Control_L+a"` are parsed into a VK list (`key_to_vk`,
`desktop.rs:2370-2426`), then:

```
for key in keys:          # down, in order
    scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)
    keybd_event(vk, scan, 0, 0); Sleep(8 ms)
for key in reverse(keys): # up, in reverse order
    keybd_event(vk, scan, KEYEVENTF_KEYUP, 0); Sleep(4 ms)
```

The ordering property is load-bearing: for Ctrl+A the order is
`Ctrl↓ a↓ a↑ Ctrl↑`, which is what a chorded shortcut expects. Releasing the
modifier before the base key would split the chord. The current code uses
`keybd_event`, a legacy per-key API, and `MapVirtualKeyW` to derive a scan
code. The 8/4 ms spacing separates events into observable transitions.

This is an **implementation fact, not a recommendation**. Microsoft marks
`keybd_event` as superseded by `SendInput`; unlike `SendInput`, it has no
return value, so insertion cannot be verified. The current code also does not
set `KEYEVENTF_EXTENDEDKEY` for E0-prefixed keys and maps both left/right
modifier aliases to the generic `VK_CONTROL`/`VK_SHIFT`/`VK_MENU`. Therefore
"layout-correct for all extended keys" is not established. A stronger design
would build the entire chord as one `INPUT[]` transaction, use explicit
left/right VKs plus extended-key flags where required, verify the inserted
count, and perform release cleanup on partial insertion.

### 5.5 Drag (`drag`, `desktop.rs:2087-2127`)

A drag is a down, a sampled path, and an up:

```
move_and_settle(from)
send_mouse(MOUSEEVENTF_LEFTDOWN)
for step in 1..=20:
    ensure_foreground_window
    ensure_cursor_position(previous)          # verify, not assume
    set_cursor_position(lerp(from, to, step/20))
    Sleep(8 ms)
ensure_foreground_window; ensure_cursor_position(to)
send_mouse_release(MOUSEEVENTF_LEFTUP)
```

Twenty linear-interpolation steps give the target enough pointer-move samples
to track the drag (a single teleport from start to end is not recognized as a
drag by most controls). Crucially, **every step re-verifies both the
foreground window and the cursor's previous position before moving on** — if
the user grabs the mouse mid-drag, the loop aborts rather than fighting for
the pointer.

### 5.6 Scroll (`scroll`, `desktop.rs:2068-2085`)

Scroll moves to the target point first (`move_and_settle`) and then issues
`MOUSEEVENTF_WHEEL` with `(-vertical)` — the sign flip matches the Windows
wheel convention (positive wheel delta = forward/away). Horizontal uses
`MOUSEEVENTF_HWHEEL` with the value as-is. The point placement remains useful
for applications that choose a scroll target from pointer location, and it
also supplies the screen coordinates carried with `WM_MOUSEWHEEL`; however,
the documented Win32 message target is the **focus window**, with
`DefWindowProc` propagation up its parent chain. Therefore “always delivered
to the window under the cursor” would be too strong.

## 6. Defensive sequencing

Interference is addressed by *checking the world at the moments that matter*.
Two checks, defined once and reused everywhere:

- `ensure_cursor_position(x, y)` (`desktop.rs:1877-1888`) — re-reads
  `GetCursorPos` and errors `"cursor moved; action cancelled"` if the cursor
  is not where we put it. **A human grabbing the mouse cancels the action
  instead of being misclicked on.**
- `ensure_foreground_window(id)` (`desktop.rs:475-481`) — errors
  `"window {id} lost foreground; action cancelled"` if the target is no
  longer the foreground window.

`move_and_settle` (`desktop.rs:1870-1875`) composes them:
`SetCursorPos → Sleep(50 ms, MOVE_SETTLE_MS) → ensure_cursor_position →
ensure_foreground_window`. The 50 ms settle lets the input stack and the
window manager absorb the move before it is verified — a check placed too
early can observe a transient state and produce a false abort.

These checks are placed repeatedly near important transitions: before each
click in a multi-click (`desktop.rs:1854`), before and after the click pair
(`desktop.rs:1893-1895`), between text batches, and at every drag step. They
provide sampled evidence of cursor/foreground ownership; they do not eliminate
the time-of-check/time-of-use interval between the final observation and the
next API call. The result is detect-and-abort protection, not a proof of
exclusive device ownership.

## 7. Evidence and comparative analysis

| Approach | Acceptance on dialogs/DirectUI | Hang safety | UIPI behavior | Input-stack semantics |
|---|---|---|---|---|
| `SendMessage`/`PostMessage` | Often rejected/mishandled | `SendMessage` blocks on target pump | Filtered by UIPI | Message-level only |
| Unbounded `SendMessage` reads | — | **Unsafe** (wedged target wedges caller) | Filtered | — |
| FastCUA `SendMessageTimeoutW` reads | — | Bounded (300 ms / 1 s) | Filtered | — |
| **FastCUA `SendInput` paths** | Accepted in validated target set | Insertion count checked; no target-pump wait | Equal-or-lower integrity only; UIPI cause is not identifiable from return/error | Serialized insertion into keyboard/mouse input stream |

The pattern is consistent within the *message* surface: injected input is
used for interaction; bounded synchronous messages are used only for reads and
narrow value writes; unbounded cross-process messaging is never used. The
synchronous UIA write is a separate, deliberately unbounded-by-construction
provider call (see §8), not a window message.

### 7.1 What the current tests actually prove

`tests/real-machine-validation.mjs` supplies live-machine evidence for:

- clicking a Notepad editor and typing text, followed by UIA readback
  (`:342-370`);
- clicking and replacing the fixture Edit control (`:389-399`);
- `click_view` translation: two intended image points 10 px apart are recorded
  by the fixture with `|Δ−10|≤2 px` (`:554-579`);
- `click_in_cell` local-coordinate translation and rejection of coordinates
  outside the selected square (`:581-615`);
- inverse mapping through a downscaled screenshot's capture scale
  (`:619-653`);
- invalidation of capture deduplication after input (`:655-681`);
- UIA point-hit snap resolving a background point to the button center within
  ±4 px (`:687-704`).

The Office end-to-end suite adds a stronger application-level result: a real
Excel workflow executes 23 replay steps and the resulting workbook values are
verified with openpyxl, including Save As path typing.

### 7.2 What those tests do **not** prove

They do not yet systematically test physical modifier contamination,
left/right modifier identity, E0 extended keys, UIPI failure classification,
surrogate-pair handling across application classes, partial insertion of a
chord, drag interruption precisely between down and up, swapped mouse buttons,
or behavior when `ClipCursor` constrains the pointer. These are open test
requirements, not implied successes.

## 8. Limitations, defects, and recommended changes

- **UIPI boundary and ambiguous errors.** `SendInput` may inject only into an
  equal-or-lower integrity process. Microsoft explicitly states that neither
  its return value nor `GetLastError` identifies UIPI as the cause. FastCUA
  currently reports a generic short-insertion error; it does **not** reliably
  classify that error as UIPI. Elevated apps, UAC, and secure desktop remain
  out of scope.
- **`keybd_event` is superseded.** The chord path should move to a single
  `SendInput(INPUT[])` transaction. This would provide insertion-count
  observability, serialized non-interleaving for the complete chord, and the
  same release-cleanup discipline as Unicode text.
- **No pre-injection keyboard-state normalization.** Microsoft documents that
  `SendInput` does not reset current keyboard state; physically held Shift,
  Ctrl, Alt, or mouse buttons may interfere. FastCUA currently does not call
  `GetAsyncKeyState`/`GetKeyboardState` before a chord or text batch. The safe
  policy should be "detect held modifiers and abort" rather than releasing a
  human's physical key.
- **Left/right and extended-key fidelity.** `Control_L` and `Control_R` both
  map to generic `VK_CONTROL` (likewise Shift/Alt), and the chord path never
  sets `KEYEVENTF_EXTENDEDKEY`. A migration should preserve left/right VKs and
  mark E0-prefixed keys explicitly.
- **Surrogate pairs.** `encode_utf16` emits each surrogate code unit as its own
  `VK_PACKET` down/up pair. The `KEYBDINPUT` documentation defines `wScan` as a
  Unicode character and separately warns hook listeners to decode surrogate
  macros for touch-keyboard input, but it does not by itself prove identical
  reconstruction for this exact FastCUA sequence in every framework.
  Supplementary-plane behavior therefore remains an application-matrix test
  requirement.
- **Mouse-button mapping.** FastCUA's `left` means logical
  `MOUSEEVENTF_LEFTDOWN`; it does not inspect `SM_SWAPBUTTON`. The relationship
  to a user's physically swapped buttons should be specified and tested.
- **Race windows remain.** Detect-and-abort closes most interference windows,
  but it is not a device lock. A user action can occur after the final
  verification but before `SendInput`, or between the separately submitted
  mouse down and up. The release retry reduces stuck-state damage but cannot
  make the pair atomic.
- **Injected-flag detection.** Low-level hooks can inspect `LLKHF_INJECTED` /
  `LLMHF_INJECTED`; software may reject these events. Bypassing the flag would
  require a kernel/virtual-HID design, deliberately outside a local-first,
  dependency-free runtime.
- **Timing constants are empirical.** 20 ms click dwell, 8/4 ms chord spacing,
  50 ms settle, 35 ms inter-click, and 8 ms drag step are not derived from a
  formal device model. They should be parameterized and measured by target
  class if future compatibility demands it.
- **Synchronous UIA write can outlive the desired budget.** `replace:true`
  calls `ValuePattern.SetValue` on the request thread. This correctly avoids a
  detached worker performing a destructive write after the caller timed out,
  but a wedged provider can still block that request until the daemon's outer
  process/request containment intervenes. A stronger design needs cancellable
  provider isolation (for example, a disposable helper process), not merely a
  detached timeout thread.

### 8.1 Recommended next implementation

1. Replace the entire chord path with a balanced `INPUT[]` constructed as
   `K₁↓…Kₙ↓ Kₙ↑…K₁↑`, submitted by one `SendInput` call.
2. Add `GetAsyncKeyState` checks for Shift/Ctrl/Alt/Win and mouse buttons;
   abort when external state is non-neutral.
3. Preserve left/right VK identity and set `KEYEVENTF_EXTENDEDKEY` from an
   explicit key metadata table.
4. Tag `dwExtraInfo` with a FastCUA cookie for diagnostics while retaining the
   OS injected flag.
5. Add fixture counters for down/up order and a failure-injection seam that
   simulates partial insertion, then prove cleanup and balance invariants.
6. Add integrity-level diagnostics (query process token integrity) so a short
   insertion can be explained as "likely UIPI" without falsely claiming the
   OS identified it.

## 9. Conclusion

FastCUA's input injection is not a single API call but a *composed system*: a
per-purpose choice of injection point, a coordinate transform, event-ordering
rules, sampled ownership checks, and cleanup attempts. The validated target
set shows that USER-stream injection succeeds where selected synthetic-message
paths did not. The implementation also detects several important interference
classes before continuing. It does **not** prove hardware equivalence,
exclusive ownership, universal provider liveness, or complete keyboard-state
balance across the legacy chord path. Stating those boundaries is part of the
correctness argument: the system is strong where evidence and API contracts
support it, and its remaining obligations are explicit enough to test and
engineer.

---

*Source references:* `native-host/src/desktop.rs` (click 1784-1908, text
1910-2037, chords 2039-2066, scroll 2068-2085, drag 2087-2127, mouse send
2337-2368, pre-flight 475-481/1870-1896, key map 2370-2426) and
`native-host/src/win32.rs` (constants 80-91, `INPUT` ABI 177-210, FFI 296-297)
at commit `40f0f71`. Windows semantics per Microsoft documentation:
SendInput, keybd_event, SetCursorPos, SendMessageTimeoutW, UIPI, and the
foreground-lock rules.
