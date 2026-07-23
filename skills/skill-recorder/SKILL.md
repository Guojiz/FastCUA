---
name: skill-recorder
description: Record a Windows GUI demonstration into an auditable, non-executable skill draft via FastCUA's skill-recorder (record -> compile -> review -> dry-run -> user promotes). Use when the user wants to "record a skill", teach a repetitive GUI workflow, or capture how something is done.
---

# Skill Recorder

Record a real Windows demonstration and turn it into an **auditable, explicitly unverified** skill draft. Modeled on "record a skill" workflows, with hard safety invariants Cowork-style tools lack: structural secret redaction, fixed app scope, and a draft that can never silently execute or install itself.

**Prerequisite: the `computer-use` skill.** Recording and dry-run both go through the normal FastCUA control plane (`sky-computer-use` MCP). Read and follow the `computer-use` skill first; if FastCUA is not connected, stop and say so — do not substitute PowerShell UI Automation, SendKeys, or pyautogui.

**This folder is the only agent procedure** for recording. The repo README and design docs are for humans.

## When to offer recording

- The user asks to "record a skill", "watch me do this", "learn this workflow".
- A repetitive GUI workflow is worth teaching (form filling, report export, multi-app routine).
- The user wants a reviewable draft of how something is done — not just a one-off automation.

Do NOT offer recording for: one-off tasks (just do them), credential flows (the redacted step can never be replayed anyway), or apps outside the FastCUA whitelist policy.

## Safety invariants (never compromise these)

1. **The draft never installs itself.** Output goes to a `skill-draft/` folder marked `verified: false`. Only the user copies a reviewed draft into a live skills directory.
2. **Secrets are structurally redacted.** Password fields (UIA `IsPassword` or `ES_PASSWORD`) drop vk codes and values at the hook, and suppress keyframes. No secret exists anywhere in the session, draft, or skill folder — and none can be reconstructed. Still, tell the user to prefer throwaway credentials during a demo.
3. **Secure desktop exclusion.** UAC / lock-screen / credential UI records a marker only — no input, no snapshots, no frames.
4. **App scope is fixed at record time.** A compiled workflow may only touch the apps demonstrated. The dry-run refuses out-of-scope steps outright, and the daemon whitelist enforces the same boundary again at execution.
5. **Unresolved never silently executes.** Every `⚠ unresolved` step (injected input, missing/low-confidence anchor, unrecovered text, missing narration) pauses the dry-run until an explicit decision file says `proceed` or `skip`.
6. **Redacted steps never execute.** No decision can unlock a password step.
7. **Dry-run uses the normal control plane.** Approvals, whitelist, F7–F10 pause/stop, and interjection all stay active during replay. A control-plane block halts the replay immediately and is never retried.
8. **The recorder never records itself.** Its note dialog, REC indicator, and hotkey chords (Ctrl+Alt+N/R/X) stay out of the demonstration stream.

## Procedure

### 1. Prepare

- Confirm FastCUA is connected (computer-use bootstrap) and the target app is covered by the daemon whitelist (or the user is present to approve).
- Tell the user: what will be recorded (input events + UIA anchors + sparse JPEG keyframes + typed narration notes), where files go, the redaction guarantees above, and the hotkeys they control:
  - `Ctrl+Alt+N` — narration note dialog (type intent, Enter to submit)
  - `Ctrl+Alt+R` — pause/resume recording
  - `Ctrl+Alt+X` — emergency stop
- Agree on the app scope and a throwaway parameter value (e.g. a test date/name) to demonstrate with.

### 2. Record

Build the recorder once if missing, then start it:

```powershell
cd tools/skill-recorder; cargo build --release --offline   # once
tools/skill-recorder/target/release/skill-recorder.exe --out recordings/<name> --duration-ms 600000
```

A topmost **REC** indicator is visible the whole time. Hand control to the user (or drive the demo yourself through computer-use tools when the user asks for a synthetic demo). Encourage a `Ctrl+Alt+N` note **before** each meaningful step — notes within 15 s before a step become that step's intent.

Stop with `Ctrl+Alt+X` (or the duration cap). The session is `recordings/<name>/session.jsonl` (format `fastcua-recording/1`) plus `keyframes/`.

### 3. Compile

```powershell
node tools/skill-recorder/compile.mjs recordings/<name>/session.jsonl --skill <skill-name>
```

Outputs: `draft.json` + `draft.md` (both inert) and `skill-draft/<skill-name>/SKILL.md` (`verified: false`, bilingual UNVERIFIED banner).

### 4. Present the draft for review — required

Show the user, in chat:

- the **parameters table** (each `{{param}}`, its kind, the observed value, provenance);
- every **⚠ unresolved marker** and what it means (injected input, weak anchor, unrecovered text, missing narration);
- the **redacted steps** (count only — content never exists);
- the **app scope** list;
- the step list with intents.

The user edits the draft/SKILL.md or asks for a re-record. Do not proceed to dry-run without the user seeing this.

### 5. Dry-run (stage-gated, through the normal control plane)

```powershell
node tools/skill-recorder/dryrun.mjs recordings/<name>/draft.json \
  --params '{"date":"2026-08-01"}' --decisions decisions.json --report dryrun-report.json
```

- Without a decisions file the run **pauses in pre-flight** (exit 3) and lists exactly which steps need a human/agent decision. Create `decisions.json` (`{"session":"acknowledge","default":"proceed"}` or per-step `"steps":{"3":"skip"}`) only after the user ruled on the ⚠ markers.
- Use a **different** parameter value than recorded to prove generalization.
- The report logs expected-vs-actual per step (anchor matched via automation id / name / role, value assertion). A step whose anchor cannot re-resolve **fails safe** — the run aborts instead of clicking somewhere wrong.
- Iterate: re-record, hand-edit anchors, or adjust decisions until the dry-run is clean.

### 6. Promotion — the user's act, never yours

Only after a clean dry-run, offer: "copy `skill-draft/<name>/` into your skills directory". The user (or the user explicitly instructing you) performs the copy. The `verified: false` marker and UNVERIFIED banner stay until the user removes them after their own testing.

## Reference

| Doc | Path (relative to this skill) | When |
|-----|-------------------------------|------|
| cli | `docs/cli.md` | recorder / compiler / dry-run flags, exit codes, decisions + report formats |
| design | repo `docs/skill-recorder-design.md` | session format spec, architecture, comparison to Cowork, known gaps |
