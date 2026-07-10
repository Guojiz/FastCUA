# FastCUA 本地自部署指南

FastCUA 是 Windows computer-use 客户端的本地控制平面：它复用一个常驻 native helper，提供本地控制台，并支持 MCP 与命名管道接入。

## 1. 前置条件

- Windows 11
- Node.js 18 或更高版本
- 你有权在本机使用的兼容 Windows computer-use helper

项目不会重新分发第三方 helper 二进制。请把 helper 仅保留在实际执行桌面自动化的机器上。

## 2. 安装与配置

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
```

在 `config.json` 中填写 `cuaBinPath`，或用仅对当前进程生效的 `CUA_BIN`：

```powershell
$env:CUA_BIN = 'C:\\tools\\codex-computer-use.exe'
node daemon.mjs
```

若使用已去除 Display Overlay 的 native helper，同时将 `overlayEnabled` 设置为 `false`，避免 FastCUA 的可选 WPF 状态浮窗形成第二层显示覆盖。

## 3. 本机验证

```powershell
Invoke-RestMethod http://127.0.0.1:8420/api/state
```

响应中应有 `uptime`。随后打开 `http://127.0.0.1:8420`，在控制中心确认 helper 路径与运行状态。

## 4. 连接 MCP 客户端

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

`server.mjs` 是 stdio 薄层，所有客户端复用同一个 daemon，也就复用同一个 helper/光标状态。

## 5. 安全建议

- 保持 HTTP 控制中心绑定在 `127.0.0.1`。
- 在共享机器上优先使用 `whitelist` 审批模式。
- 通过 `POST /api/action {"action":"stopAll"}` 中断当前操作。
- 不要把 helper 路径、密钥或 helper 二进制提交到公开仓库。

English version: [SELF_HOSTING.md](SELF_HOSTING.md).
