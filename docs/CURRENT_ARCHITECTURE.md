# FastCUA Current Architecture

**Status:** Authoritative product-boundary document for the current FastCUA direction.

FastCUA is a **headless, host-neutral Windows Computer Use runtime**. It should provide observation, grounding, coordinate translation, native execution, runtime state, and optional host-control hooks without prescribing how a human interacts with the agent.

This document supersedes older documentation that described FastCUA's own floating overlay, web control center, or fixed hotkey UX as part of the product architecture.

## 1. Core product boundary

The intended stack is:

```text
Agent / Harness / Host
  ├─ task planning
  ├─ user interaction
  ├─ optional pause / interjection / approval UX
  └─ FastCUA integration
          ↓
      FastCUA
      ├─ UIA / HWND observation
      ├─ visual capture
      ├─ agent-defined ROI
      ├─ numbered recursive refinement
      ├─ coordinate mapping
      ├─ native Windows input
      └─ optional host-control protocol
          ↓
        Windows
```

The important separation is:

> **FastCUA defines the Windows runtime contract. The host defines the human experience.**

FastCUA should not require a particular floating window, control center, shortcut layout, agent shell, or conversation product.

## 2. What FastCUA owns

FastCUA owns the parts that are specific to reliable Windows Computer Use:

- UI Automation / HWND observation;
- semantic-quality routing (`good`, `weak`, `broken`, `prefer_vision`);
- screenshot capture only when vision is useful;
- numbered square-grid grounding;
- recursive local refinement;
- agent-defined rectangular ROI through window-relative bounds;
- deterministic conversion from crop/image coordinates back to window and physical-screen coordinates;
- DPI-aware geometry;
- window identity, foreground, cursor, bounds, timeout, and near-effect validation;
- one resident runtime shared by compatible agent clients;
- runtime policy and host-facing control primitives when enabled.

The main perception principle remains:

> **Text first. Vision on demand. Refine until precise.**

## 3. What the host or Harness owns

A host integration decides how users interact with those capabilities. This includes:

- whether a pause button exists;
- whether interjection exists and how it is entered;
- whether approval is shown as a modal, panel, chat prompt, or not exposed at all;
- keyboard shortcuts;
- banners, overlays, floating islands, tray icons, web consoles, and settings screens;
- how control state is displayed;
- how FastCUA is embedded into a larger agent workflow.

A DeepSeek, Qwen, Codex, Claude, opencode, or other host should be free to adopt FastCUA without inheriting FastCUA-specific UX.

## 4. Host-control hooks are not the old Human Control UI

FastCUA may expose low-level host-control operations such as:

```text
pause
resume
interject
resolve_approval
shutdown
```

These operations are **integration primitives**, not a requirement that FastCUA ship its own user interface.

The correct relationship is:

```text
host UI / host policy
        ↓
optional FastCUA control hooks
        ↓
FastCUA runtime
```

A host may use all of them, some of them, or none of them.

Therefore, removing FastCUA's own overlay or control center must **not** accidentally remove the underlying protocol semantics that external Harnesses may rely on.

## 5. Headless by design

The target runtime should not depend on FastCUA-owned UI components.

Legacy components that belong to the old product layer include, where still present in the current branch:

- `overlay.ps1`;
- `card.xaml`;
- `web.html` when used as FastCUA's own control center;
- fixed F7/F8/F9/F10 UX;
- overlay-specific configuration fields;
- daemon HTTP endpoints that exist only to drive the old local UI;
- release packaging and tests that exist only for those UI surfaces.

These are cleanup targets, not architectural requirements.

By contrast, the following are **not** automatically legacy:

- runtime approval policy;
- whitelist / application identity logic;
- pause/resume/interjection semantics exposed to hosts;
- named-pipe control methods;
- agent-visible control-state tags when a host uses those primitives;
- tests that validate the underlying protocol rather than the retired UI.

## 6. Observation and grounding model

FastCUA should minimize the observation presented to the model.

### Semantic path

```text
Windows UI
   ↓
UIA / HWND
   ↓
structured text
   ↓
agent chooses current element
   ↓
validated input
```

When semantics are sufficient, no screenshot is required.

### Visual path

```text
window image
   ↓
numbered region OR agent-defined ROI
   ↓
selected local crop
   ↓
recursive refinement if needed
   ↓
local target
   ↓
deterministic coordinate mapping
   ↓
validated input
```

The numbered-grid path is a **single-image, coarse-to-fine loop**. It does not fan out the screen into many tiles and send all tiles to the model at once.

The ROI path lets the agent choose arbitrary `left / top / right / bottom` bounds and therefore control where the next observation comes from.

## 7. Compatibility goal

FastCUA should be easy to embed beneath different agent stacks.

A compatible host should not have to reproduce FastCUA's old UX assumptions. The smallest useful integration is:

```text
Agent
  ↓
Skill / operating policy
  ↓
FastCUA MCP or compatible runtime interface
  ↓
Windows
```

Optional host-control hooks can be added independently.

This separation is important for broad adoption: FastCUA can evolve as a Windows environment/runtime layer while each Harness keeps its own interaction model and product identity.

## 8. Documentation authority

Until the implementation cleanup is complete, use this order when documents disagree:

1. `docs/CURRENT_ARCHITECTURE.md` — current product boundary and design intent;
2. `docs/NEXT_DESIGN.md` — migration and implementation obligations;
3. `README.md` / `README_zh.md` — supported user-facing explanation;
4. `docs/TECHNICAL_PAPER.md` — implementation-backed report that may still describe legacy UI-era mechanisms and must be synchronized after the cleanup.

The code cleanup handoff is documented in `docs/HANDOFF_HEADLESS_RUNTIME.md`.
