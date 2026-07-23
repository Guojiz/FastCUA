# Comments for Guojiz/FastCUA#3 (POSTED 2026-07-22 / 2026-07-23)

> Stage-1 comment posted as https://github.com/Guojiz/FastCUA/issues/3#issuecomment-5049270424
> Stages 2-5 comment posted as https://github.com/Guojiz/FastCUA/issues/3#issuecomment-5054052722
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

---

**Stages 2-5: working skill recorder, compiler, and control-plane dry-run — all validated on the same real machine**

Follow-up to the stage-1 feasibility report above. The recorder is now a real
tool (`tools/skill-recorder/`, zero-dep Rust binary + two Node scripts), and
every claim below comes from an automated real-machine suite
(`tests/skill-recorder-validation.mjs`, 60+ checks per run; latest log
`tests/_skillrec-validation-*.log`).

Checkbox status after stages 2-5:

- [x] Semantic anchors surviving app restart — **tested by dry-run.** The demo
  app was killed and relaunched (new HWNDs), then the draft replayed: 4/4
  anchors re-resolved. To make this reliable the daemon's UIA tree now also
  exposes `#AutomationId` per element (restart-stable, language-independent
  key); anchors resolve automation-id first, localized name second, and any
  name drift is reported, never hidden.
- [x] Narration vs literal text — `Ctrl+Alt+N` opens a topmost note dialog in
  the recorder itself; notes land as `note` records outside the demo stream
  and the compiler attaches a note to the next step within 15 s as that
  step's intent (trailing notes become standalone annotations).
- [x] Visual-grid fallback understandability — partial, honestly: dry-run
  resolves through the same tree/agents use, so anything `element_index`
  can't see pauses instead of guessing. Grid-based replay is deliberately NOT
  in v1; an unresolved anchor fails safe (see below) rather than clicking
  pixels.
- [x] Pause/interjection/denial/F10 during recording AND replay — the
  dry-run goes through the normal daemon pipe, not a side channel: pausing
  the control plane mid-replay halts it with `[control_plane:paused]`
  surfaced, zero retries, zero state change (asserted by tree diff).
- [x] Cost after the BMP fix — JPEG sparse keyframes (note/action/focus/
  periodic triggers): **0.689 MB/min measured** vs ~21 MB/min for BMP at
  stage 1. Session JSONL stays ~0.5 MB/min under dense typing.
- [x] New: secrets end-to-end — password input is redacted at the hook (vk +
  value dropped, keyframes suppressed), the compiled draft contains a
  contentless `redacted` step, and the dry-run **never executes it** — no
  decision file can unlock it.
- [x] New: scope containment — the compiler stamps the draft with the exact
  app set demonstrated; the dry-run refuses out-of-scope steps pre-execution
  (decisions cannot widen scope), and the daemon whitelist enforces the same
  wall again at execution time.
- [x] New: fail-safe anchors — negative drill: a draft step whose anchor was
  deliberately corrupted aborts the run at that step (exit 4); later steps
  never run and the app's click counter proves nothing was clicked.
- [x] New: parameter generalization — the fixture demo recorded
  `report-2026-07-23`; the dry-run substituted `{{date}}=2026-08-01`, typed it
  through the real control plane, and the value assertion + final app state
  both confirmed the new value.
- [ ] DPI scaling / multiple monitors — **partially resolved and one real bug
  fixed**: this machine is in fact 150% DPI (stage 1 misreported 96 — the
  stage-1 tool was DPI-unaware and saw virtualized metrics). The recorder now
  declares Per-Monitor-V2 awareness; before the fix, point anchors resolved
  to the wrong element (hook points are physical, virtualized UIA coordinates
  are not). Multi-monitor remains untested.
- [ ] Human physical-input comparison — still owed (unattended machine;
  62/62 events were injected and are labeled `injected:true`; >50% injected
  sessions get a session-level ⚠ in the draft).
- [ ] Audio narration — not built; narration is typed via the note dialog.

How the pieces fit: `skill-recorder.exe` (record) -> `compile.mjs` (draft +
inert SKILL.md, `verified:false`, bilingual UNVERIFIED banner, parameters with
provenance, ⚠ markers for everything uncertain) -> human review ->
`dryrun.mjs` (pre-flight decisions, expected-vs-actual report, exit codes
3=needs-decision / 4=fail-safe / 5=control-plane) -> only the user promotes a
draft into a live skills directory. Full design:
`docs/skill-recorder-design.md`; agent-facing procedure:
`skills/skill-recorder/`.

---

**Media round: screen video + mic audio saved per session, agent-operated promotion (POSTED 2026-07-23)**

Posted as https://github.com/Guojiz/FastCUA/issues/3#issuecomment-5054733257

Follow-up: the session now preserves reviewable media and the flow is fully agent-operated.

- [x] Screen video saved — zero-dep hand-rolled MJPEG-in-AVI (RIFF), 4 fps, long edge ≤1568, ~17.4 MB/min measured; `video/index.jsonl` gives random access by timestamp, and `frame-extract.mjs` pulls any moment as a viewable JPEG so the agent can review a step on demand. One real bug caught by smoke-testing: PrintWindow/BitBlt on hardware-accelerated foreground windows produced all-black frames — capture moved to the screen DC (correct "record the screen" semantics; taskbar and dialogs included).
- [x] Audio saved with graceful degradation — WASAPI mic capture → PCM 16 kHz mono WAV (`audio/narration.wav`); service down / no mic / busy writes one `media unavailable` record and the session continues (verified for real: Windows Audio service was stopped, no fake 44-byte WAV left behind). Transcription remains future work; typed notes stay the machine-readable intent channel.
- [x] Video redaction equals keyframe redaction — during password-focus the video writes marked black frames; the index logged 6 `redacted-gap reason:"password-focus"` records inside the password window, and frame extraction at those timestamps refuses (exit 4: "no pixels at that moment, by design").
- [x] Agent-operated promotion — `skills/skill-recorder/SKILL.md` is now an agent playbook (exact commands, wait points, review template); `promote.mjs --detect-host` finds the host skills dir (env override → Kimi → Claude Code → opencode), refuses without `--yes-i-reviewed`, refuses `verified:false` without `--force-unverified` (which appends its own warning to the copy), and the agent promotes only after explicit user approval in conversation — Cowork's "lands in your skill library" step, with a human gate kept.
- Media stays local: drafts reference relative paths as review aids, bytes are never embedded in SKILL.md (asserted), dry-run ignores media.

Validation: 112/112 real-machine checks (`tests/skill-recorder-validation.mjs`), full regression suite green.

---

**Office end-to-end run: record → compile → dry-run with substitution → promote, all on real Microsoft Excel (draft)**

The full loop now runs against a real Office app, not just the fixture. The
permanent suite (`tests/office-demo-e2e.mjs`) records an expense-table
workflow in Excel (start page → 空白工作簿 → 项目/金额 × 3 rows → =SUM total →
F12 save-as with a date-stamped filename, plus three Ctrl+Alt+N narration
notes), compiles it (23 steps, cell anchors A1..B4 by automation-id, 10
parameters including the save date), kills and relaunches Excel, and dry-runs
the draft with **different** parameter values — then opens the replayed xlsx
with openpyxl and asserts the new values are really in the cells.
Latest: **26/26 checks, three consecutive passes**; replayed A1:B4 =
用品/费用/交通/5600/住宿/400/总计/6000, mismatches `{}`. The promotion gate was
also exercised for real against the Kimi skills dir: `promote.mjs` refused
without flags (exit 3), refused the `verified:false` draft with only
`--yes-i-reviewed` (exit 4), promoted with `--force-unverified` (warning line
appended to the copy), and the promoted skill was removed again afterward.
Example artifacts: `examples/skill-recorder-office-demo/` (draft.json +
SKILL.md + README, no media bytes).

What teaching Excel taught the recorder — four root causes found this round,
each now covered by a regression check:

1. **Excel's DataItem UIA Name is the cell ADDRESS, not the content** ("A1"
   stays "A1" even when the cell holds 用品). Content lives only in the
   ValuePattern. A name-based commit assertion reads green-tree evidence
   wrong and false-fails; the dry-run now treats the mid-edit null read as
   expected and leaves content verification to the saved file (asserted via
   openpyxl in-suite).
2. **ValuePattern.SetValue is vacuous on Excel DataItems** — the value reads
   back correctly (provider caches it) but the sheet stays EMPTY; the
   provider never enters edit mode. DataItem type steps now replay with real
   caret keystrokes exactly as recorded, and the focusing pre-click was
   dropped (the recorded navigation already activates the anchor cell; the
   extra click risks landing in the Name Box, which silently swallows typed
   text as an invalid range name).
3. **SetValue silently reverts in classic comdlg filename boxes on focus
   loss** — an 84-char full save path passed its value assertion, then Tab
   restored the combo's internal selection and the file was saved as
   `工作簿1.xlsx` into the dialog's current directory. The tell is in the
   recording itself: when the demonstrated flow did its own Ctrl+A before
   typing, the replay switches that Edit step to real keystrokes (plus a
   synthetic Ctrl+A, because the focusing click collapses the recorded
   selection). Edits without a recorded select-all keep SetValue (the fixture
   suite's 112/112 proves that path).
4. **Cold-start UIA materialization vs the circuit breaker** — the first
   workbook tree snapshot after an Excel cold start exceeds the host's 1.5 s
   default probe; one strike too many session-disables UIA for the app and
   every later snapshot degrades to a 24-line HWND fallback that no anchor
   survives. The escape hatch: `uia_probe_ms` is now a per-request client
   parameter (daemon passthrough, clamped at 30 s, echoed back as
   `uia.probe_ms`); the dry-run resolves with a 20 s budget and the profile
   logged zero hangs across the passing runs.

Validation: office-demo-e2e 26/26 ×3, skill-recorder-validation 112/112,
protocol-regression 24/24 (incl. the new probe-echo contract), server-lifecycle
and control-plane integration green. Fresh logs under `tests/_*.log`.
