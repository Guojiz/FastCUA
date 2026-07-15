# Optional: OpenCode as a FastCUA client

FastCUA is **agent-neutral**. This page is only for people who use [OpenCode](https://opencode.ai) (or similar headless MCP hosts) as the client. Product install, hang policy, and agent procedure live elsewhere — do not treat this as the main docs.

| Need | Doc |
|------|-----|
| Product + one-line install | [README](../README.md) |
| Skill + MCP self-host | [SELF_HOSTING.md](SELF_HOSTING.md) |
| Timeouts, bad UIA, hangs | [STUCK.md](STUCK.md) |
| Agent runtime rules | `skills/computer-use/` |

## Wire MCP

Point OpenCode’s MCP config at the installed or repo `server.mjs` (stdio). Also install the full `computer-use` Skill into the **same** client. Skill alone or MCP alone is incomplete.

```text
# Example idea only — use absolute paths on your machine
mcp sky-computer-use → node …/server.mjs
```

Verify with `opencode mcp list` (or your client’s equivalent) and a successful `list_windows`.

## Avoid false “PASS” and hangs

Same rules as [STUCK.md](STUCK.md):

- Software budget **30s** per action / JS cell — not multi-minute waits.
- Do not use “open this prompt file” as the task text — the model may open Notepad via Computer Use.
- Inline steps in the chat; treat `PASS` as valid only if an **external artifact** exists (file on disk, visible UI).
- Broken UIA → `state.uia.prefer_vision` → `grid_view` immediately.

Sample multi-app task text used in development lives under `tests/opencode-complex-task.md` (fixture, not product surface).
