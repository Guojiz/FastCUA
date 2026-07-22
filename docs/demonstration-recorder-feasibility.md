# Demonstration Recorder — Stage-1 Feasibility Results (issue #3)

> [!NOTE]
> This document reports a **diagnostic experiment**, not a feature. Nothing here
> is shipped, enabled by default, or claimed to be production-ready. It answers
> the question issue #3 stage 1 asks: *can a local Windows tool capture a human
> demonstration at all — input, UIA context, keyframes — with honest labeling,
> redaction, and bounded cost?*

**Date:** 2026-07-22 · **Commit base:** `f5eb521` · **Tool:** `tools/record-feasibility/`

## What was built

`tools/record-feasibility/` is a standalone, zero-dependency Rust binary (pure
Win32 FFI, no crates) that records a local capture session:

- **Input capture** — `SetWindowsHookExW` with `WH_KEYBOARD_LL` and
  `WH_MOUSE_LL`. The hook callback only pushes a struct into an
  `mpsc` channel and measures its own latency with `QueryPerformanceCounter`;
  all serialization happens on a worker thread. Mouse moves are coalesced on a
  40 ms window (counted, not logged individually).
- **Injected-vs-physical labeling** — every event records
  `injected` (`LLMHF_INJECTED` 0x01 / `LLKHF_INJECTED` 0x10) and
  `lower_il` (`LLMHF_LOWER_IL_INJECTED` / `LLKHF_LOWER_IL_INJECTED`).
- **UIA focus tracking** — `SetWinEventHook(EVENT_OBJECT_FOCUS` (0x8005)`,
  `WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS`) wakes a poller that
  snapshots the UIA focused element (control type, role string, name,
  `IsPassword`, hwnd, bounding rect) at most every 200 ms. Each query runs on a
  worker thread with an 800 ms `recv_timeout` so a hung UIA provider records an
  error instead of stalling the session.
- **Sparse screenshot keyframes** (optional) — `BitBlt` of the virtual screen
  to uncompressed BMP; skipped when the foreground window is hung
  (`IsHungAppWindow`), since `PrintWindow` can block on such windows.
- **JSONL output, flushed per line** — one local `session.jsonl` that is
  inspectable and deletable. Keyboard events **never** resolve vk codes to
  characters; only the numeric vk, a coarse key class, and modifier booleans
  are logged.
- **Password redaction (by design, double-checked)** — a key event is redacted
  (vk omitted entirely, `redacted: "password-field"`) when the focused control
  is password-ish by *either* UIA `IsPassword` *or* the Win32 `ES_PASSWORD`
  (0x20) style.
- **Secure-desktop awareness** — `OpenInputDesktop` is checked; when the input
  desktop is not `Default` (UAC prompt, lock screen, Ctrl+Alt+Del), capture is
  reported as suspended rather than silently recording nothing.
- **Explicit control** — recording starts/stops via CLI or the Ctrl+Alt+R
  hotkey, ends on Ctrl+C or a `--duration-ms` bound, and prints 10-second
  stats: callback count/latency, dropped events, working set, CPU time.

`tools/record-feasibility/experiment.mjs` orchestrates three runs: it starts
the FastCUA daemon, drives Notepad (Windows 11, UWP-packaged) and
`tests/FastCuaFixture.exe` (a plain Win32 fixture, extended with an
`ES_PASSWORD` edit control for this experiment) through FastCUA's own
injection pipeline, then analyzes the JSONL.

## Test environment

Single monitor, virtual screen 1365×953, 96 DPI (no scaling), keyboard layout
0x0804 (Chinese PRC), unattended Windows machine. **There was no human at the
keyboard** — see the honesty note below.

## Measured results

### Run 1 — labeling, alignment, redaction (70 s)

| Metric | Value |
|---|---|
| JSONL lines / parse errors | 187 / 0 |
| Key+mouse events | 93 (40 key_down, 40 key_up, 6 mouse_down, 6 mouse_up, 1 wheel) |
| `injected: true` / `physical` | **93 / 0** — all input was FastCUA-routed |
| Redacted records (password field) | **36** — every key event while the password box had focus; vk omitted entirely |
| Probe strings found anywhere in `session.jsonl` | **0 of 3** (`Hello FastCUA 123`, `s3cret!`, `normal text` — none leaked) |
| UIA focus records | 69 |
| Notepad key events with a matching Notepad-editor focus record within ±600 ms | **22 / 22 (100%)** |
| Keyframes | 15 BMP, 53.8 MB total (~3.6 MB each) |
| Hook callback latency | avg **57 µs**, max 370 µs, **0 dropped**, 0 coalesced |
| Recorder footprint | working set 6.3 → 15.5 MB, CPU 1.75 s over 70 s (~2.5% of one core) |

### Run 2 — crash mid-recording

The recorder was killed with `taskkill /F` while FastCUA was typing into
Notepad. Result: **69 of 69 lines parse cleanly** (per-line flush; the last
record is complete), and an immediate 5 s re-run starts and writes valid JSONL
— low-level hooks are released with the process, nothing leaks.

### Run 3 — cost over a 3-minute sustained session

113 automated input strokes (type + Enter + scroll, ~1.2 s cadence) for 170 s,
recorder active for the full 180 s:

| Metric | Value |
|---|---|
| Hook callbacks | 4,189 (~23 events/s), **0 dropped** at every 10 s checkpoint |
| Callback latency | avg 68 µs steady-state (drifts 90 → 68 µs), one-time max 4.79 ms |
| Working set | flat ~15.5 MB for the entire run — no leak |
| CPU | 4.0 s over 180 s ≈ **2.2% of one core** |
| `session.jsonl` size | 1.60 MB ≈ **0.53 MB/min** under dense automated typing (a human demo is far sparser) |
| Keyframes | 19 BMP = **62.3 MB** (~3.3 MB each at 1365×953×24bpp, ~6/min cadence → ~21 MB/min) |

## Issue #3 validation checklist — current answers

- [x] **Input capture without blocking normal use** — *mostly answered.* The
  capture path is proven: 4,282 key/mouse events across runs 1 and 3, 0 dropped, callback work
  < 0.1 ms (avg 57–68 µs), no I/O in the callback. **Honest caveat:** no
  *physical* human input could be produced on an unattended machine, so all
  events were FastCUA-injected. Injected and physical events traverse the
  identical hook-callback path; the `LL*HF_INJECTED` flags were verified
  present on 100% of events (and `lower_il` correctly false for same-IL
  injection). A 10-minute human comparison session is still required to close
  this fully.
- [x] **UIA events aligned with input events and keyframes** — yes, with one
  surprise (below). 22/22 Notepad key events align with a focus snapshot of
  the text editor within ±600 ms. Keyframes carry the same `unix_ms` clock.
- [ ] **DPI scaling, multiple monitors, window move/resize** — **not testable
  here**: single monitor, 96 DPI. Hooks and UIA both report virtual-screen
  coordinates, which is consistent by construction, but per-monitor DPI
  behavior is unverified. Explicitly open.
- [~] **Display languages and keyboard layouts** — partially answered. System
  layout is 0x0804 (zh-CN); UIA names arrive localized (`文本编辑器`), and the
  recorder is layout-agnostic by design (vk + key class, never characters).
  True IME composition (`VK_PROCESSKEY` 0xE5) was **not** exercised — no human
  typed Chinese with an IME during the runs.
- [ ] **Semantic anchors survive an app restart** — not tested; stage 2 scope.
- [ ] **Narration vs literal text** — not tested; no narration capture in
  stage 1.
- [x] **Secrets and password fields consistently redacted** — yes. Dual
  detection (UIA `IsPassword` + `ES_PASSWORD` style) redacted all 36 key
  events in the password box; none of the three probe strings appear anywhere
  in the recording. Note: this covers standard Win32/UIA-honest password
  fields; custom-painted fields (some browsers, password managers) would need
  heuristics and stay on the risk list.
- [~] **Unsupported / custom-painted apps** — partially answered defensively:
  UIA queries are time-bounded (800 ms) and record errors instead of hanging;
  keyframes skip hung windows. No genuinely custom-painted app was in the test
  set (Notepad + Win32 fixture only).
- [ ] **Visual-grid fallback** — not tested; keyframes exist but no grid
  overlay was built (stage 2+).
- [ ] **Pause / interjection / denial / F10 during recording** — not tested;
  the diagnostic is standalone (own hotkey + Ctrl+C). Control-plane
  integration is stage 5.
- [x] **CPU, memory, disk, recording-size cost** — answered (Run 3 numbers
  above). CPU and memory are a non-issue; **BMP keyframes are the dominant
  cost (~21 MB/min)** and must become compressed (PNG/JPEG) or diff-triggered
  sparse frames.
- [x] **Cleanup after crash / cancellation** — answered (Run 2): per-line
  flushed JSONL survives a hard kill with zero parse errors; hooks die with
  the process; immediate re-run is clean. Notepad probe text was removed
  (select-all + delete) and the Notepad tab-state store was verified to
  contain no probe residue afterward.

Validation set used: Notepad (Windows 11 UWP) + FastCuaFixture (plain Win32) —
2 of the 5 suggested apps. File Explorer, browser chrome, Paint, and an
Office-style app remain open.

## Surprises worth carrying into stage 2

1. **Windows 11 Notepad's editor is a `Document`, not an `Edit` — and our own
   role table made this worse before it made it better.** UIA reports the
   editor as **ControlType 50030 (`Document`)** named `文本编辑器` — *not*
   `Edit` (50004). The first alignment pass scored **0%** for a more
   embarrassing reason: the diagnostic's hand-written control-type→role-name
   table was off by one from 50006 up (a missing `50005 Hyperlink` entry), so
   it mislabeled 50030 as `DataItem`. After fixing the table (and re-checking
   the existing JSONL by numeric ID), matching on `Edit|Document` — or on the
   numeric IDs directly — scores **100%**. *Lessons:* (a) persist **numeric
   control-type IDs** in semantic anchors and never trust a hand-copied
   role-string table; (b) anchor sets must accept both `Edit` and `Document`
   for "text editor" semantics — real apps disagree; (c) names are localized
   hints, never keys.
2. **FastCUA's Unicode typing is distinguishable from real IME use.**
   `type_text` injection arrives as `VK_PACKET` (0xE7) key events; genuine IME
   composition would arrive as `VK_PROCESSKEY` (0xE5). When recording humans,
   0xE5 storms mean "composition in progress" — the compiler should treat them
   as opaque and read the *committed* text from UIA value-change events rather
   than reconstructing it from keys.
3. **`injected: true` is a useful tripwire, not just a label.** During a human
   demonstration, any injected event means another automation is driving the
   desktop; the compiler should warn and probably exclude that span.
4. **Focus hwnd ≠ foreground hwnd.** Key events carry the top-level foreground
   window; UIA focus carries the focused *child* element's hwnd (observed:
   editor hwnd 2820374 inside Notepad main window 2755066). Alignment must
   join on window ancestry, not equality.

## Risks and open questions

- **Anti-virus / EDR heuristics.** A low-level keyboard hook is structurally a
  keylogger primitive. Expect SmartScreen/AV friction for an unsigned build;
  the mitigation story (signed binary, explicit start, visible indicator,
  redaction-in-code) needs to be real before any public ship.
- **Secure Desktop / UAC.** Hooks simply go silent on the secure desktop; the
  recorder detects this via `OpenInputDesktop` and logs it, but no UAC prompt
  occurred during testing, so the exclusion is verified in code, not in vivo.
- **Elevated target apps.** UIA queries against a higher-IL process fail; the
  recorder must (and does) record that as an explicit gap rather than fabricate
  context.
- **Keyframe economics.** Uncompressed BMP is unworkable beyond minutes
  (62 MB / 3 min). Move to PNG/JPEG and trigger frames on focus change +
  coarse periodicity; consider capturing the foreground window rect only.
- **Password detection coverage.** Win32/UIA-honest password fields are
  covered; browser-rendered and custom-painted secrets are not detectable by
  these two signals alone — stage 2 should add a "type nothing sensitive while
  recording" UX warning regardless.

## Implications for the stage-2 alignment experiment

1. Anchor on **numeric control-type ID + AutomationId + hwnd ancestry**, with
   localized name/role as display hints only; accept both `Edit` (50004) and
   `Document` (50030) for text-editor semantics.
2. Join input events to focus snapshots by **window ancestry** and the shared
   `unix_ms` clock; ±600 ms was comfortable at human-plausible speeds, but the
   poller's 200 ms bound is the real alignment quantum.
3. Treat `VK_PROCESSKEY` spans as opaque; source committed text from UIA
   value changes.
4. Flag injected spans for review; never silently mix them into a "human"
   demonstration.
5. Compress keyframes before any longer-session experiment.

---

## 中文摘要

本次实验回答了 issue #3 第一阶段的问题：**在真实 Windows 桌面上，本地工具能否可靠录制一次演示**（输入事件 + UIA 焦点上下文 + 稀疏截图关键帧），并做到诚实标注、密码脱敏、成本可控。

**建了什么**：`tools/record-feasibility/` 下的独立 Rust 诊断工具（零依赖纯 Win32 FFI）。用 `WH_KEYBOARD_LL`/`WH_MOUSE_LL` 低层钩子捕获键鼠（回调只压队列、自带 QPC 延迟测量），用 WinEvent + 200ms 轮询快照 UIA 焦点元素（800ms 超时防挂起），按行 flush 写 JSONL，可选 BMP 关键帧。密码字段双重判定（UIA `IsPassword` + `ES_PASSWORD` 样式）后整事件脱敏，vk 完全不落盘。配套 `experiment.mjs` 编排脚本驱动 FastCUA 自身注入输入跑三轮实验。

**实测数字**：

- 钩子回调平均延迟 57–68 µs，3 分钟 4189 个事件**零丢弃**；录制器工作集稳定 15.5 MB，CPU 约 2.2% 单核 —— 不阻塞正常使用。
- 记事本 22/22（100%）按键事件能在 ±600ms 内对齐到文本编辑器的 UIA 焦点快照。
- 密码框内 36 条按键事件全部脱敏，三个探测字符串在整个录制文件中零泄漏。
- 成本：JSONL 约 0.53 MB/分钟（密集输入下）；未压缩 BMP 关键帧约 21 MB/分钟，是主要成本，stage 2 必须改压缩格式 + 稀疏触发。
- `taskkill /F` 强杀后 69 行日志全部可解析（逐行 flush），钩子随进程释放，立即重跑无残留。

**意外发现**：① Windows 11 记事本的编辑器 UIA 控件类型是 `Document`(50030) 而非 `Edit`(50004)；更意外的是首轮对齐率 0% 其实源于诊断工具自己手写的控件类型→角色名映射表从 50006 起整体错位一位（漏了 50005 Hyperlink），把 50030 错标成了 `DataItem`。修正映射表并按数值 ID 重新核对既有日志后，`Edit|Document` 匹配同样达到 100% —— 教训：语义锚点必须存数值控件类型 ID、别信手抄的角色名表；"文本编辑器"语义要同时接受 `Edit` 和 `Document`；名称是本地化的，只能当提示；② FastCUA 的 Unicode 注入呈 `VK_PACKET`(0xE7)，与真人 IME 组合的 `VK_PROCESSKEY`(0xE5) 可区分 —— 录制真人时 0xE5 段应视为不透明、从 UIA 值变化读取提交文本；③ 焦点 hwnd 是子控件、前台 hwnd 是顶层窗口，对齐要走窗口祖先链。

**诚实限制**：无人值守机器上无法产生真正的"物理"输入，所有事件均为 FastCUA 注入（`injected` 标记 100% 准确命中）；物理事件走完全相同的回调路径，但仍需一次真人对照会话才能完全闭环。DPI 缩放/多显示器本机不可测（单屏 96 DPI）。真实 IME 中文组合未实测。

**结论**：捕获可行性成立。stage 2（对齐实验）可以基于本文第 "Implications" 一节直接启动。
