# FastCUA

> **The fastest open-source computer-use control for AI agents on Windows.**
> **Windows 上最快的开源 AI computer-use 控件。**

FastCUA gives any AI agent — Claude Desktop, Claude CLI, Cursor, or your own — real control of a Windows desktop: click, type, scroll, drag, screenshot, and drive native apps, through one resident helper that stays warm across every request.

FastCUA 让任意 AI agent（Claude Desktop、Claude CLI、Cursor 或你自己的程序）真正操控 Windows 桌面：点击、输入、滚动、拖拽、截图、驱动原生应用——所有动作经由**一个常驻、跨请求复用**的 helper 完成。

---

## Why FastCUA / 为什么是 FastCUA

**Up to ~10× lower latency than per-request computer-use runners.**

Most computer-use setups spawn a fresh native helper binary on **every request** (or every agent process). Each cold start costs hundreds of milliseconds to several seconds (process init + accessibility/WSL/WPF subsystem warmup). For a multi-step task of N actions, that's N cold starts paid in full.

FastCUA spawns the helper **once** and keeps it resident in a daemon. Every subsequent action skips the spawn and goes straight to the warm binary — per-action latency drops to just the action itself (~100–900 ms). A 30-step task goes from "30 cold starts + 30 actions" to "1 spawn + 30 actions", eliminating roughly an order of magnitude of overhead. That's the 10×.

其它 computer-use 方案在**每次请求**（或每个 agent 进程）都重新 spawn 一个原生 helper 二进制——每次冷启动要花几百毫秒到数秒（进程初始化 + 辅助功能/WPF 子系统预热）。一个 N 步任务要付 N 次冷启动成本。FastCUA 只 spawn **一次**，helper 常驻 daemon，后续每个动作跳过 spawn 直奔热二进制——单动作延迟降到动作本身（约 100–900 ms）。30 步任务从「30 次冷启动 + 30 个动作」变成「1 次 spawn + 30 个动作」，省掉约一个数量级的开销。这就是 10×。

Other reasons / 其它优势：

- **One cursor, shared state** — all clients/agent processes share one helper, so focus/state stay consistent instead of fighting each other. / 所有客户端共享一个 helper，焦点与状态一致，不会互相打架。
- **Stop returns to the AI instantly** — Stop button or interjection immediately rejects in-flight actions and hands control back to the model. / Stop 按钮或打断立即中断当前动作，控制权立刻交还 AI。
- **Desktop overlay** — soft pastel rainbow screen-edge glow + a top-center Apple-style status card showing live actions; click-through, non-intrusive. / 柔和粉彩彩虹屏幕边框 + 顶部居中 Apple 风状态卡，实时显示动作；点击穿透、不抢内容。
- **Web config + centralized approval** — `http://127.0.0.1:8420` live status, app approvals cached across clients, optional whitelist gate. / Web 配置页实时状态，应用审批跨客户端缓存，可选白名单关卡。
- **Host-agnostic** — any MCP client or any process that can speak newline-delimited JSON over a Windows named pipe. / 不绑宿主：任何 MCP 客户端，或任何能经 Windows 命名管道讲换行 JSON 的进程。

---

## ⚠️ Important / 重要声明

- FastCUA is an **independent** project. All code here (`daemon.mjs` / `server.mjs` / `overlay.ps1` / `card.xaml` / `web.html`) is original and contains **no source or binary from OpenAI or `@oai/sky`**.
- FastCUA does **not include or redistribute** the `codex-computer-use.exe` helper or the `@oai/sky` package. That binary is a **runtime dependency provided by the user's Codex install**; you must install Codex separately to obtain it.
- FastCUA communicates with the helper over its stdio JSON protocol for **interoperability** only — this is not a derivative work.
- **"Codex" is a trademark of OpenAI.** FastCUA is unofficial, unaffiliated, and not endorsed by OpenAI. The mark is used only to describe compatibility with the helper that Codex ships (nominative fair use).

---

## Prerequisites / 前置条件

1. **Windows 11** (the WPF overlay and the helper are Windows-native).
2. **Node.js 18+** (runs `daemon.mjs` / `server.mjs`).
3. **Codex installed** — it drops the helper at `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<hash>\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe`. FastCUA does not install it for you.

## Get FastCUA / 获取

```bash
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
```

The daemon auto-discovers the helper binary on first use (see *Configuration* to override). No build step.

---

## Deploy / 部署

FastCUA is host-agnostic. Pick the integration that matches your AI software. The daemon is launched on demand the first time an MCP client (or pipe client) connects — by default it co-starts with the first action and idle-exits after 5 min.

### Option A — Claude Desktop (MCP)

Add to your `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

Restart Claude Desktop. The `fastcua` server appears under MCP tools.

### Option B — Claude CLI (MCP)

```bash
claude mcp add fastcua -- node /absolute/path/to/FastCUA/server.mjs
```

Verify: `claude mcp list` should show `fastcua`.

### Option C — Other MCP clients (Cursor, Cline, etc.)

Use the same JSON shape as Option A under that client's MCP config. The MCP server reports `serverInfo.name = "fastcua"`, `protocolVersion = 2024-11-05`.

### Option D — Direct named pipe (any AI software / custom agent)

If your AI software isn't an MCP client, speak the pipe protocol directly. Connect to `\\.\pipe\fastcua` and exchange newline-delimited JSON.

**Node example:**
```js
import net from "node:net";
const sock = net.connect("\\\\.\\pipe\\fastcua", () => {
  sock.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
sock.setEncoding("utf8");
sock.on("data", (d) => { /* parse lines as {id, result|error} */ });
```

**Python example:**
```python
import json, win32file, pywintypes
h = win32file.CreateFile(r"\\.\pipe\fastcua",
    win32file.GENERIC_READ | win32file.GENERIC_WRITE, 0, None,
    pywintypes.OPEN_EXISTING, 0, None)
win32file.WriteFile(h, (json.dumps({"id":1,"method":"list_apps","params":{}}) + "\n").encode())
# read responses line by line
```

See **Pipe protocol** below for the full request/response shape.

---

## AI self-deploy guide / AI 自部署指引

These steps are deterministic — an AI agent can execute them verbatim to deploy FastCUA for its host:

1. `git clone https://github.com/Guojiz/FastCUA.git && cd FastCUA`
2. Verify Node: `node --version` (≥ 18). If missing, install Node.js first.
3. Verify the helper can be discovered: run `node -e "import('./daemon.mjs')"` is not needed — instead, check the path exists:
   ```bash
   ls "$LOCALAPPDATA/OpenAI/Codex/runtimes/cua_node/"*/bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe
   ```
   If empty, install Codex (provides the helper). Once present, FastCUA auto-discovers it.
4. Register with your host (Option A/B/C above). Use the absolute path to `server.mjs`.
5. Smoke test: start the daemon and hit it once —
   ```bash
   node daemon.mjs &            # starts daemon + overlay
   curl http://127.0.0.1:8420/api/state   # expect JSON with uptime
   ```
6. Open `http://127.0.0.1:8420` to confirm the web config page loads and `binaryPid` becomes non-null after the first action.
7. From your host, invoke any `fastcua` tool (e.g. `list_apps`) — the overlay should light up and the card should show the action.

Reference style follows mainstream AI-agent projects (Codex, `@openai/cua`, Anthropic computer-use): clone → verify runtime deps → register MCP → smoke `list_*` → done.

---

## Configuration / 配置

`config.json` (editable via the web page at `http://127.0.0.1:8420`):

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
| `costartMode` | `claude` (co-start on first action, default) / `login` (Windows login auto-start via HKCU Run key `FastCUA`) / `manual` |
| `idleTimeoutMin` | minutes with no clients before the daemon auto-exits (0 = never) |
| `approvalPolicy` | `auto` (approve all apps) / `whitelist` (reject non-listed apps — real human gate) |
| `whitelist` | app names/substrings allowed under `whitelist` policy |
| `port` | HTTP config API port (restart to take effect) |
| `overlayEnabled` | show the desktop overlay |
| `overlayTitle` | text shown on the overlay card |
| `cuaBinPath` | explicit helper binary path; empty = auto-discover under the Codex install, or set env `SKY_CUA_BIN` |

Helper path resolution order: `cuaBinPath` → `SKY_CUA_BIN` env → auto-scan `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*`.

---

## Architecture / 架构

```
AI host (Claude Desktop / CLI / Cursor / custom)
        │  MCP (stdio)            or   named pipe (newline JSON)
        ▼
server.mjs  ──(spawns if down)──►  daemon.mjs  ──(one resident subprocess)──►  codex-computer-use.exe
                                       │
                                       ├── HTTP config + events  (127.0.0.1:8420)
                                       └── spawns overlay.ps1 (WPF border + card)
```

- `daemon.mjs` — resident service: owns ONE helper subprocess (one cursor, shared across all clients), the named pipe `\\.\pipe\fastcua`, HTTP config/events API, centralized app-approval cache, per-client Esc-interrupt + interjection, overlay lifecycle.
- `server.mjs` — thin MCP server: connects to the pipe, spawns the daemon detached on first use (so it co-starts with the host), exposes the window2 API + a persistent `js` REPL as MCP tools.
- `overlay.ps1` + `card.xaml` — WPF desktop overlay: full-screen click-through rainbow edge glow + top-center white status card, polling the daemon's events API.
- `web.html` — web config/status page.

---

## Pipe protocol / 管道协议

For direct integrators (Option D). Newline-delimited JSON over `\\.\pipe\fastcua`.

**Request:** `{ "id": <int>, "method": <string>, "params": <object> }`
**Response:** `{ "id": <int>, "result": <object> }` or `{ "id": <int>, "error": <string> }`

Methods (params match the `@oai/sky` window2 API):

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
| `end_turn` | advance the client's turn id (used by interrupt bookkeeping) |
| `close` | disconnect this client |

**Interrupt / Stop:** the daemon checks an Esc-interrupt file per `(session_id, turn_id)` on each request; `POST /api/action {"action":"stopAll"}` writes that file and immediately rejects any in-flight helper action, so the AI resumes right away. `POST /api/interject {"text":"..."}` queues a message injected as the next interrupt error.

**HTTP endpoints** (on `config.port`, default 8420):
- `GET /api/state` — live status (clients, helper pid, approved apps, uptime, recent logs)
- `GET/POST /api/config` — read/update config
- `GET /api/events?since=<id>` — structured events `{events, inflight}`
- `POST /api/action` — `restart` / `killBinary` / `clearApprovals` / `stopAll`
- `POST /api/interject` — queue an interjection

---

## File structure / 文件结构

| File | Role |
|---|---|
| `daemon.mjs` | resident daemon: shared helper, named pipe, HTTP API, approval cache, interrupts, overlay lifecycle |
| `server.mjs` | MCP server (thin pipe client, spawns daemon on first use) |
| `overlay.ps1` | WPF overlay driver: rainbow edge + status card, polls daemon events |
| `card.xaml` | overlay card XAML (white Apple-style) |
| `web.html` | web config/status page |
| `config.json` | runtime config (web-editable) |
| `LICENSE` | Apache-2.0 |

---

## License / 许可证

Code in this repository is licensed under **Apache License 2.0** — see [LICENSE](./LICENSE).

**Not covered by this license:** `codex-computer-use.exe` and the `@oai/sky` package — they are OpenAI's proprietary assets (`@oai/sky` declares no open-source license in its `package.json`), provided by the user's Codex install. This project holds, distributes, and claims no rights to them.
