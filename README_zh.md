# FastCUA

> **Windows 上最快的开源 AI computer-use 控件。**
> [English](README.md)

FastCUA 让任意 AI agent（Claude Desktop、Claude CLI、Cursor 或你自己的程序）真正操控 Windows 桌面：点击、输入、滚动、拖拽、截图、驱动原生应用——所有动作经由**一个常驻、跨请求复用的** helper 完成。

---

## 为什么是 FastCUA

**比其他方案快约 10 倍。**

大多数 computer-use 方案在**每次请求**（或每个 agent 进程）都重新 spawn 一个原生 helper——每次冷启动要几百毫秒到几秒。N 步任务就要付 N 次冷启动成本。

FastCUA 只 spawn **一次**，helper 常驻 daemon，后续每个动作跳过 spawn 直奔热二进制——单动作延迟降到动作本身（约 100–900 ms）。30 步任务从「30 次冷启动 + 30 个动作」变成「1 次 spawn + 30 个动作」，省掉约一个数量级的开销。

- **一个光标、共享状态**——所有客户端共享一个 helper，焦点与状态一致。
- **Stop 立即交还 AI**——Stop 按钮或打断立即中断当前动作，控制权立刻交还 AI。
- **桌面浮窗**——柔和粉彩彩虹屏幕边框 + 顶部居中白色状态卡，实时显示动作；点击穿透，空闲自动隐藏。
- **Web 配置页 + 集中审批**——`http://127.0.0.1:8420` 实时状态，应用审批跨客户端缓存，可选白名单关卡。
- **不绑宿主**——任何 MCP 客户端，或任何能经 Windows 命名管道讲换行 JSON 的进程。

---

## 前置条件

1. **Windows 11**
2. **Node.js 18+**
3. **兼容的原生 computer-use helper**——FastCUA 自动从常见安装位置发现它。如需手动指定，在 config 里设 `cuaBinPath` 或用 `CUA_BIN` 环境变量。

## 获取

```bash
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
```

无需构建。首次使用时 daemon 自动发现 helper。

---

## 部署

FastCUA 不绑定宿主。以下选你的 AI 软件对应的接入方式。daemon 首次连接时自启动，空闲 5 分钟后自动退出。

### 方式 A —— Claude Desktop (MCP)

在 `claude_desktop_config.json` 中添加（Settings → Developer → Edit Config）：

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

重启 Claude Desktop —— MCP 工具中出现 `fastcua`。

### 方式 B —— Claude CLI (MCP)

```bash
claude mcp add fastcua -- node /absolute/path/to/FastCUA/server.mjs
```

### 方式 C —— 其他 MCP 客户端（Cursor、Cline 等）

使用和方式 A 相同的 JSON，填入该客户端的 MCP 配置。服务端报告 `serverInfo.name = "fastcua"`，`protocolVersion = 2024-11-05`。

### 方式 D —— 直连命名管道（任意 AI 软件 / 自定义 agent）

连接 `\\.\pipe\fastcua`，收发换行分隔的 JSON。

**Node：**
```js
import net from "node:net";
const s = net.connect("\\\\.\\pipe\\fastcua", () => {
  s.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
```

**Python：**
```python
import json, win32file, pywintypes
h = win32file.CreateFile(r"\\.\pipe\fastcua",
    win32file.GENERIC_READ | win32file.GENERIC_WRITE, 0, None,
    pywintypes.OPEN_EXISTING, 0, None)
win32file.WriteFile(h, (json.dumps({"id":1,"method":"list_apps","params":{}}) + "\n").encode())
```

完整协议见下方「管道协议」。

---

## AI 自部署指引

确定性步骤，AI agent 可照搬执行：

1. `git clone https://github.com/Guojiz/FastCUA.git && cd FastCUA`
2. `node --version`（≥ 18）。如未安装，先装 Node.js。
3. 检查 helper 二进制是否可被发现（自动扫描覆盖常见安装位置）。若发现不到，用 `CUA_BIN` 环境变量指定路径。
4. 按你的宿主注册（上面 A/B/C），使用 `server.mjs` 的绝对路径。
5. 冒烟测试：
   ```bash
   node daemon.mjs &
   curl http://127.0.0.1:8420/api/state   # 预期返回含 uptime 的 JSON
   ```
6. 打开 `http://127.0.0.1:8420` —— Web 配置页应正常加载。
7. 从宿主调用任意 `fastcua` 工具（如 `list_apps`）——浮窗应弹出并显示动作。

---

## 配置

`config.json`（也可通过 Web 配置页编辑）：

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

| 项 | 说明 |
|---|---|
| `costartMode` | `claude`（首次动作时自启）/ `login`（Windows 登录自启）/ `manual`（手动） |
| `idleTimeoutMin` | 无客户端多少分钟后自动退出（0 = 不退出） |
| `approvalPolicy` | `auto`（全部放行）/ `whitelist`（仅白名单） |
| `whitelist` | 白名单策略下允许的应用名/子串 |
| `port` | HTTP 配置 API 端口（重启生效） |
| `overlayEnabled` | 是否显示桌面浮窗 |
| `overlayTitle` | 浮窗卡片标题文字 |
| `cuaBinPath` | 显式指定 helper 路径；留空 = 自动发现，也可用 `CUA_BIN` 环境变量设置 |

---

## 架构

```
AI 宿主（Claude Desktop / CLI / Cursor / 自定义）
        │  MCP (stdio)           或   命名管道 (换行 JSON)
        ▼
server.mjs  ──(down 则拉起)──►  daemon.mjs  ──(一个常驻子进程)──►  helper 二进制
                                      │
                                      ├── HTTP 配置 + 事件  (127.0.0.1:8420)
                                      └── overlay.ps1 (WPF 边框 + 卡片)
```

| 文件 | 作用 |
|---|---|
| `daemon.mjs` | 常驻 daemon：共享 helper、命名管道、HTTP API、审批缓存、中断、浮窗生命周期 |
| `server.mjs` | MCP server（薄层管道客户端，首次使用时拉起 daemon） |
| `overlay.ps1` | WPF 浮窗驱动：彩虹边框 + 状态卡，轮询 daemon 事件，空闲自动隐藏 |
| `card.xaml` | 浮窗卡片界面（白色 Apple 风格） |
| `web.html` | Web 配置/状态页面 |
| `config.json` | 运行配置（可通过 Web 页面编辑） |

---

## 管道协议

适用于直连方式（方式 D）。经 `\\.\pipe\fastcua` 收发换行分隔 JSON。

**请求：** `{ "id": <int>, "method": <string>, "params": <object> }`
**响应：** `{ "id": <int>, "result": <object> }` 或 `{ "id": <int>, "error": <string> }`

| 方法 | 说明 |
|---|---|
| `list_apps` | 枚举已安装应用及其可定位窗口 |
| `launch_app` | 通过 id 或 `.exe` 路径启动应用 |
| `get_window` | 通过 id 重新获取窗口 |
| `get_window_state` | 捕获无障碍树 + 截图 |
| `click` / `drag` / `scroll` | 指针动作（按元素索引或 x,y 坐标） |
| `type_text` / `press_key` | 键盘输入 |
| `set_value` | 替换可编辑元素的值 |
| `perform_secondary_action` | 调用辅助无障碍动作 |
| `activate_window` | 将窗口提到前台 |
| `end_turn` | 递增客户端 turn id（中断记账用） |
| `close` | 断开本客户端 |

**中断 / 停止：** 每次请求前 daemon 检查中断文件；`POST /api/action {"action":"stopAll"}` 写入该文件并立即拒绝所有进行中的 helper 动作，AI 立刻恢复。`POST /api/interject {"text":"..."}` 将文本排入下一条中断提示。

---

## 许可证

Apache License 2.0 —— 见 [LICENSE](./LICENSE)。
