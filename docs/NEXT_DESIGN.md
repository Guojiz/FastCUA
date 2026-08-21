# FastCUA Next Design: Close the Implementation Gaps

**Status:** Authoritative plan for behavior that the current repository does not yet match.

The [technical paper](TECHNICAL_PAPER.md) describes FastCUA's implemented control system and recommended user path. This document holds the mismatches and unfinished redesigns so they are not presented as completed features.

## 1. Fixed product decisions

### 1.1 One installation path

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

### 1.2 One full-capability primary model

FastCUA recommends one active model with the capabilities needed for the whole task:

- strong reasoning and instruction following;
- text and image understanding;
- native audio understanding when recorded narration is used;
- reliable Skill and MCP tool use;
- enough context for observation, execution, evidence review, and Skill writing.

The same model plans the task, operates Windows, reviews recorder evidence, and writes the reusable Skill. FastCUA does not configure a writer model, transcription model, fallback model, or cheaper text-only submodel. If the active model cannot understand narration audio, the user supplies typed notes; FastCUA does not silently route the data elsewhere.

### 1.3 Documentation must separate truth from plans

- README: supported user path only.
- Technical paper: implemented mechanisms, measured evidence, and explicit limitations.
- This document: implementation mismatches, migrations, and acceptance criteria.
- Skill/API references: exact instructions required by the current recommended path.

## 2. Gap A — remove the legacy package-manager path (implemented)

### Resolved mismatch (2026-08-04)

The PowerShell/GitHub Release installer already performs the real installation, checksum verification, update, and rollback. The repository nevertheless retains an npm wrapper and several npm-facing messages:

- `package.json` and `bin/fastcua.mjs`;
- npm commands in installer prompts, console copy, and tests;
- npm version coupling in release validation;
- optional `npm publish` in `.github/workflows/release.yml`.

These paths duplicate the actual release system and make the installation story ambiguous.

### Implemented changes

1. Replace every generated `npx fastcua doctor/check/update` instruction with the installed PowerShell entry point.
2. Remove npm-specific copy from the console, scripts, tests, and website.
3. Remove `package.json`, `bin/fastcua.mjs`, and npm-only contract tests after no runtime code depends on them.
4. Remove `NPM_TOKEN`, npm registry setup, `npm publish`, and package-version checks from the release workflow.
5. Make `runtime-manifest.json` the release version source; keep Rust component versions synchronized and validated against the tag.
6. Verify that a clean Windows machine can install, diagnose, update, roll back, and uninstall without npm.

### Acceptance criteria

- `rg -i 'npm|npx'` returns no product or documentation references except historical migration notes in this file.
- GitHub Release contains the runtime ZIP, checksum, manifest, and installer.
- installer/update/rollback contract tests pass without `package.json` or `bin/fastcua.mjs`.
- generated desktop setup instructions contain only PowerShell maintenance commands.

## 3. Gap B — remove the separate-model architecture (implemented)

### Resolved mismatch (2026-08-04)

An earlier recorder design added a dedicated OpenAI-compatible Skill writer, a second transcription model, API-key storage, provider/model fields in the control center, and automatic audio fallbacks. The remaining implementation includes:

- `tools/skill-recorder/synthesize.mjs` and `writer-config.mjs`;
- `/api/skill-writer/config` in `daemon.mjs`;
- writer/provider/model/transcription/API-key controls in `web.html`;
- writer configuration in `config.json` and environment variables;
- writer-specific release files and contract tests.

This splits context between models, asks the user to configure extra providers, and conflicts with the single full-capability agent design.

### Target recorder flow

```text
record demonstration
→ compile canonical evidence
→ current primary agent inspects evidence and selected non-redacted media
→ current primary agent writes SKILL.md with evidence citations
→ deterministic provenance lint
→ dry-run with new values
→ explicit human review and promotion
```

Audio handling is simple: the active model understands the WAV directly, or the user provides typed notes. There is no transcription API fallback.

### Implemented changes

1. Make the current agent procedure in `skills/skill-recorder/SKILL.md` the only synthesis path.
2. Keep `compile.mjs`, evidence formats, frame extraction, lint, dry-run, and gated promotion.
3. Remove the writer settings UI and daemon endpoints.
4. Remove writer secret storage, provider/model environment variables, `synthesize.mjs`, and `writer-config.mjs`.
5. Remove writer-specific files from source-install and release-package lists.
6. Replace writer contract tests with a model-independent contract: a fixture `SKILL.md` written from evidence must pass or fail deterministic lint as expected.
7. Confirm that no recorder workflow asks the user for a model name, base URL, API key, transcription model, or fallback choice.

### Acceptance criteria

- one active agent can complete record → evidence → Skill → lint → dry-run → promote;
- no FastCUA page or config contains provider, writer model, transcription model, or writer API-key fields;
- no recording media is transmitted to a separately configured service by FastCUA;
- failure to understand audio asks for typed notes and does not switch models;
- provenance, redaction, scope, dry-run, and promotion gates remain unchanged.

## 4. Other implementation gaps

These are real engineering obligations already identified by source review. They remain secondary to the two product corrections above.

### 4.1 Balanced key chords

Replace `keybd_event` with a single observable `SendInput(INPUT[])` transaction. Preserve left/right modifiers and extended-key metadata, detect physically held modifiers/buttons and abort, tag injected events for diagnostics, and add partial-insertion failure tests.

### 4.2 Destructive UIA isolation

Move synchronous value mutation into a disposable process boundary so a wedged provider can be killed without allowing a late destructive write.

### 4.3 Capture compatibility

Evaluate Windows Graphics Capture as an optional backend for surfaces that `PrintWindow`/`BitBlt` cannot represent, while keeping the same coordinate, redaction, and local-processing contracts.

### 4.4 Local IPC hardening

Apply an explicit current-user ACL to the named pipe and authenticate the control channel (the daemon's named-pipe control methods). Document and test behavior when Windows services expose pipes remotely.

### 4.5 Comparative evaluation

Measure task success, model turns, image bytes/tokens, median/p95 latency, human interventions, and unsafe-action near misses for vision-only, accessibility-only, and hybrid modes across a declared application matrix.

## 5. Delivery order

1. [x] Remove package-manager-facing instructions and release publication.
2. [x] Switch recorder documentation and Skill procedure to the current primary agent.
3. [x] Remove separate writer/transcription code, settings, secrets, and tests.
4. [ ] Re-run installer, release, recorder, Windows fixture, and Office end-to-end suites on a clean interactive Windows machine.
5. Complete input, provider, capture, and IPC hardening.
6. Publish comparative results only after the experiment is reproducible.
