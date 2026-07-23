# FastCUA Skill Recorder — design notes (issue #3, stages 2–4)

A standalone "record a skill" tool, modeled on Claude Cowork's *Record a
skill*: the user demonstrates a workflow on the real desktop while narrating
intent; the tool produces a **non-executable, explicitly unverified** SKILL.md
draft for human review.

Three parts:

| piece | path | stage |
|---|---|---|
| recorder (native, Windows) | `tools/skill-recorder/` | 2 |
| session → draft compiler | `tools/skill-recorder/compile.mjs` | 3 |
| draft → SKILL.md generator | `compile.mjs --skill NAME` | 4 |

End-to-end validation on the live machine: `tests/skill-recorder-validation.mjs`
(42 checks; drives the FastCuaFixture app through the real daemon, records,
compiles, and asserts on every stage).

## Session format: `fastcua-recording/1`

One `session.jsonl` per recording. Line 0 is a header (format tag, tool
version, machine context, redaction policy, hotkey map). Every later line is
one JSON record, flushed line-by-line so a killed recorder still leaves a
readable partial session:

- `key_down` / `key_up` / `mouse_down` / `mouse_up` / `wheel_*` — raw input
  with `injected` / `lower_il` provenance flags, foreground window, and an
  **anchor** (see below). Mouse moves are coalesced and counted, not logged.
- `focus_change` / `heartbeat` — UIA snapshot of the focused element
  (role, numeric control type, automation id, name + `name_localized`,
  `is_password`, bounds, value class).
- `keyframe` — sparse JPEG (quality 75) with `reason`
  (`note` / `action` / `focus` / `periodic`) or `suppressed:true` in a
  password context. Measured cost in validation: ~0.7 MB/min, target < 2 MB/min.
- `note` — narrator text submitted via the Ctrl+Alt+N dialog.
- `stats` — hook health (callbacks, avg callback µs, dropped count).

### Anchors

Every input event tries to name *what* it hit, so the compiler can attach
steps to UI elements instead of bare coordinates:

- clicks: `ElementFromPoint` at the click point (300 ms bounded worker).
- keystrokes: most recent focus snapshot, ≤ 800 ms old → `confidence:"high"`,
  ≤ 2000 ms → `"low"`, otherwise no anchor.
- anchors carry `value_class` (`text` / `action` / `secret` / `none`) and, for
  text controls, a bounded `WM_GETTEXT` value snapshot. Typed text is only
  ever recovered from these UIA/value snapshots — **vk codes are never
  reverse-mapped to characters**.

The recorder declares Per-Monitor-V2 DPI awareness at startup so hook points,
`ElementFromPoint`, and UIA bounds share one physical-pixel coordinate space
(without this, anchors resolve to the wrong element on scaled displays).

### Redaction and hygiene

- Password fields (UIA `IsPassword` **or** `ES_PASSWORD`): vk and value are
  dropped, records are marked `redacted:"password-field"`, keyframes are
  recorded as `suppressed:true` with no image.
- Secure desktop (UAC/lock screen): marker only, no snapshots or keyframes.
- The recorder's own windows (note dialog, REC indicator) are excluded from
  the demonstration stream; its hotkey chords (Ctrl+Alt+N/R/X) are filtered.
- All input is labeled `injected:true/false`; a session driven entirely by
  automation gets a session-level ⚠ warning in the draft.

### Controls

Ctrl+Alt+N note dialog (topmost, Enter or button submits a `note` record),
Ctrl+Alt+R pause/resume, Ctrl+Alt+X emergency stop, topmost REC indicator,
`--duration-ms` cap, console Ctrl+C handled.

## Compiler + generator (`compile.mjs`)

`node compile.mjs <session.jsonl> [--skill NAME]`

Always emits `draft.json` + `draft.md` (both inert). With `--skill`, also
emits `<out>/skill-draft/<name>/SKILL.md`.

Step building:

- mouse down/up pairing → `click` step with the point anchor.
- printable/IME key runs → `type` step; text is recovered from UIA value
  snapshots only. VK_PACKET (0xE7) marks injected unicode; 0xE5 marks opaque
  IME batches; unrecoverable runs get a ⚠ marker instead of guessed text.
- ctrl/alt + letter chords → named shortcuts (Ctrl+S etc.).
- redacted key runs → contentless `type` step preserving the redaction.
- a `note` within 15 s before a step becomes that step's `intent`, otherwise
  a standalone `note` step.

Parameter inference: dates, file names, and generic typed text become
`{{param}}` placeholders with provenance (step, source, anchor). The SKILL.md
carries frontmatter (`name`, `description`, `verified: false`), a bilingual
"unverified draft" banner, a parameters table, anchor explanations, safety
boundaries, and a reference back to the raw session. Anything the compiler
could not resolve (injected input spans, missing anchors, low confidence,
unrecoverable text, steps without narration, > 50 % injected sessions) is
surfaced as an explicit ⚠ marker — never silently smoothed over.

## Dry-run runner (`dryrun.mjs`, stage 5)

`node dryrun.mjs <draft.json> --params '{...}' --decisions decisions.json --report out.json`

Replays a reviewed draft through the **normal FastCUA control plane** (daemon
pipe) — approvals, whitelist, F7–F10 pause/interjection all stay active, and a
`[control_plane:*]` block halts the replay (exit 5, never retried). Hard
rules:

- pre-flight lists every needed decision (session ⚠ warnings, unresolved
  steps, missing parameters, unreplayable scroll/Win-chord steps) BEFORE
  anything executes (exit 3);
- redacted steps never execute and out-of-scope steps are refused outright —
  decisions cannot unlock either;
- anchors re-resolve against the live tree: `#AutomationId` first (the native
  host now exposes it per tree line — restart-stable and language-independent),
  localized name second, unique-role last with `name_drift` reported;
- an unresolvable/ambiguous anchor fails safe (exit 4) — nothing is clicked;
- `type` steps replay as "achieve the recorded committed value": focus, read
  `focused_value`, `type_text replace:true` with the parameter-substituted
  text, then assert the end value;
- the JSON report (`fastcua-skill-dryrun/1`) logs expected-vs-actual per step.

## Comparison to Cowork's "Record a skill"

| | Cowork | FastCUA skill-recorder |
|---|---|---|
| capture | screen video + narration audio | UIA event stream + sparse JPEG keyframes + typed notes |
| anchors | inferred from video by the model | direct UIA element identity at input time |
| output | skill draft, model-written | deterministic compiler draft, every inference marked |
| secrets | relies on model discretion | structural: vk/value dropped, frames suppressed |
| verification | n/a | `verified:false` + ⚠ markers; nothing is executable |

## Known gaps / honest limits

- No audio narration (typed notes instead) and no `+` menu UI (future work).
- Physical-input provenance is identical hook code but was validated with
  injected input only (unattended machine) — 62/62 events flagged injected.
- Type-step text is the control's whole value snapshot (e.g.
  `initial-value` + typed text), not a per-keystroke diff; the dry-run
  therefore replays type steps with `replace:true` + a value assertion.
- Scroll steps and Win-modifier chords are not replayable in dry-run v1
  (they pause for an explicit skip decision).
- Grid/pixel replay deliberately absent: an anchor the UIA tree cannot
  re-resolve pauses instead of falling back to coordinates.
- Windows only; UIA vtable slots are the stage-1-verified mapping.
