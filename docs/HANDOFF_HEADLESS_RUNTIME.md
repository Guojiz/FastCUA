# FastCUA Handoff Card: Headless Runtime Cleanup

**Purpose:** hand off the next code phase without losing the product boundary established in `CURRENT_ARCHITECTURE.md`.

## Goal

Refactor FastCUA so the implementation matches the intended architecture:

> **FastCUA is a headless, host-neutral Windows Computer Use runtime.**

FastCUA should keep Windows observation, grounding, execution, runtime policy, and optional host-control primitives while removing its own retired control-center / overlay UX.

## Non-negotiable boundary

Do **not** interpret this work as “remove human control.”

The correct split is:

```text
Harness / Host
  ├─ user-facing controls
  ├─ pause/interjection/approval UX
  └─ product-specific presentation
          ↓
FastCUA host-control protocol (optional)
          ↓
FastCUA Windows runtime
```

The old **FastCUA-owned UI** is legacy. The **host-facing control semantics** are not.

## Preserve

The next engineer should preserve unless there is a separately justified redesign:

- `pause` / `resume` semantics used by external hosts;
- `interject` semantics;
- approval resolution and runtime approval policy;
- `shutdown` / stop semantics where part of the host protocol;
- named-pipe or equivalent host-control transport;
- application identity and whitelist logic;
- agent-visible control-state tags if external hosts still depend on them;
- tests that verify protocol behavior independently of the retired UI;
- UIA-first observation;
- `good` / `weak` / `broken` quality routing and `prefer_vision`;
- numbered grid + recursive 3×3 refinement;
- agent-defined ROI through arbitrary window-relative bounds;
- deterministic crop → window → screen coordinate mapping;
- DPI and near-effect validation;
- resident daemon / shared native-host model.

## Legacy implementation to inspect

The following are likely remnants of the old FastCUA-owned Human Control product layer and should be reviewed for removal or decoupling:

### UI files

- `overlay.ps1`
- `card.xaml`
- `web.html` when it serves FastCUA's own control center

### Daemon UI glue

Inspect `daemon.mjs` for code whose only purpose is the retired local UI, including:

- spawning / supervising the overlay;
- serving the web control center;
- HTTP endpoints used only by that UI;
- UI-specific event formatting;
- overlay lifecycle state;
- UI-only configuration loading.

Do **not** delete underlying host-control methods merely because the old HTTP/overlay layer called them.

### Configuration

Review fields such as:

```text
overlayEnabled
overlayTitle
overlayLanguage
port
bannerEnabled
```

Remove only fields that are genuinely tied to retired FastCUA-owned UI surfaces.

Do not conflate them with runtime policy fields such as approval policy or whitelist state.

### Release packaging

Inspect release/build scripts for packaging of:

```text
overlay.ps1
card.xaml
web.html
```

A headless runtime should not ship files that no supported integration consumes.

### Tests

Classify tests by **behavior**, not filename.

Keep tests that verify:

- pause/resume protocol semantics;
- interjection semantics;
- approval lifecycle;
- cancellation;
- host-control state transitions;
- runtime safety and fail-stop behavior.

Remove or rewrite tests that verify only:

- FastCUA's own overlay rendering;
- F7/F8/F9/F10 behavior;
- local control-center HTTP UI;
- retired UI-specific configuration.

## Important targeting requirement

Do not regress the active-perception behavior while doing cleanup.

FastCUA supports two visual narrowing modes:

```text
A. numbered grid
window → cell → 3×3 → 3×3 → commit

B. agent-defined ROI
window → arbitrary rectangle → smaller rectangle → commit
```

The second path matters. The agent should be able to choose arbitrary `left / top / right / bottom` bounds rather than being forced through a fixed grid.

The model chooses where to observe. The runtime owns geometry and coordinate transforms.

## Suggested implementation order

1. **Inventory dependencies**
   - map all references to `overlay.ps1`, `card.xaml`, `web.html`, HTTP control endpoints, UI-only config fields, and fixed hotkeys;
   - map all external-host control methods separately.

2. **Write preservation tests first**
   - host pause/resume;
   - interjection;
   - approval resolution;
   - shutdown/stop behavior;
   - named-pipe control transport;
   - existing Computer Use action path.

3. **Remove FastCUA-owned UI launch path**
   - detach runtime startup from overlay/web UI;
   - daemon must start and operate headlessly.

4. **Remove obsolete UI assets and UI-only config**
   - only after reference inventory is clean.

5. **Simplify daemon surface**
   - retain host-control protocol;
   - remove local HTTP/UI plumbing that has no remaining consumer.

6. **Update release packaging**
   - ship only runtime components and supported integration assets.

7. **Reclassify tests**
   - delete obsolete UI tests;
   - keep protocol and safety tests;
   - add explicit headless-start test.

8. **Synchronize docs**
   - update `TECHNICAL_PAPER.md` so it no longer presents FastCUA-owned overlay/control-center UX as a current contribution;
   - update website copy separately if it still advertises visible human controls.

## Acceptance criteria

The cleanup is complete when all of the following are true:

- FastCUA starts and performs Computer Use with no overlay, web console, or FastCUA-owned hotkey UI required;
- no runtime dependency requires `overlay.ps1`, `card.xaml`, or the old control-center page;
- release artifacts do not contain retired UI files unless a supported host explicitly consumes them;
- external hosts can still pause/resume, interject, resolve approvals, and stop/shutdown through the retained host-control contract where those capabilities are enabled;
- removing the UI does not reduce UIA/vision/ROI/grid grounding capability;
- `grid_view` / recursive refinement still work;
- arbitrary model-defined ROI still works;
- coordinate mapping and near-effect validation remain unchanged or better tested;
- tests distinguish host-control protocol from retired product UX;
- documentation consistently describes FastCUA as a headless runtime rather than a complete Human Control interface.

## Things not to do

Do not:

- delete all pause/interjection/approval code just because the old UI is removed;
- replace host-neutral APIs with DeepSeek-specific APIs;
- make Qwen/Codex/Claude-specific assumptions in the FastCUA core;
- move user-facing UX back into FastCUA for convenience;
- weaken approval policy or action validation as part of UI cleanup;
- remove agent-defined ROI while simplifying visual code;
- claim token or task-success improvements without comparative measurements.

## Design rationale

The reason for this split is compatibility.

A Windows runtime that ships its own mandatory interaction model becomes harder to embed. A headless runtime with optional control hooks can sit underneath different Harnesses without forcing them to adopt FastCUA's product UX.

The desired end state is:

```text
Qwen / Codex / Claude / DeepSeek / other Harness
                    ↓
        host-specific user experience
                    ↓
       FastCUA integration contract
                    ↓
     perception + grounding + execution
                    ↓
                  Windows
```

FastCUA should be the reusable Windows substrate, not the owner of every layer above it.
