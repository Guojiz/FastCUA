# FastCUA Agent Self-Setup

A complete FastCUA installation always has **two parts in the same agent host**:

1. the full `skills/computer-use/` operating policy (the Skill);
2. the `sky-computer-use` stdio MCP server (`server.mjs`).

MCP alone is capability without the required procedure. The Skill alone has no
executor. This document and `scripts/agent-setup.ps1` automate both parts for
common agent hosts.

> [!NOTE]
> 中文版本见 [AGENT_SETUP_zh.md](AGENT_SETUP_zh.md)。

## Quick start (agent or human)

```powershell
# Show detected agents and their current FastCUA state
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action List

# Install Skill + MCP into every detected agent
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Install

# Or target one agent
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Install -Agent qoder

# Verify configuration and run a live MCP smoke test
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Verify
```

The script backs up every config file it touches (`<file>.bak.<timestamp>`)
and supports `-DryRun`.

## Supported agents

| Agent | MCP config file | Skills directory |
|---|---|---|
| Qoder | `%USERPROFILE%\.qoder\mcp.json` (`mcpServers`) | `%USERPROFILE%\.qoder\skills\computer-use` |
| Claude Code | `%USERPROFILE%\.claude.json` (`mcpServers`) | `%USERPROFILE%\.claude\skills\computer-use` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (`mcpServers`) | n/a (MCP only) |
| Codex CLI | `%USERPROFILE%\.codex\.mcp.json` (`mcpServers`) | `%USERPROFILE%\.codex\skills\computer-use` |
| VS Code (Copilot MCP) | `%APPDATA%\Code\User\mcp.json` (`servers`) | n/a (MCP only) |
| opencode | `%USERPROFILE%\.config\opencode\opencode.json` (`mcp`) | `%USERPROFILE%\.config\opencode\skills\computer-use` |
| Kimi Work | configured in-app | `%APPDATA%\kimi-desktop\daimon-share\daimon\skills\computer-use` |

The standard stdio MCP entry written by the script:

```json
{
  "sky-computer-use": {
    "command": "node",
    "args": ["%LOCALAPPDATA%\\FastCUA\\app\\server.mjs"]
  }
}
```

## Who starts what (lifecycle)

Nothing needs to be started by hand. The daemon is launched on demand by the
MCP server on the first call.

| Component | Started by | When | Manual action needed |
|---|---|---|---|
| `server.mjs` (stdio MCP) | the agent host | when the agent connects | no |
| resident daemon | `server.mjs` | first MCP call | no |
| Rust native host | daemon | first desktop request | no |
| history store | daemon | with the daemon | browse via host plugin |

Do **not** run `node daemon.mjs` manually as part of setup.

## Verification

After the agent client restarts, the agent must confirm all of:

1. `sky-computer-use` MCP tools are present (`list_apps`, `list_windows`, `js`, `close`, ...);
2. `runtime_info` reports `root = %LOCALAPPDATA%\FastCUA\app` and the installed version;
3. `list_apps` or `list_windows` returns real Windows data.

`-Action Verify` performs the same checks for humans, including a real stdio
MCP round trip against `server.mjs` (initialize → tools/call
`list_windows`) that requires a successful result from the live daemon;
tool metadata alone (tools/list) is not accepted as proof.

If `runtime_info` reports another directory or version, the agent is talking
to a stale checkout. Run:

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Doctor
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Verify
```

`-Action List` flags `MCP configured but STALE` when a host points at a
different `server.mjs` (for example a development checkout) than the installed
runtime.

## Configuration and control

FastCUA runs headless and defaults to **Full access**. All settings live in the local `config.json` (`%LOCALAPPDATA%\FastCUA\data\config.json`); edit it and restart the daemon to apply. Pause, interjection, and approval are provided by a host control plane (the DeepSeek Harness plugin) or the daemon named-pipe methods.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Agent says FastCUA is unavailable | Restart the agent client; MCP configs load at startup |
| `MCP configured but STALE` | Re-run `-Action Install -Agent <name>` |
| Smoke test fails | `install.ps1 -Action Doctor`; check `node --version` |
| Verify says desktop control is paused | Resume from the host control plane (DeepSeek Harness plugin) or restart the daemon |
| Skill not discovered | Confirm the full `computer-use` folder was copied, not a single SKILL.md |

## Security notes

- Never install a forwarding or shortened `SKILL.md`; the full operating
  policy is required.
- Do not expose the local pipe outside this computer.
- Config backups (`*.bak.*`) may contain other MCP registrations; treat them
  as local-only.
