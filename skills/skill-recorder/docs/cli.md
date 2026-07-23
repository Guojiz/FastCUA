# skill-recorder CLI reference

Five tools, one pipeline: `record → compile → dry-run → (review aids) → promote`.
Session format spec: repo `docs/skill-recorder-design.md` (`fastcua-recording/1`).

## 1. Recorder — `tools/skill-recorder/target/release/skill-recorder.exe`

Build once: `cd tools/skill-recorder && cargo build --release --offline`.

```
skill-recorder.exe [--out DIR] [--duration-ms N] [--keyframe-interval SEC]
                   [--uia-poll-ms N] [--no-indicator]
                   [--no-video] [--no-audio]
                   [--video-fps N] [--video-max-edge N] [--video-quality N]
```

| flag | default | meaning |
|---|---|---|
| `--out DIR` | `recordings/<ts>` | session directory (`session.jsonl` + `keyframes/` + `video/` + `audio/`) |
| `--duration-ms N` | none | auto-stop cap |
| `--keyframe-interval SEC` | 30 (min 5) | periodic JPEG cadence (note/action/focus frames fire independently) |
| `--uia-poll-ms N` | 200 (min 50) | focus snapshot cadence |
| `--no-indicator` | off | hide the topmost REC indicator |
| `--no-video` | off | skip the MJPEG demo video track |
| `--no-audio` | off | skip the WASAPI narration track |
| `--video-fps N` | 4 | demo video frame rate |
| `--video-max-edge N` | 1568 | demo video longest edge in px (aspect preserved, even-rounded) |
| `--video-quality N` | 70 | demo video JPEG quality 1–100 |

Hotkeys: `Ctrl+Alt+N` narration note · `Ctrl+Alt+R` pause/resume · `Ctrl+Alt+X` stop.
Console Ctrl+C also stops cleanly. Per-line flushed JSONL: a killed recorder
still leaves a parseable session.

**Media tracks.** `video/video.avi` is a zero-dependency MJPEG-in-AVI (long
edge ≤ `--video-max-edge`, ~`--video-fps` fps); `video/index.jsonl` logs every
frame `{i, ts, kind:"frame", off, len}` for random-access extraction, plus a
footer with byte totals. `audio/narration.wav` is PCM 16 kHz mono 16-bit via
WASAPI shared capture. Audio is **best-effort**: no microphone, busy device,
or access denied produces a `{"t":"media","kind":"audio","status":"unavailable","detail":…}`
record and the session continues — media can never fail a recording.

**Media redaction.** While a password field holds focus, and while the secure
desktop is active, the video track stores a marker black frame and logs
`kind:"gap"` with `reason:"password-focus"|"secure-desktop"` in the index.
The demo's real pixels for those moments do not exist anywhere.

`session.jsonl` gains `{"t":"media",…}` records and a `media` block in the
header; final stats add `video_frames`, `video_bytes`, `video_gaps`,
`audio_bytes`.

## 2. Compiler — `tools/skill-recorder/compile.mjs`

```
node compile.mjs <session.jsonl> [--out DIR] [--skill NAME]
```

Always writes `draft.json` + `draft.md` (non-executable, `verified:false`).
With `--skill NAME`, also writes `<out>/skill-draft/<NAME>/SKILL.md`
(name: lowercase letters/digits/dashes).

What it does: click pairing, type-run merging (text recovered only from UIA
value snapshots — never from vk codes), named command chords, redacted-step
preservation, narration→intent attachment (15 s window), parameter inference
(date / filename / text with provenance), app-scope extraction, ⚠ unresolved
marking, and media bookkeeping (`draft.media` — session-relative paths to
video / index / audio / keyframes; an unavailable audio track becomes
`null` plus the recorder's reason). The SKILL draft gains a "Review aids"
section that references these paths; media bytes are never embedded in any
draft.

## 3. Dry-run — `tools/skill-recorder/dryrun.mjs`

Replays a draft through the normal FastCUA daemon (approval, whitelist,
pause/interjection fully active).

```
node dryrun.mjs <draft.json> [--params '<json>'|@file] [--decisions file.json]
                [--pipe \\.\pipe\fastcua] [--window-title <regex>]
                [--report out.json] [--dry]
```

**Exit codes**

| code | meaning |
|---|---|
| 0 | all steps ok / explicitly skipped |
| 2 | usage error |
| 3 | paused in pre-flight — decisions or parameter values needed (nothing executed) |
| 4 | fail-safe abort — scope violation, anchor unresolved/ambiguous, value mismatch, unsupported step |
| 5 | control-plane stop — paused / shutdown / awaiting approval (never retried) |

**decisions.json**

```json
{
  "session": "acknowledge",
  "default": "proceed",
  "steps": { "3": "skip", "7": "proceed" }
}
```

- `session: "acknowledge"` accepts the session-level ⚠ warnings (e.g. injected
  input spans) after the user reviewed them.
- `default` / per-step values: `proceed` or `skip`. Any step carrying a
  ⚠ unresolved marker without a decision pauses the run (exit 3).
- Decisions **cannot** unlock redacted steps, out-of-scope steps, or missing
  parameter values — those are hard walls.

**Report** (`--report`, format `fastcua-skill-dryrun/1`): per step
`{n, action, status, expected, actual, decision, detail}` — expected anchor
(control_type, automation_id, name) vs actual resolution (`matched_by`:
`automation_id` | `name` | `role-only`, plus `name_drift` when the localized
name changed); type steps add `expected.value` / `actual.value` (the committed
value assertion) and `value_before`.

**How steps replay**

- `click` → resolve anchor against the live UIA tree (automation id first,
  then localized name) → `click element_index`.
- `type` → focus the element, read `focused_value`, `type_text replace:true`
  with the parameter-substituted committed value, then assert the end value.
- `key` → `press_key` with the named chord (Win-modifier chords and opaque vk
  tokens are not replayable — decide `skip`).
- `scroll` → not replayable in v1 (decide `skip`).
- `note` → reported, not executed. `redacted` → never executed.

The dry-run replays **steps**, not media — `draft.media` is ignored.

## 4. Frame extraction — `tools/skill-recorder/frame-extract.mjs`

Review aid: lets an agent (or the user) LOOK at one chosen moment of the
demo video without playing the whole file.

```
node frame-extract.mjs <session-dir> (--at-ms <epoch-ms> | --at <ISO-8601> | --note <N>) [--out file.jpg]
```

Picks the index entry with the largest `ts <= T` and slices its JPEG out of
`video/video.avi` by the stored `off`/`len` (SOI/EOI validated). `--note N`
uses the Nth (1-based) narration note's timestamp. Default output:
`keyframes/extract-<frame>-<ts>.jpg` inside the session.

**Exit codes**: `0` frame written · `2` usage/index/integrity error ·
`3` target moment precedes the first video entry · `4` the moment is a
redaction gap (`password-focus` / `secure-desktop`) — nothing exists to
extract, by design.

## 5. Promotion — `tools/skill-recorder/promote.mjs`

Gated copy of a reviewed draft folder into a host's skills directory. Run by
the agent **only after explicit user approval in conversation** — never
silently.

```
node promote.mjs --detect-host
node promote.mjs <draft-dir> --to <skills-dir> [--yes-i-reviewed] [--force-unverified] [--overwrite]
```

`--detect-host` prints JSON candidates in priority order, each with
`exists`: `FASTCUA_SKILLS_DIR` env override → Kimi Work
(`%APPDATA%\kimi-desktop\daimon-share\daimon\skills`) → Claude Code
(`~/.claude/skills`) → opencode (`~/.config/opencode/skills`).

**Exit codes**

| code | meaning |
|---|---|
| 0 | promoted; prints JSON with the promoted `SKILL.md` path + reload hint |
| 2 | usage/IO error (missing SKILL.md in source) |
| 3 | `--yes-i-reviewed` absent — promotion gate |
| 4 | draft is `verified: false` and `--force-unverified` absent |
| 5 | target `<skills-dir>/<name>` exists and `--overwrite` absent |
| 6 | copy completed but the target SKILL.md is missing |

With `--force-unverified`, an extra WARNING line is appended to the promoted
copy's SKILL.md. After promotion, the host may need a session reload to
discover the skill (Kimi Work indexes skills at session start).
