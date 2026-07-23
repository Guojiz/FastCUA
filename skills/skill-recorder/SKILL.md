---
name: skill-recorder
description: Record a Windows GUI demonstration into an auditable, non-executable skill draft, then (only with explicit user approval) promote it into the agent's own skill library. Use when the user wants to "record a skill", teach a repetitive GUI workflow, or capture how something is done. The agent runs the whole flow: record -> wait for the user's demo -> stop -> compile -> review together -> dry-run -> gated promotion.
---

# Skill Recorder — agent playbook

You, the agent, operate this entire flow. The user demonstrates; you run the
recorder, compile the draft, review it **with** the user, dry-run it, and —
only after the user explicitly approves in conversation — promote it into a
skills directory with `promote.mjs`.

Modeled on "record a skill" workflows, with hard safety invariants
Cowork-style tools lack: structural secret redaction, fixed app scope, a
draft that can never silently execute, and a promotion gate that can never
fire without the user's word.

**Prerequisite: the `computer-use` skill.** Recording and dry-run both go
through the normal FastCUA control plane (`sky-computer-use` MCP). Read and
follow the `computer-use` skill first; if FastCUA is not connected, stop and
say so — do not substitute PowerShell UI Automation, SendKeys, or pyautogui.

**This folder is the only agent procedure** for recording. The repo README
and design docs are for humans.

## When to offer recording

- The user asks to "record a skill", "watch me do this", "learn this workflow".
- A repetitive GUI workflow is worth teaching (form filling, report export, multi-app routine).
- The user wants a reviewable draft of how something is done — not just a one-off automation.

Do NOT offer recording for: one-off tasks (just do them), credential flows
(the redacted step can never be replayed anyway), or apps outside the FastCUA
whitelist policy.

## Safety invariants (never compromise these)

1. **Promotion needs the user's explicit word, every time.** You may run
   `promote.mjs` only after the user has clearly approved the promotion in
   the current conversation ("yes, install it", "promote it to my skills").
   Never promote silently, never as a side effect of another step, never
   "to be helpful". If approval is ambiguous, ask.
2. **Secrets are structurally redacted.** Password fields (UIA `IsPassword`
   or `ES_PASSWORD`) drop vk codes and values at the hook, suppress keyframes,
   AND replace video frames with marker black frames (recorded as gaps in the
   frame index). No secret exists anywhere in the session, draft, or skill
   folder — and none can be reconstructed. Still, tell the user to prefer
   throwaway credentials during a demo.
3. **Secure desktop exclusion.** UAC / lock-screen / credential UI records a
   marker only — no input, no snapshots, no frames, video gap marked
   `secure-desktop`.
4. **App scope is fixed at record time.** A compiled workflow may only touch
   the apps demonstrated. The dry-run refuses out-of-scope steps outright,
   and the daemon whitelist enforces the same boundary again at execution.
5. **Unresolved never silently executes.** Every `⚠ unresolved` step
   (injected input, missing/low-confidence anchor, unrecovered text, missing
   narration) pauses the dry-run until an explicit decision file says
   `proceed` or `skip`.
6. **Redacted steps never execute.** No decision can unlock a password step.
7. **Dry-run uses the normal control plane.** Approvals, whitelist, F7–F10
   pause/stop, and interjection all stay active during replay. A
   control-plane block halts the replay immediately and is never retried.
8. **The recorder never records itself.** Its note dialog, REC indicator, own
   video frames, and hotkey chords (Ctrl+Alt+N/R/X) stay out of the
   demonstration stream.

## Procedure

### 1. Prepare (agent + user)

- Confirm FastCUA is connected (computer-use bootstrap) and the target app is
  covered by the daemon whitelist (or the user is present to approve).
- Tell the user exactly what happens, e.g.:

  > I'll record your screen as a low-fps local video, your microphone as a
  > local WAV narration track (if a mic is available — it's fine if not),
  > every input event with its UI anchor, and sparse keyframes. Everything
  > stays in `recordings/<name>/` on this machine; nothing is uploaded.
  > Password fields and the Windows security screen are automatically cut
  > from input, keyframes, and video — the video shows a black frame there.
  > Your hotkeys: **Ctrl+Alt+N** to speak/type a note before a step,
  > **Ctrl+Alt+R** to pause, **Ctrl+Alt+X** to stop at any time.

- Agree on the app scope and a throwaway parameter value (e.g. a test
  date/name) to demonstrate with.
- If the user has no microphone or declines narration, pass `--no-audio`
  (or just let the recorder degrade gracefully — it logs a `t:media`
  `unavailable` note and keeps recording).

### 2. Record (agent runs, user demonstrates)

Build the recorder once if missing, then start it:

```powershell
cd tools/skill-recorder; cargo build --release --offline   # once
tools/skill-recorder/target/release/skill-recorder.exe --out recordings/<name> --duration-ms 600000
```

Useful flags: `--no-video`, `--no-audio`, `--video-fps N` (default 4),
`--video-max-edge N` (default 1568), `--video-quality N` (default 70),
`--no-indicator`.

Then **hand control to the user and wait.** Do not drive the demo unless the
user explicitly asks for a synthetic demo (then drive through computer-use
tools). Encourage a `Ctrl+Alt+N` note **before** each meaningful step —
notes within 15 s before a step become that step's intent.

The session ends with `Ctrl+Alt+X` or the duration cap. Layout:

```
recordings/<name>/
  session.jsonl        fastcua-recording/1 event stream
  keyframes/*.jpg      sparse full-screen JPEGs
  video/video.avi      MJPEG demo video (~4 fps, long edge <=1568)
  video/index.jsonl    per-frame {ts, kind, off, len} — gaps mark redaction
  audio/narration.wav  PCM 16 kHz mono narration (absent if mic unavailable)
```

### 3. Compile (agent)

```powershell
node tools/skill-recorder/compile.mjs recordings/<name>/session.jsonl --skill <skill-name>
```

Outputs: `draft.json` + `draft.md` (both inert) and
`skill-draft/<skill-name>/SKILL.md` (`verified: false`, bilingual UNVERIFIED
banner). Media is referenced by session-relative paths in `draft.media` and
in the SKILL draft's "Review aids" section — never embedded, never copied
into the draft folder.

### 4. Review with the user — required (agent presents)

Show the user, in chat, using this shape:

```
Draft <skill-name> — N steps, M parameters, K warnings
Parameters:  {{date}} (date) — observed "2026-08-01", step 4, typed-value (UIA snapshot)
⚠ unresolved: step 7 — injected input (automation-driven span)
⚠ unresolved: session — no narration notes; intents are structural guesses
Redactions:  3 key events redacted in a password field (content never captured)
App scope:   FastCuaFixture.exe, notepad.exe
Steps:       1. Click left at (… ) on Button(50000) #1001 "Apply" — intent: open the form …
```

The user edits the draft/SKILL.md or asks for a re-record. Do not proceed to
dry-run without the user seeing this.

**Review aids — use them when the user questions a step.** The agent may
*look* at the recorded moment instead of guessing:

```powershell
# frame at the user's 1st narration note (or --at-ms <epoch> / --at <ISO>)
node tools/skill-recorder/frame-extract.mjs recordings/<name> --note 1
```

It writes a JPEG and prints its path; read the image to see exactly what was
on screen. If the moment was redacted (password focus / secure desktop), the
extractor exits 4 and explains — there is nothing to show, by design. For
audio, play `audio/narration.wav` for the user (they listen; **transcription
is out of scope** — never attempt speech-to-text).

### 5. Dry-run (agent, stage-gated, through the normal control plane)

```powershell
node tools/skill-recorder/dryrun.mjs recordings/<name>/draft.json \
  --params '{"date":"2026-08-02"}' --decisions decisions.json --report dryrun-report.json
```

- Without a decisions file the run **pauses in pre-flight** (exit 3) and
  lists exactly which steps need a decision. Create `decisions.json`
  (`{"session":"acknowledge","default":"proceed"}` or per-step
  `"steps":{"3":"skip"}`) only after the user ruled on the ⚠ markers.
- Use a **different** parameter value than recorded to prove generalization.
- The report logs expected-vs-actual per step (anchor matched via automation
  id / name / role, value assertion). A step whose anchor cannot re-resolve
  **fails safe** — the run aborts instead of clicking somewhere wrong.
- The dry-run ignores media entirely (it replays steps, not pixels).
- Iterate: re-record, hand-edit anchors, or adjust decisions until clean.

### 6. Promotion — gated, agent-executed (owner-approved)

Only after review (and, when possible, a clean dry-run), **ask the user
plainly**: "Promote `<skill-name>` into your skills directory?" Wait for an
unambiguous yes. Then:

**6a. Detect the host skills directory** — check in this order:

```powershell
node tools/skill-recorder/promote.mjs --detect-host
```

| Priority | Host | Directory |
|---|---|---|
| 0 | explicit override | `$env:FASTCUA_SKILLS_DIR` (if set) |
| 1 | Kimi Work | `%APPDATA%\kimi-desktop\daimon-share\daimon\skills\` |
| 2 | Claude Code | `~/.claude/skills/` |
| 3 | opencode | `~/.config/opencode/skills/` |
| 4 | fallback | any directory the user names via `--to` |

Pick the entry whose `exists: true` matches the host you are actually running
in; if none exists, ask the user where their skills live.

**6b. Promote:**

```powershell
node tools/skill-recorder/promote.mjs recordings/<name>/skill-draft/<skill-name> \
  --to <skills-dir> --yes-i-reviewed
```

- `--yes-i-reviewed` is mandatory (exit 3 without it) — pass it **only**
  after the user's explicit approval in this conversation.
- A `verified: false` draft also needs `--force-unverified` (exit 4 without
  it); the promoted copy then gets an extra WARNING line appended. Prefer a
  clean dry-run over forcing.
- Existing target refuses unless `--overwrite` (exit 5).

**6c. Confirm:** verify `<skills-dir>/<skill-name>/SKILL.md` exists (the tool
prints it), then tell the user whether the host needs a reload to discover
the skill (Kimi Work indexes skills at session start — suggest a new
session; Claude Code picks it up next session; other hosts: check their
docs). The `verified: false` marker and UNVERIFIED banner stay in the
promoted copy until the user removes them after their own testing.

## Reference

| Doc | Path (relative to this skill) | When |
|-----|-------------------------------|------|
| cli | `docs/cli.md` | recorder / compiler / dry-run / frame-extract / promote flags, exit codes, decisions + report formats |
| design | repo `docs/skill-recorder-design.md` | session format spec, media layout, architecture, comparison to Cowork, known gaps |
