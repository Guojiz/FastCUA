# skill-recorder CLI reference

Three tools, one pipeline: `record → compile → dry-run`. Session format spec:
repo `docs/skill-recorder-design.md` (`fastcua-recording/1`).

## 1. Recorder — `tools/skill-recorder/target/release/skill-recorder.exe`

Build once: `cd tools/skill-recorder && cargo build --release --offline`.

```
skill-recorder.exe [--out DIR] [--duration-ms N] [--keyframe-interval SEC]
                   [--uia-poll-ms N] [--no-indicator]
```

| flag | default | meaning |
|---|---|---|
| `--out DIR` | `recordings/<ts>` | session directory (`session.jsonl` + `keyframes/`) |
| `--duration-ms N` | none | auto-stop cap |
| `--keyframe-interval SEC` | 30 (min 5) | periodic JPEG cadence (note/action/focus frames fire independently) |
| `--uia-poll-ms N` | 200 (min 50) | focus snapshot cadence |
| `--no-indicator` | off | hide the topmost REC indicator |

Hotkeys: `Ctrl+Alt+N` narration note · `Ctrl+Alt+R` pause/resume · `Ctrl+Alt+X` stop.
Console Ctrl+C also stops cleanly. Per-line flushed JSONL: a killed recorder
still leaves a parseable session.

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
marking.

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
