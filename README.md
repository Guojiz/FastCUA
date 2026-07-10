# FastCUA

[自部署指南](docs/SELF_HOSTING_zh.md) | [Self-hosting guide](docs/SELF_HOSTING.md) | [逆向工程记录](re/ANALYSIS.md)
> **The fastest open-source computer-use control for AI agents on Windows.**
> [中文版 / Chinese](README_zh.md)

FastCUA gives any AI agent — Claude Desktop, Claude CLI, Cursor, or your own software — real control of a Windows desktop: click, type, scroll, drag, screenshot, and drive native apps, all through one resident helper that stays warm across every request.

---

## Why FastCUA

**Up to ~10× lower latency than per-request computer-use runners.**

Most computer-use setups spawn a fresh native helper on **every request** (or every agent process). Each cold start costs hundreds of milliseconds to several seconds (process init + accessibility/subsystem warmup). N actions = N cold starts paid in full.

FastCUA spawns the helper **once** and keeps it resident. Every subsequent action skips the spawn — per-action latency drops to just the action itself (~100–900 ms). A 30-step task goes from "30 cold starts + 30 actions" to "1 spawn + 30 actions", eliminating roughly an order of magnitude of overhead.

- **One cursor, shared state** — all clients/agent processes share one helper, so focus & state stay consistent.
- **Stop returns control to the AI instantly** — Stop button or interjection immediately rejects in-flight actions.
- **Desktop overlay** — soft pastel rainbow screen-edge glow + top-center white status card showing live actions; click-through, auto-hides when idle.
- **Web config + centralized approval** — `http://127.0.0.1:8420` live status; app approvals cached across clients; optional whitelist gate.
- **Host-agnostic** — any MCP client, or any process that speaks newline-delimited JSON over a Windows named pipe.

---

## Prerequisites

1. **Windows 11**
2. **Node.js 18+**
3. **A compatible native computer-use helper** — FastCUA auto-discovers it from common install locations. Use `cuaBinPath` in config or the `CUA_BIN` env var to point to it explicitly if needed.

## Get FastCUA

```bash
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
```

No build step. The daemon auto-discovers the helper on first use.

---

## Deploy

FastCUA is host-agnostic. Pick your AI software below. The daemon co-starts on first connect and idle-exits after 5 min.

### Option A — Claude Desktop (MCP)

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "fastcua": {
      "command": "node",
      "args": ["C:\\path\\to\\FastCUA\\server.mjs"]
    }
  }
}
```

Restart Claude Desktop — `fastcua` appears under MCP tools.

### Option B — Claude CLI (MCP)

```bash
claude mcp add fastcua -- node /absolute/path/to/FastCUA/server.mjs
```

### Option C — Other MCP clients (Cursor, Cline, etc.)

Same JSON shape as Option A under that client's MCP config. The server reports `serverInfo.name = "fastcua"`, `protocolVersion = 2024-11-05`.

### Option D — Direct named pipe (any AI software / custom agent)

Connect to `\\.\pipe\fastcua` and exchange newline-delimited JSON.

**Node:**
```js
import net from "node:net";
const s = net.connect("\\\\.\\pipe\\fastcua", () => {
  s.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
```

**Python:**
```python
import json, win32file, pywintypes
h = win32file.CreateFile(r"\\.\pipe\fastcua",
    win32file.GENERIC_READ | win32file.GENERIC_WRITE, 0, None,
    pywintypes.OPEN_EXISTING, 0, None)
win32file.WriteFile(h, (json.dumps({"id":1,"method":"list_apps","params":{}}) + "\n").encode())
```

See **Pipe protocol** below for the full spec.

---

## AI self-deploy guide

Deterministic steps — an AI agent can execute them verbatim:

1. `git clone https://github.com/Guojiz/FastCUA.git && cd FastCUA`
2. `node --version` (≥ 18). Install Node.js if missing.
3. Verify the helper binary is discoverable (auto-scan covers common install locations). If not found, set `CUA_BIN` env to its path.
4. Register with your host (Option A/B/C above) using the absolute path to `server.mjs`.
5. Smoke test:
   ```bash
   node daemon.mjs &
   curl http://127.0.0.1:8420/api/state   # expect JSON with uptime
   ```
6. Open `http://127.0.0.1:8420` — the web config page should load.
7. Invoke any `fastcua` tool (e.g. `list_apps`) from your host. The overlay should pop up showing the action.

---

## Configuration

`config.json` (also editable via the web page):

```json
{
  "costartMode": "claude",
  "idleTimeoutMin": 5,
  "approvalPolicy": "auto",
  "whitelist": ["mspaint.exe", "notepad.exe", "explorer.exe"],
  "port": 8420,
  "overlayEnabled": true,
  "overlayTitle": "FastCUA · using your computer",
  "cuaBinPath": ""
}
```

| Key | Meaning |
|---|---|
| `costartMode` | `claude` (co-start on first action) / `login` (Windows auto-start) / `manual` |
| `idleTimeoutMin` | minutes idle before daemon exits (0 = never) |
| `approvalPolicy` | `auto` (approve all) / `whitelist` (reject non-listed apps) |
| `whitelist` | app names/substrings allowed under whitelist policy |
| `port` | HTTP config API port (restart to apply) |
| `overlayEnabled` | show the desktop overlay |
| `overlayTitle` | text on the overlay card |
| `cuaBinPath` | explicit helper path; empty = auto-discover, also settable via `CUA_BIN` env |

---

## Architecture

```
AI host (Claude Desktop / CLI / Cursor / custom)
        │  MCP (stdio)         or   named pipe (newline JSON)
        ▼
server.mjs  ──(spawns if down)──►  daemon.mjs  ──(one resident subprocess)──►  helper binary
                                       │
                                       ├── HTTP config + events  (127.0.0.1:8420)
                                       └── overlay.ps1 (WPF border + card)
```

| File | Role |
|---|---|
| `daemon.mjs` | resident daemon: shared helper, named pipe, HTTP API, approval cache, interrupts, overlay lifecycle |
| `server.mjs` | MCP server (thin pipe client, spawns daemon on first use) |
| `overlay.ps1` | WPF overlay driver: rainbow edge + status card, polls daemon events, auto-hides when idle |
| `card.xaml` | overlay card UI (white Apple-style) |
| `web.html` | web config/status page |
| `config.json` | runtime config (web-editable) |

---

## Pipe protocol

For direct integrators (Option D). Newline-delimited JSON over `\\.\pipe\fastcua`.

**Request:** `{ "id": <int>, "method": <string>, "params": <object> }`
**Response:** `{ "id": <int>, "result": <object> }` or `{ "id": <int>, "error": <string> }`

| Method | Summary |
|---|---|
| `list_apps` | enumerate open apps + their targetable windows |
| `launch_app` | launch an app by id or `.exe` path |
| `get_window` | rehydrate a window by id |
| `get_window_state` | capture accessibility tree + screenshot |
| `click` / `drag` / `scroll` | pointer actions (by element index or x,y) |
| `type_text` / `press_key` | keyboard input |
| `set_value` | replace an editable element's value |
| `perform_secondary_action` | invoke a secondary a11y action |
| `activate_window` | bring a window to the foreground |
| `end_turn` | advance turn id (interrupt bookkeeping) |
| `close` | disconnect this client |

**Interrupt / Stop:** `POST /api/action {"action":"stopAll"}` immediately rejects in-flight helper actions. `POST /api/interject {"text":"..."}` queues a message injected as the next interrupt.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
