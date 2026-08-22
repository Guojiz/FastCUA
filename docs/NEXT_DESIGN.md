# FastCUA Next Design: Close the Implementation Gaps

**Status:** Authoritative migration plan for behavior that the current repository does not yet fully match.

The current product boundary is defined in [`CURRENT_ARCHITECTURE.md`](CURRENT_ARCHITECTURE.md). This document records implementation mismatches, cleanup work, and acceptance criteria so planned behavior is not confused with already-completed behavior.

The implementation handoff for the headless cleanup is in [`HANDOFF_HEADLESS_RUNTIME.md`](HANDOFF_HEADLESS_RUNTIME.md).

## 1. Fixed product decisions

### 1.1 FastCUA is a headless, host-neutral Windows runtime

FastCUA should provide:

- Windows observation;
- UIA / HWND semantics;
- vision on demand;
- numbered recursive grounding;
- agent-defined ROI;
- coordinate translation;
- native input;
- resident runtime state;
- optional host-control primitives.

FastCUA should **not** prescribe the user-facing interaction model of the Agent or Harness.

The intended split is:

```text
Harness / Host
  ├─ task UX
  ├─ user interaction
  ├─ optional pause / interjection / approval UX
  └─ FastCUA integration
          ↓
FastCUA
  ├─ perception
  ├─ grounding
  ├─ execution
  └─ optional host-control protocol
          ↓
Windows
```

A host may use `pause`, `resume`, `interject`, approval resolution, `shutdown`, or related control semantics, but FastCUA does not need to ship its own overlay, web console, fixed hotkeys, or mandatory control UI.

This is a compatibility decision: different Harnesses should be able to reuse FastCUA without inheriting FastCUA-specific UX.

### 1.2 Preserve host-control semantics while removing FastCUA-owned UX

Do not interpret the headless migration as “remove human control.”

The following may remain valid runtime capabilities:

```text
pause
resume
interject
resolve_approval
shutdown
```

What becomes legacy is the FastCUA-owned presentation layer around them.

The cleanup must distinguish:

```text
host-control protocol        KEEP / REVIEW
FastCUA-owned control UI      RETIRE
```

### 1.3 One installation path

FastCUA is installed and maintained through the PowerShell bootstrapper and verified GitHub Release artifacts. npm is not a user-facing installation, update, doctor, or release path.

Canonical install:

```powershell
irm https://raw.githubusercontent.com/Guojiz/FastCUA/main/install.ps1 | iex
```

Canonical maintenance:

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Doctor
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Check
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Update
```

### 1.4 One full-capability primary model

FastCUA recommends one active model with the capabilities needed for the whole task:

- strong reasoning and instruction following;
- text and image understanding;
- native audio understanding when recorded narration is used;
- reliable Skill and MCP tool use;
- enough context for observation, execution, evidence review, and Skill writing.

The same model plans the task, operates Windows, reviews recorder evidence, and writes the reusable Skill. FastCUA does not configure a writer model, transcription model, fallback model, or cheaper text-only submodel.

### 1.5 Documentation authority

Until implementation and documentation are fully synchronized, use this order when documents disagree:

1. `CURRENT_ARCHITECTURE.md` for the current product boundary;
2. this file for migration obligations;
3. README / README_zh for supported user-facing explanation;
4. `TECHNICAL_PAPER.md` for implementation-backed historical/current mechanisms, noting that some old UI-era wording still needs synchronization.

## 2. Gap A: remove the FastCUA-owned Human Control UI layer

### Current mismatch

The current `main` branch still contains pieces from an older architecture where FastCUA itself owned the user-facing control experience.

Likely legacy areas include:

- `overlay.ps1`;
- `card.xaml`;
- `web.html` when used as FastCUA's own control center;
- fixed F7/F8/F9/F10 UX;
- overlay-specific configuration;
- daemon HTTP endpoints used only by the retired local UI;
- release packaging for those UI assets;
- tests that verify only those UI surfaces.

These are not part of the desired product boundary.

### Preserve while cleaning

Do not accidentally remove:

- host-facing pause/resume semantics;
- interjection semantics;
- approval policy and resolution;
- shutdown / stop semantics used by hosts;
- named-pipe control methods or their eventual equivalent;
- agent-visible control-state tags where host integrations rely on them;
- safety validation and application identity logic.

### Target implementation

```text
Host UI / Harness policy
          ↓
optional host-control protocol
          ↓
FastCUA daemon/runtime
          ↓
Windows
```

FastCUA should start and operate without any FastCUA-owned visible UI.

### Acceptance criteria

- Computer Use works with no overlay, control center, or FastCUA-owned hotkey UI;
- runtime startup has no dependency on `overlay.ps1`, `card.xaml`, or the old control-center page;
- release artifacts do not ship retired UI files unless an explicitly supported host still consumes them;
- external hosts can still use retained pause/interjection/approval/shutdown semantics;
- tests distinguish protocol semantics from retired presentation code;
- README, architecture docs, technical paper, and website no longer present FastCUA-owned Human Control UX as a core product feature.

## 3. Gap B: preserve and expose active visual observation clearly

FastCUA's visual design is broader than a fixed numbered grid.

Two supported narrowing modes must remain explicit:

```text
A. Discrete recursive grounding
window → numbered region → 3×3 → 3×3 → commit

B. Agent-defined ROI
window → arbitrary rectangle → smaller rectangle → commit
```

The ROI path matters because the model can decide where the next observation should come from using arbitrary window-relative bounds:

```text
left
top
right
bottom
```

The implementation and Skill/API documentation should make this a first-class capability rather than an incidental helper.

### Acceptance criteria

- Agent-defined ROI remains usable independently of the numbered-grid path;
- visual observation can narrow to an arbitrary rectangle chosen by the model;
- local coordinate mapping remains deterministic;
- grid and ROI modes can be composed;
- the runtime, not the model, handles crop offsets, scale reversal, window geometry, and DPI mapping;
- no refactor reduces the system back to full-window direct XY as the only visual path.

## 4. Gap C: remove the legacy package-manager path

### Resolved mismatch

The PowerShell/GitHub Release installer already performs the real installation, checksum verification, update, and rollback. The repository previously retained an npm-facing wrapper and messages that duplicated the supported path.

### Required state

- generated setup instructions use PowerShell only;
- release workflow does not require npm publication;
- runtime manifest remains the release version source;
- clean Windows install/update/rollback/uninstall works without npm.

### Acceptance criteria

- `rg -i 'npm|npx'` returns no active product-path references except historical migration notes;
- GitHub Release contains runtime ZIP, checksum, manifest, and installer;
- installer/update/rollback tests do not depend on `package.json` or an npm wrapper.

## 5. Gap D: keep one full-capability primary model

### Resolved mismatch

An earlier recorder design added a dedicated Skill writer, transcription model, provider configuration, API-key storage, and fallback routing.

The desired flow is:

```text
record demonstration
→ compile canonical evidence
→ current primary agent inspects evidence and selected non-redacted media
→ current primary agent writes SKILL.md with evidence citations
→ deterministic provenance lint
→ dry-run with new values
→ explicit human review and promotion
```

FastCUA should not configure a separate writer/transcription stack.

### Acceptance criteria

- one active agent can complete record → evidence → Skill → lint → dry-run → promote;
- no product page or config requires writer model, transcription model, provider base URL, or extra API key;
- failure to understand audio asks for typed notes rather than silently switching models;
- provenance, redaction, scope, dry-run, and promotion gates remain intact.

## 6. Other engineering obligations

### 6.1 Balanced key chords

Replace `keybd_event` with a single observable `SendInput(INPUT[])` transaction. Preserve left/right modifiers and extended-key metadata, detect physically held modifiers/buttons and abort, tag injected events for diagnostics, and add partial-insertion failure tests.

### 6.2 Destructive UIA isolation

Move synchronous value mutation into a disposable process boundary so a wedged provider can be killed without allowing a late destructive write.

### 6.3 Capture compatibility

Evaluate Windows Graphics Capture as an optional backend for surfaces that `PrintWindow` / `BitBlt` cannot represent, while keeping the same coordinate, redaction, and local-processing contracts.

### 6.4 Local IPC hardening

Apply an explicit current-user ACL to the named pipe and authenticate any mutating local control channel. Document and test behavior when Windows services expose pipes remotely.

### 6.5 Comparative evaluation

Measure task success, model turns, image bytes/tokens, median/p95 latency, human interventions, and unsafe-action near misses for vision-only, accessibility-only, and hybrid modes across a declared application matrix.

Do not claim token or task-success advantages before this comparison is reproducible.

## 7. Delivery order

1. [x] Make the headless/host-neutral boundary explicit in README and architecture docs.
2. [x] Add a code handoff that separates retired UX from retained host-control protocol.
3. [ ] Inventory every dependency on the old FastCUA-owned overlay/control-center layer.
4. [ ] Add preservation tests for host-control protocol behavior before deleting UI code.
5. [ ] Remove overlay/web/hotkey dependencies from runtime startup.
6. [ ] Remove obsolete UI assets, UI-only config, UI-only HTTP plumbing, release entries, and UI-only tests.
7. [ ] Re-run installer, release, recorder, Windows fixture, and Office end-to-end suites on a clean interactive Windows machine.
8. [ ] Synchronize `TECHNICAL_PAPER.md` and the project website with the resulting implementation.
9. [ ] Complete input, provider, capture, and IPC hardening.
10. [ ] Publish comparative results only after the experiment is reproducible.
