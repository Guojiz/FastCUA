# FastCUA Skill Recorder — design notes (issue #3, stages 2–5)

A standalone "record a skill" tool, modeled on Claude Cowork's *Record a
skill*: the user demonstrates a workflow on the real desktop while narrating
intent; the tool produces a **non-executable, explicitly unverified**
evidence package. A separately configured, tool-less subagent writes natural-language
`SKILL.md`; provenance lint rejects unsupported prose before review.

Seven parts:

| piece | path | responsibility |
|---|---|---|
| recorder (native, Windows) | `tools/skill-recorder/` | capture |
| evidence compiler | `tools/skill-recorder/compile.mjs` | deterministic evidence + replay draft |
| dedicated writer | `tools/skill-recorder/synthesize.mjs` | natural-language Skill prose |
| provenance lint | `tools/skill-recorder/lint-skill.mjs` | reject missing/fabricated evidence |
| dry-run | `tools/skill-recorder/dryrun.mjs` | replay acceptance evidence |
| video frame extractor | `tools/skill-recorder/frame-extract.mjs` | visual review aid |
| gated promotion | `tools/skill-recorder/promote.mjs` | owner-approved installation |

End-to-end validation on the live machine: `tests/skill-recorder-validation.mjs`
(real-machine suite; drives the FastCuaFixture app through the daemon, records,
compiles, dry-runs, and asserts on every stage including the AVI/index/WAV
media tracks, frame extraction with its redaction gate, and the promotion
gates). `tests/skill-writer-contract.mjs` separately verifies the API handoff,
credential isolation, narration fallback, console contract, and provenance lint.

## Session format: `fastcua-recording/1`

One `session.jsonl` per recording. Line 0 is a header (format tag, tool
version, machine context, redaction policy, hotkey map). Every later line is
one JSON record, flushed line-by-line so a killed recorder still leaves a
readable partial session:

- `key_down` / `key_up` / `mouse_down` / `mouse_up` / `mouse_move` /
  `wheel_*` — raw input with `injected` / `lower_il` provenance flags and
  foreground window bounds. Pointer down/up records carry an **anchor** (see
  below); moves are sampled at most once per ~40 ms and suppressed moves are
  counted. Wheel events remain wheel events and are never inferred as drags.
- `focus_change` / `heartbeat` — UIA snapshot of the focused element
  (role, numeric control type, automation id, name + `name_localized`,
  `is_password`, bounds, value class).
- `keyframe` — sparse JPEG (quality 75) with `reason`
  (`note` / `action` / `focus` / `periodic`) or `suppressed:true` in a
  password context. Measured cost in validation: ~0.7 MB/min, target < 2 MB/min.
- `note` — narrator text submitted via the Ctrl+Alt+N dialog.
- `media` — media-track availability note (`kind:"audio"`,
  `status:"ok"|"unavailable"`, `detail`). Emitted early so a missing/busy
  microphone is visible in the session without failing it.
- `stats` — hook health (callbacks, avg callback µs, dropped count) plus
  media counters (`video_frames`, `video_bytes`, `video_gaps`,
  `audio_bytes`).

The header also carries a `media` block naming the session-relative media
files (`video/video.avi`, `video/index.jsonl`, `audio/narration.wav`; `null`
when a track was disabled).

### Anchors

Every input event tries to name *what* it hit, so the compiler can attach
steps to UI elements instead of bare coordinates:

- pointer down/up: `ElementFromPoint` at both gesture endpoints (300 ms bounded worker).
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
  recorded as `suppressed:true` with no image, and **video frames are
  replaced by marker black frames** logged as gaps (`reason:"password-focus"`).
- Secure desktop (UAC/lock screen): marker only, no snapshots or keyframes;
  the video track logs a `secure-desktop` gap.
- The recorder's own windows (note dialog, REC indicator) are excluded from
  the demonstration stream; its hotkey chords (Ctrl+Alt+N/R/X) are filtered.
- All input is labeled `injected:true/false`; a session driven entirely by
  automation gets a session-level ⚠ warning in the draft.

### Controls

Ctrl+Alt+N note dialog (topmost, Enter or button submits a `note` record),
Ctrl+Alt+R pause/resume, Ctrl+Alt+X emergency stop, topmost REC indicator,
`--duration-ms` cap, console Ctrl+C handled.

## Media tracks (stage 5)

The session directory is `session.jsonl` + `keyframes/` + `video/` +
`audio/` — all local, all review aids. Media is **never** embedded in drafts
and never required by a replay.

**Video** — `video/video.avi`: zero-dependency MJPEG-in-AVI written by hand
(RIFF/AVI, no codec install, no ffmpeg). Defaults: 4 fps, long edge ≤ 1568 px
(aspect preserved, even-rounded), JPEG quality 70 — tunable via
`--video-fps` / `--video-max-edge` / `--video-quality`. Frames are captured
with `PrintWindow`/`BitBlt` into a fixed HALFTONE-scaled canvas and encoded
as independent JPEGs (every frame is a keyframe — exactly what random-access
review wants). `video/index.jsonl` logs `{i, ts, kind:"frame", off, len}` per
frame (absolute byte offset + JPEG length in the AVI) between a
`t:"video-index"` header and a `t:"video-footer"` byte-total line, so
`frame-extract.mjs` can slice any moment out by timestamp without parsing
the AVI. During password focus or the secure desktop the encoder writes a
marker **black frame** and the index logs `kind:"gap"` with the reason —
the moment provably has no pixels. The recorder's own windows never appear.

**Audio** — `audio/narration.wav`: PCM 16 kHz mono 16-bit, captured with
WASAPI shared-mode from the default microphone. Capture is best-effort and
never fails the recording. At synthesis time, the console-selected policy is:
writer model reads WAV directly; optional transcription model converts it to
text; typed narration/recorded notes are the final fallback. `typed` mode
keeps audio local. Narration is untrusted evidence, never an instruction.
**Review aids** — `frame-extract.mjs <session-dir> (--at-ms N | --at ISO |
--note N)` resolves the index entry with largest `ts <= T` and writes its
JPEG (SOI/EOI-validated); a gap entry exits 4 with an explanation instead of
inventing pixels. `compile.mjs` surfaces media as session-relative paths in
`evidence.media`, `evidence.md`, and the compatible replay draft. The writer may
describe review commands but lint forbids embedded media; `dryrun.mjs` ignores
media entirely.

**Promotion** — `promote.mjs` is the only path from `skill-draft/` into a
live skills directory, and it is gated: the agent runs it, but only after
explicit user approval in conversation (never silently). `--detect-host`
lists candidate skills directories in priority order (`FASTCUA_SKILLS_DIR` →
Kimi Work `%APPDATA%\kimi-desktop\daimon-share\daimon\skills` → Claude Code
`~/.claude/skills` → opencode `~/.config/opencode/skills`), each with an
`exists` flag. Gates: exit 3 without `--yes-i-reviewed`; exit 4 on a
`verified:false` draft without `--force-unverified` (forced copies get an
extra WARNING appended); exit 5 on an existing target without `--overwrite`.
A successful run verifies the promoted `SKILL.md` exists and prints a reload
hint (Kimi Work indexes skills at session start).

## Dedicated-agent configuration reference

The role separation follows the same useful pattern documented by OpenCode:
a subagent has its own role/prompt and can select a model independently, while
provider/model configuration and credentials are managed separately. FastCUA
adapts that pattern to a local control console and an OpenAI-compatible API;
it does not depend on OpenCode at runtime.

- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/providers/

## Evidence compiler, dedicated writer, and lint

`compile.mjs` converts `fastcua-recording/1` into
`fastcua-skill-evidence/1` plus `fastcua-skill-draft/1`. The evidence package
retains raw provenance, anchors, app scope, parameters, warnings, redactions,
and local media references. `--skill NAME` writes a synthesis request only;
the mechanical compiler never composes Skill prose.

The FastCUA console configures a dedicated OpenAI-compatible writer endpoint,
writer model, optional transcription model, and narration policy. Public
settings live under `config.skillWriter`; the API key is stored in a separate
local secret file. GET responses expose only `hasApiKey` and a last-four hint.
This follows the same separation-of-role idea as a configurable subagent: the
writer receives evidence but no desktop tools and cannot expand recorded
scope.

`synthesize.mjs` performs the handoff. In auto mode it attempts direct audio,
then the configured transcription API, then typed narration/recorded notes.
It writes `SKILL.md` only after `lint-skill.mjs` accepts the candidate. Lint
requires trigger-oriented frontmatter, `verified:false`, App scope and Safety
sections, at most 200 lines, and complete/known citations for every step,
parameter, and warning. Unknown citations and invented parameters fail.

Step construction remains deterministic: paired pointer gestures (small
movement → click; significant down/move/up displacement → drag), independent
wheel scroll steps with axis/delta/point, UIA-value-derived type runs, named
command chords, contentless redacted steps, 15-second
note-to-intent attachment, parameter inference with provenance, and explicit
unresolved markers. `draft.json` remains the only dry-run input.

## Dry-run runner (`dryrun.mjs`, stage 5)

`node dryrun.mjs <draft.json> --params '{...}' --decisions decisions.json --report out.json`

Replays a reviewed draft through the **normal FastCUA control plane** (daemon
pipe) — approvals, whitelist, F7–F10 pause/interjection all stay active, and a
`[control_plane:*]` block halts the replay (exit 5, never retried). Hard
rules:

- pre-flight lists every needed decision (session ⚠ warnings, unresolved
  steps, missing parameters, legacy pointer evidence/Win-chord steps) BEFORE
  anything executes (exit 3);
- redacted steps never execute and out-of-scope steps are refused outright —
  decisions cannot unlock either;
- anchors re-resolve against the live tree: `#AutomationId` first (the native
  host now exposes it per tree line — restart-stable and language-independent),
  localized name second, unique-role last with `name_drift` reported;
- an unresolvable/ambiguous anchor fails safe (exit 4) — nothing is clicked;
- `drag` resolves both endpoint anchors and replays window-relative endpoints
  through the normal left-button drag primitive; wheel scroll replays its
  independent axis/delta at the recorded window-relative point;
- `type` steps replay as "achieve the recorded committed value": focus, read
  `focused_value`, `type_text replace:true` with the parameter-substituted
  text, then assert the end value;
- the JSON report (`fastcua-skill-dryrun/1`) logs expected-vs-actual per step.

## Comparison to Cowork's "Record a skill"

| | Cowork | FastCUA skill-recorder |
|---|---|---|
| capture | screen video + narration audio | UIA event stream + sparse JPEG keyframes + typed notes + local MJPEG video + local WAV narration |
| anchors | inferred from video by the model | direct UIA element identity at input time |
| output | skill draft, model-written | deterministic evidence → dedicated writer → provenance lint |
| secrets | relies on model discretion | structural: vk/value dropped, keyframes suppressed, video gaps |
| verification | n/a | `verified:false` + ⚠ markers; nothing is executable |
| promotion | n/a | gated `promote.mjs`; user approval required, never silent |

## Known gaps / honest limits

- Audio understanding depends on the configured provider/model. `auto` reports each failed tier and falls back safely; `typed` avoids remote audio upload.
  Video is MJPEG (every frame a keyframe) — simple and seekable, but larger
  than an inter-frame codec would be; size is bounded by the 4 fps / 1568 px
  defaults.
- Physical-input provenance is identical hook code but was validated with
  injected input only (unattended machine) — 62/62 events flagged injected.
- Type-step text is the control's whole value snapshot (e.g.
  `initial-value` + typed text), not a per-keystroke diff; the dry-run
  therefore replays type steps with `replace:true` + a value assertion.
- Win-modifier chords, legacy scroll records without window bounds, and
  right/middle-button drags are not replayable (explicit skip required).
  Curved drag paths are retained in evidence, but the current replay primitive
  uses the recorded endpoints and therefore requires explicit review.
- Grid/pixel replay deliberately absent: an anchor the UIA tree cannot
  re-resolve pauses instead of falling back to coordinates.
- Windows only; UIA vtable slots are the stage-1-verified mapping.
