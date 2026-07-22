---
name: computer-use
description: Control Windows desktop apps via FastCUA (MCP sky-computer-use). Use for GUI automation, dialogs, cross-app flows — not for pure file edits or shell-only work.
allowed-tools: mcp__sky-computer-use mcp__sky-computer-use__*
---

# Computer Use

Use this skill to automate the UI of Microsoft Windows apps via FastCUA. Automation uses SendInput and UI Automation; window screenshots use PrintWindow (with BitBlt fallback).

**This folder is the only agent procedure.** Do not open the FastCUA README, self-hosting guide, or other repo docs as a substitute runbook. Those are for humans (install / product). Your job is Skill + MCP tools.

If FastCUA / `sky-computer-use` is available in the session, treat this skill as mandatory reading before Windows automation. Open and follow it before saying Computer Use is unavailable and before falling back to other Windows automation methods.

Before using this skill for the first time in the current conversation context, read this entire `SKILL.md` in one read. Do not use a partial range. Do not mention this internal skill-loading step to the user.

Start with **Bootstrap** below. Read the companion docs in this skill folder when you need the topic they cover:

| Doc | Path (relative to this skill) | When |
|-----|-------------------------------|------|
| guidance | `docs/guidance.md` | Core runtime behavior, troubleshooting, API-use behavior, safety. **MUST read before controlling Windows apps.** |
| api | `docs/api.md` | Full `sky` / MCP API shapes. Read when you need signatures. |
| confirmations | `docs/confirmations.md` | **MUST read before deciding whether a Windows UI action needs confirmation.** |

## Bootstrap

These setup details are internal. User-facing progress updates should be less technical. Never mention MCP pipe paths, daemon PIDs, or Node module exports unless the user asks for that information. If setup or recovery is needed, describe it as connecting to Windows or retrying the Windows connection.

FastCUA exposes the window2 API through the **`sky-computer-use` MCP server** (stdio → local daemon → native host). Do **not** spawn `cua-native-host.exe`, search for the helper, or build a custom protocol client. Approvals, pause, and interjection only work through FastCUA MCP tools.

### Connection check (required)

Reading this skill does **not** mean FastCUA is connected.

1. Confirm MCP tools for `sky-computer-use` are present (`list_apps`, `list_windows`, `js`, `close`, …).
2. Call `list_apps` or `list_windows` once.
3. Continue only after a non-error response with real Windows data.

If tools are missing, disconnected, or the lightweight call fails after one retry: **stop**, report FastCUA is unavailable, and do **not** fall back to PowerShell UI Automation, SendKeys, pyautogui, shell scripts, or browser automation as a substitute.

### First Computer Use cell

Prefer the MCP **`js`** tool with the persistent `sky` object (already provided by FastCUA — no import bootstrap). On a fresh session:

```js
globalThis.apps = await sky.list_apps();
nodeRepl.write(JSON.stringify(apps, null, 2));
```

Any non-error response means the Windows helper is reachable. If `list_apps` / `list_windows` times out, wait 2 seconds and retry the same call once. If the retry fails, stop and report helper failure.

### Ending a turn

When desktop work for this turn is done, call MCP **`close` once**. That ends the turn and closes this MCP client connection. The shared FastCUA daemon/helper stay resident for other clients. Do not call `close` between every action.

### Coordinate targeting + broken UIA → vision immediately

`click` / `drag` / `scroll` **x,y are in window screenshot pixels**, origin **top-left** of the target window — same as `get_window_state().viewport` and `screenshots[0].width/height`. Do **not** invent desktop-absolute pixels.

**Software action budget: 30 seconds** per desktop request / JS cell (default). On timeout: retry **once** max, then change strategy or report. Do not spin.

After every `get_window_state({ include_text: true })`, read **`state.uia`**:

| `uia.quality` / flag | Required agent behavior |
|----------------------|-------------------------|
| `prefer_vision: true` or `quality` is `broken` / `weak` | **Immediately** `sky.grid_view` — **do not** click `element_index` |
| `quality: "good"` | Prefer `element_index` when labels exist |
| `element_index` returns stale / `[no-hit]` once | **Stop UIA clicks** for that target; switch to `grid_view` now |

Why trees go bad (do not debug host source mid-task):

- App has poor Accessibility (Electron, canvas, custom paint)
- Nodes listed but no hit bounds (`[no-hit]`)
- Provider timeout / tree only shell panes
- Stale snapshot after dialog open / list refresh

```js
const state = await sky.get_window_state({ window, include_text: true, include_screenshot: false });
if (state.uia?.prefer_vision) {
  // Broken/weak tree — vision path only
  let gv = await sky.grid_view({ window });
  gv = await sky.grid_refine({ window, grid: gv.grid, cell: "4" });
  await sky.click_cell({ window, grid: gv.grid, cell: "5" });
} else {
  // Good UIA — element_index OK
  // ...
}
```

Visual square grid (one annotated image — save tokens):

```js
let gv = await sky.grid_view({ window: targetWindow });
gv = await sky.grid_refine({ window: targetWindow, grid: gv.grid, cell: "4" });
await sky.click_cell({ window: targetWindow, grid: gv.grid, cell: "5" });
```

Rules:
- Overlay: semi-transparent **square** borders + small outlined digits.
- Refine crops to the selected cell only.
- **Select ≠ click.**
- Prefer `grid_view` over raw full screenshots for targeting.

### Text fields (read → decide → write)

Host does **not** decide whether to edit a field. Correct loop:

1. Focus the field (`click`).
2. **Read** `get_window_state({ window, include_screenshot: false, include_text: true })` → use `accessibility.focused_value` (not the tree Name, which is often a placeholder).
3. **You decide**: if already correct, do nothing.
4. **If replacing that focused value**: call `type_text({ window, text, replace: true })` **once**. Replacement is scoped to a writable UIA value and fails safely when focus is a broader document/grid.
5. **If typing at the caret**: use `type_text({ window, text })` (`replace: false` is the safe default).

Never `type_text` before reading `focused_value` for that field in this turn. If it is unavailable/null, do not assume the field is empty. Never re-type because the tree still shows a placeholder.
`replace: true` sets the value but does not promise a caret position. Refocus or move the caret explicitly before a later caret-relative edit.

### Human control plane (what the agent receives)

User-side controls return tool errors with a stable prefix. Branch on the tag first; do **not** fuzzy-match prose.

| Tag | Meaning | Agent behavior |
|-----|---------|----------------|
| `[control_plane:paused]` | **BLOCK** only (F8 / Pause). Not a task. | Stop desktop tools. No retry, no poll, no invented recovery. Wait for resume or a new **chat** message. |
| `[control_plane:interjection]` | **INSTRUCTION** (F9 text, one-shot). Control plane auto-resumes. | Abort previous plan. Follow **only** this instruction. You **may** call Computer Use tools again immediately. |
| `[control_plane:stopped]` | Turn stop (Stop task). Not a new task. | End Computer Use for this turn. No further tools. Brief note that the user stopped. |
| `[control_plane:shutdown]` | FastCUA exited (F10). Final for this turn. | Stop permanently. Do **not** restart FastCUA, reconnect, reinstall, or continue desktop automation. |
| `[control_plane:awaiting_approval]` | Human approval pending. **BLOCK**. | Do not retry in a loop. Wait. |

Rules of thumb:

1. **Only** `[control_plane:interjection]` is an instruction. Every other tag is a block or stop — not something to “fix” by acting on the desktop.
2. On **shutdown**, never self-restart Computer Use.
3. On **paused**, silence is correct; do not thrash tools.
4. When the turn is done after stop/shutdown, call MCP **`close` once**, then report in chat.
