# Self-host FastCUA

FastCUA is a local control plane for Windows computer-use clients. It keeps one native helper warm, exposes a local HTTP control center, and accepts MCP or named-pipe requests.

## 1. Prerequisites

- Windows 11
- Node.js 18 or newer
- A compatible Windows computer-use helper that you are permitted to use locally

The project intentionally does not redistribute third-party helper binaries. Keep any helper binary on the machine that will run desktop automation.

## 2. Install

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
```

Set `cuaBinPath` in `config.json`, or use `CUA_BIN` for a process-local override:

```powershell
$env:CUA_BIN = 'C:\\tools\\codex-computer-use.exe'
node daemon.mjs
```

For a native helper patched to suppress its Display Overlay, set `overlayEnabled` to `false` as well. This prevents FastCUA's optional WPF status overlay from adding a second display layer.

## 3. Verify locally

```powershell
Invoke-RestMethod http://127.0.0.1:8420/api/state
```

The response should include `uptime`. Then open `http://127.0.0.1:8420` to inspect the control center and confirm the configured helper path.

## 4. Connect an MCP client

```json
{
  "mcpServers": {
    "fastcua": {
      "command": "node",
      "args": ["C:\\absolute\\path\\to\\FastCUA\\server.mjs"]
    }
  }
}
```

`server.mjs` is a thin stdio bridge. It reuses the one resident daemon and therefore one shared helper/cursor state.

## 5. Safety defaults

- Keep the HTTP control center bound to `127.0.0.1`.
- Prefer `whitelist` approval mode on shared machines.
- Use `POST /api/action {"action":"stopAll"}` to interrupt current work.
- Do not commit helper paths, API keys, or helper binaries to a public repository.

For the Chinese guide, see [SELF_HOSTING_zh.md](SELF_HOSTING_zh.md).
