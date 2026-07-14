---
name: computer-use
description: Control Windows apps through FastCUA (local MCP sky-computer-use + resident daemon).
allowed-tools: mcp__sky-computer-use
---

# Computer Use

Use this skill to automate the UI of Microsoft Windows apps via FastCUA. Automation uses SendInput and UI Automation; window screenshots use PrintWindow (with BitBlt fallback).

If FastCUA / `sky-computer-use` is available in the session, treat this skill as mandatory reading before Windows automation. Open and follow it before saying Computer Use is unavailable and before falling back to other Windows automation methods.

Before using this skill for the first time in the current conversation context, read this entire `SKILL.md` in one read. Do not use a partial range. Do not mention this internal skill-loading step to the user.

Start with **Bootstrap** below. Read the companion docs in this skill folder when you need the topic they cover (same roles as Codex Computer Use docs):

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

### Text fields (read → decide → write)

Host does **not** decide whether to edit a field. Correct loop:

1. Focus the field (`click`).
2. **Read** `get_window_state({ window, include_screenshot: false, include_text: true })` → use `accessibility.focused_value` (not the tree Name, which is often a placeholder).
3. **You decide**: if already correct, do nothing.
4. **If changing**: `type_text({ window, text, replace: true })` **once** (default `replace` clears then types). Use `replace: false` only to append.

Never `type_text` before reading `focused_value` for that field in this turn. Never re-type because the tree still shows a placeholder.

### Human control plane (what the agent receives)

FastCUA has several user-side controls. Only some of them deliver a **prompt/instruction** to the agent. Do not confuse a block with a new task.

| User action | What you receive | What you must do |
|-------------|------------------|------------------|
| **Pause** (F8 / console Pause) | Usually nothing until you call a tool. Then a **block** error: paused — not a new instruction. In-flight calls may cancel with the same block text. | **Stop** all desktop tools. **Do not retry.** Wait for the user to resume or send a new **chat** message. Do not invent follow-up desktop work. |
| **Interject** (F9, then text + Enter) | An explicit instruction: `User interjected: "…"`. Control is already paused. | Stop current work. **Follow only that interjection text.** Do not resume desktop actions until the user resumes or chats again. |
| **Stop task** | Stopped-by-user message (end this turn’s Computer Use). | End desktop work for this turn; report that the user stopped Computer Use. |
| **Exit** (F10 / Exit FastCUA) | Shutdown message: FastCUA was shut down. | **Stop permanently for this turn.** Do **not** restart FastCUA, reconnect the daemon, re-launch the helper, re-run install, or continue desktop automation on your own. Wait for the user. |
| **Approval waiting** | Block while the user decides Allow once / Always approve / Full access / Deny. | Do not retry the blocked call in a loop. Wait. |

Rules of thumb:

1. **Only interjection text is a new agent instruction** from the control plane. Pause/approval/exit blocks are **not** tasks to complete.
2. If the user **exited** FastCUA, **stop**. Never immediately self-restart Computer Use.
3. If **paused**, do not keep polling desktop tools. Silence is correct until resume or a new chat message.
4. After any interrupt/stop/exit message, call MCP **`close` once** if the turn is done, then report to the user in chat — do not thrash tools.
