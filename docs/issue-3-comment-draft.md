# Comment for Guojiz/FastCUA#3 (POSTED 2026-07-22)

> Posted as https://github.com/Guojiz/FastCUA/issues/3#issuecomment-5049270424
> Target: https://github.com/Guojiz/FastCUA/issues/3

---

**Stage-1 capture feasibility: results from a real Windows machine**

I built the stage-1 diagnostic the issue proposes (`tools/record-feasibility/`,
standalone zero-dependency Rust + Win32 FFI, orchestrated by
`tools/record-feasibility/experiment.mjs`) and ran it against Notepad
(Windows 11) and a Win32 test fixture driven by FastCUA's own input pipeline.
Full write-up with numbers: `docs/demonstration-recorder-feasibility.md`.

Checkbox status after stage 1:

- [x] Input capture without blocking normal use — *with one caveat.* 4,282
  key/mouse events across runs 1 and 3, 0 dropped, hook callback avg 57–68 µs (no I/O in the
  callback), recorder flat at ~15.5 MB / ~2.2% of one core over 3 minutes.
  **Caveat:** this machine is unattended, so all input was FastCUA-injected;
  the `LLMHF_INJECTED`/`LLKHF_INJECTED` flags fired on 100% of events as
  expected, and physical input traverses the identical callback path — but a
  short human comparison session is still owed before this is fully closed.
- [x] UIA events aligned with input + keyframes — 22/22 Notepad key events
  align with an editor focus snapshot within ±600 ms. Surprise: Win11
  Notepad's editor is ControlType `Document` (50030), not `Edit` — and my
  diagnostic's own hand-written role table was off by one, which first scored
  0%. Anchors must persist numeric control-type IDs and accept both Edit and
  Document; names are localized (`文本编辑器`).
- [ ] DPI scaling / multiple monitors / window move+resize — **not testable
  here**: single monitor, 96 DPI. Explicitly open.
- [~] Display languages / keyboard layouts — partially: layout 0x0804 zh-CN,
  recorder is layout-agnostic by design (vk + key class, never characters);
  real IME composition (`VK_PROCESSKEY` 0xE5) untested.
- [ ] Semantic anchors surviving app restart — stage 2.
- [ ] Narration vs literal text — stage 2+, no narration capture yet.
- [x] Secrets / password fields redacted — dual detection (UIA `IsPassword` +
  `ES_PASSWORD` style); all 36 password-box key events redacted (vk omitted
  entirely); zero probe-string leakage in the recording file. Covers
  UIA-honest password fields only; custom-painted ones stay on the risk list.
- [~] Unsupported/custom-painted apps — defensive parts proven (800 ms
  time-bounded UIA queries, hung-window keyframe suppression), but no truly
  custom-painted app was tested.
- [ ] Visual-grid fallback — not tested (stage 2+).
- [ ] Pause/interjection/denial/F10 during recording — not tested; the
  diagnostic is standalone. Control-plane integration is stage 5.
- [x] Cost over a longer demonstration — 3-minute run: session JSONL ≈ 0.53
  MB/min under dense automated typing; CPU/memory a non-issue; **uncompressed
  BMP keyframes are the dominant cost (~21 MB/min)** → must become PNG/JPEG +
  focus-change-triggered sparse frames.
- [x] Cleanup after crash — `taskkill /F` mid-recording: all 69 lines parse
  (per-line flush), hooks released with the process, immediate re-run clean;
  Notepad session state verified free of probe text afterward.

Two extra findings for the compiler stages:

1. FastCUA's Unicode injection arrives as `VK_PACKET` (0xE7); real IME
   composition would be `VK_PROCESSKEY` (0xE5). When recording humans, treat
   0xE5 spans as opaque and read committed text from UIA value changes.
2. `injected: true` during a "human" demonstration means another automation
   is driving — flag those spans for review instead of mixing them in.

Bottom line: capture feasibility holds. Next step is the stage-2 alignment
experiment; the concrete anchors/clock/keyframe changes it needs are listed in
the doc's "Implications" section. DPI/multi-monitor and the human-input
comparison remain the two biggest untested boxes.
