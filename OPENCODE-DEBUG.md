# OpenCode + FastCUA

OpenCode **runs** FastCUA (MCP `sky-computer-use`). Code changes live in this repo.

## Setup

```powershell
# ~/.config/opencode/opencode.jsonc — model xai/grok-4.3, mcp sky-computer-use → server.mjs
opencode mcp list
```

## Avoid hangs

See **[docs/STUCK_zh.md](docs/STUCK_zh.md)** / [docs/STUCK.md](docs/STUCK.md).

- Software budget **30s** per action/JS cell — not multi-minute waits.
- Do not say “open the prompt file” as the task (model will open Notepad via CUA).
- Inline steps; `PASS` only if artifacts exist.
- Broken UIA → `state.uia.prefer_vision` → `grid_view` immediately.

## Sample complex task

See `opencode-complex-task.md`.
