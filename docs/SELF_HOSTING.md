# Self-host FastCUA

This guide installs the complete local stack: the native Windows host, resident daemon, Dynamic Island, control center, and MCP bridge.

## 1. Prerequisites

- Windows 11 x64
- Node.js 18 or newer
- Rust stable with the MSVC toolchain
- Visual Studio Build Tools with **Desktop development with C++** when required by Rust

Confirm the tools:

```powershell
node --version
rustc --version
cargo --version
```

## 2. Clone and build

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
./native-host/build.ps1
```

The release binary is created at `native-host/target/release/cua-native-host.exe`. The daemon discovers this path automatically. To use another compatible host, set `CUA_BIN` for the current process or `cuaBinPath` in the local control center.

```powershell
$env:CUA_BIN = 'C:\tools\cua-native-host.exe'
```

Never commit a machine-specific binary path or helper executable.

## 3. Start and verify

```powershell
node daemon.mjs
Invoke-RestMethod http://127.0.0.1:8420/api/state
```

Expected fields include `controlState`, `pendingApprovals`, `clients`, and `uptime`. Open `http://127.0.0.1:8420` for the bilingual control center.

Verify the controls:

1. The normal island is compact and translucent.
2. A click-through rainbow border surrounds the screen.
3. `F7` or a click on the compact island pauses control and opens the local settings console.
4. `F9` expands and focuses the larger interjection field.
5. `F8` changes the state to `paused_by_user`; pressing it again returns to `running`.
6. `F10` releases the helper, overlay, named pipe, and HTTP server.

## 4. Choose a safety policy

`safe` is the default and recommended mode. Each trusted entry is either an exact executable basename such as `notepad.exe` or an exact absolute path. An unknown application moves the control plane to `awaiting_approval` and expands the island. The user can allow once, add the executable name to trusted apps, or deny. Requests expire after 60 seconds.

`full` is a separate, explicit mode that does not ask for app approval and remains visibly purple/pink while active.

There is no unrestricted approval option in the public console.

## 5. Connect an MCP client

Use an absolute path in your client's MCP configuration:

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

The same shape works in MCP-compatible desktop clients, editors, and agent runtimes. `server.mjs` is a thin stdio bridge; all clients reuse the daemon and one native cursor state.

## 6. Direct pipe integration

Advanced clients can exchange newline-delimited JSON over `\\.\pipe\fastcua`:

```js
import net from "node:net";

const socket = net.connect("\\\\.\\pipe\\fastcua", () => {
  socket.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
socket.on("data", data => process.stdout.write(data));
```

## 7. Operational checks

```powershell
node --check daemon.mjs
node --check server.mjs
$null = [xml](Get-Content -Raw card.xaml)
$null = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path overlay.ps1), [ref]$null, [ref]$null)
cargo test --manifest-path native-host/Cargo.toml
```

Run the protocol regression scripts from `tests/` after building the native host.

## Troubleshooting

- **Helper not found:** build the release host, or set `CUA_BIN` to an existing `.exe`.
- **Island not visible:** confirm `overlayEnabled` is true and inspect `overlay.log`.
- **Shortcut does nothing:** another application may own the same global shortcut; close it and restart FastCUA.
- **Unknown app is waiting:** choose Allow once, Add to trusted apps, or Deny in the expanded island.
- **Port already in use:** choose a port from 1024–65535 in `config.json`, then restart the daemon.

Keep the HTTP server on `127.0.0.1`. Do not expose it through a proxy or public interface.

Chinese version: [SELF_HOSTING_zh.md](SELF_HOSTING_zh.md).
