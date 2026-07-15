# Self-host FastCUA

For **people** who clone, build, or wire FastCUA. Not an agent runbook — agents load `skills/computer-use/` after install.

This guide deploys the local stack: native host, daemon, island, control center, then **Skill + MCP into the same agent**.

> **Complete install = Skill and MCP together.** Starting the daemon, only reading `SKILL.md`, only MCP, or only the Skill is incomplete.

Default target: **the agent currently executing the setup instructions**. Do not configure another AI client unless the user names it.

## 1. Prerequisites

- Windows 11 x64
- Node.js 18 or newer
- Rust stable with the MSVC toolchain
- Visual Studio Build Tools with **Desktop development with C++** when required by Rust
- An agent that supports both local Skills and stdio MCP

Confirm the tools:

```powershell
node --version
rustc --version
cargo --version
```

## 2. Clone and build the runtime

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
.\native-host\build.ps1
```

The release binary is created at:

```text
native-host\target\release\cua-native-host.exe
```

The daemon discovers it automatically. To use another compatible host, set `CUA_BIN` for the current process or set `cuaBinPath` in the local control center:

```powershell
$env:CUA_BIN = 'C:\tools\cua-native-host.exe'
```

Never commit a machine-specific binary path or helper executable.

## 3. Install into the current agent, required

Deployment has two mandatory parts:

1. Install the complete `computer-use` Skill into the current agent.
2. Install the `sky-computer-use` MCP server into the same agent.

### 3.1 Install the complete Skill

The Skill source directory is:

```text
<absolute FastCUA repository path>\skills\computer-use
```

The current agent must:

1. Locate its own active Skill directory or Skill registry.
2. Copy, link, or register the entire `computer-use` folder there without rewriting its contents.
3. Preserve `SKILL.md` and every neighboring resource. Do not merely read the source file, and do not create a forwarding, wrapper, summary, or shortened `SKILL.md`.
4. Reload or reindex Skills.
5. Verify that this agent can discover and activate the `computer-use` Skill.

Merely reading `SKILL.md` from the repository or creating a stub that points back to it is not installation. For filesystem-based Skill directories, compare the installed relative file list and SHA-256 hashes with the source. For a native Skill registry, verify that the active registration resolves to the complete folder.

### 3.2 Install the MCP server

Resolve absolute paths first:

```powershell
$node = (Get-Command node).Source
$root = (Resolve-Path .).Path
$node
$root
```

Then add this entry to **the current agent's own MCP configuration**:

```json
{
  "mcpServers": {
    "sky-computer-use": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\absolute\\path\\to\\FastCUA\\server.mjs"]
    }
  }
}
```

Replace the example values with the real `$node` path and `$root\server.mjs` path.

Do not write into another AI client's configuration by default. The agent receiving the setup instructions should first configure itself.

## 4. Reload and complete both verification checks

Reload Skills and reconnect MCP as required by the client. Restart the agent when necessary.

Both checks must pass:

1. **Skill verification:** the current agent can discover or invoke `computer-use`.
2. **MCP verification:** `list_windows` called through `sky-computer-use` returns actual Windows window data.

The installing agent must report:

- the Skill destination or registration it changed;
- the MCP configuration file it changed;
- whether the `computer-use` Skill loaded successfully;
- whether `list_windows` returned successfully.

If either part fails, report **installation failure or client incompatibility**. Do not fall back to PowerShell UI Automation, SendKeys, pyautogui, browser automation, or another desktop-control mechanism and claim success.

## 5. Default daemon startup

Normal use does not require manually starting the daemon. `server.mjs` starts the local daemon on the first MCP connection.

Start it manually only for debugging:

```powershell
node daemon.mjs
Invoke-RestMethod http://127.0.0.1:8420/api/state
```

Expected fields include `controlState`, `pendingApprovals`, `clients`, and `uptime`. Open `http://127.0.0.1:8420` for the bilingual control center.

Verify the controls:

1. The normal island is compact and translucent.
2. A click-through colored border surrounds the screen.
3. `F7` or a click on the compact island pauses control and opens the local control center.
4. `F9` expands and focuses the interjection field.
5. `F8` switches between paused and running.
6. `F10` releases the helper, overlay, named pipe, and HTTP server.

## 6. Choose a safety policy

`safe` is the default and recommended mode. Each trusted entry is either an exact executable basename such as `notepad.exe` or an exact absolute path. An unknown application moves the control plane to `awaiting_approval`. The user can allow once, add it to trusted apps, or deny. Requests expire after 60 seconds.

`full` is a separate, explicit mode that does not ask for app approval and remains visibly purple or pink while active.

There is no unrestricted approval option in the public console.

### Product defaults (config / runtime — not agent prose)

| Setting | Default | Notes |
|---------|---------|--------|
| Software action budget | **30s** per helper / MCP / JS cell | Runtime timeout. Not human approval wait. |
| `approvalPolicy` | `safe` | Unknown apps need human approval. |
| `whitelist` | Exact basenames / AUMIDs for common local tools | Skips approval only; does not lift Skill safety bans. |
| Existing `config.json` | Preserved on reinstall | Not auto-merged when code defaults grow. |

`state.uia.prefer_vision` is a runtime signal. **What the agent does next is only in the Skill**, not by reconfiguring the daemon.

## 7. Direct named-pipe integration

Only advanced clients that intentionally do not use MCP need direct access to `\\.\pipe\fastcua`. A normal agent should install both the Skill and MCP instead of treating the pipe as the default installation path.

```js
import net from "node:net";

const socket = net.connect("\\\\.\\pipe\\fastcua", () => {
  socket.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
socket.on("data", data => process.stdout.write(data));
```

## 8. Pre-release checks

```powershell
node --check daemon.mjs
node --check server.mjs
$null = [xml](Get-Content -Raw card.xaml)
$null = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path overlay.ps1), [ref]$null, [ref]$null)
cargo test --manifest-path native-host/Cargo.toml
node tests/installer-contract.mjs
```

After building the native host, run the protocol, fallback-index, and control-plane regression scripts under `tests/`.

## Troubleshooting

- **The agent only read the Skill:** require it to copy, link, or register the whole `skills\computer-use` directory into its own active Skill system, then reindex.
- **MCP tools are missing:** confirm that `sky-computer-use` was added to the current agent's own MCP configuration and reconnect it.
- **Only one part was installed:** treat the deployment as failed and do not start a desktop task.
- **Helper not found:** build the release host or set `CUA_BIN` to an existing `.exe`.
- **Island not visible:** confirm `overlayEnabled` is true and inspect `overlay.log`.
- **Shortcut does nothing:** another application may own the same global shortcut. Close it and restart FastCUA.
- **Unknown app is waiting:** choose Allow once, Add to trusted apps, or Deny in the expanded island.
- **Port already in use:** choose a port from 1024 through 65535 in `config.json`, then restart the daemon.

Keep the HTTP server on `127.0.0.1`. Do not expose it through a proxy or public interface.

Chinese version: [SELF_HOSTING_zh.md](SELF_HOSTING_zh.md).
