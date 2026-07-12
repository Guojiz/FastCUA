# FastCUA 中文自部署指南

本指南安装完整本地栈：Windows 原生 Host、常驻 daemon、Dynamic Island、本地控制台与 MCP 桥接层。

## 1. 前置条件

- Windows 11 x64
- Node.js 18 或更高版本
- Rust stable（MSVC 工具链）
- Rust 编译需要时，安装 Visual Studio Build Tools 的 **Desktop development with C++**

检查工具：

```powershell
node --version
rustc --version
cargo --version
```

## 2. 克隆与编译

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
./native-host/build.ps1
```

Release 二进制位于 `native-host/target/release/cua-native-host.exe`，daemon 会自动发现。若要换用其他兼容 Host，可在当前进程设置 `CUA_BIN`，或在本地控制台填写 `cuaBinPath`。

```powershell
$env:CUA_BIN = 'C:\tools\cua-native-host.exe'
```

不要把本机专属路径或 Helper 二进制提交到仓库。

## 3. 启动与验证

```powershell
node daemon.mjs
Invoke-RestMethod http://127.0.0.1:8420/api/state
```

响应应包含 `controlState`、`pendingApprovals`、`clients` 和 `uptime`。打开 `http://127.0.0.1:8420` 使用双语控制台。

检查交互：

1. 正常状态只显示透明小岛。
2. 屏幕四周显示不拦截点击的彩虹边框。
3. `F7` 或单击紧凑状态岛会先暂停控制，再打开本地设置控制台。
4. `F9` 展开并聚焦更大的插话框。
5. `F8` 后状态变为 `paused_by_user`，再次按下恢复为 `running`。
6. `F10` 会释放 Helper、浮窗、命名管道和 HTTP 服务。

## 4. 选择安全策略

`safe` 是默认且推荐的模式。可信条目必须是精确可执行文件名（如 `notepad.exe`）或精确绝对路径。未知应用会让控制平面进入 `awaiting_approval`，同时展开岛；用户可选择仅允许一次、加入可信名单或拒绝。请求 60 秒后自动过期。

`full` 是独立且显式开启的免询问模式，启用期间始终以紫粉色明确提示。

公开控制台不提供无条件自动授权选项。

## 5. 连接 MCP 客户端

在客户端配置中使用绝对路径：

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

此格式适用于兼容 MCP 的桌面客户端、编辑器和 Agent Runtime。`server.mjs` 只是 stdio 薄桥接层，所有客户端共用 daemon 与同一份原生光标状态。

## 6. 直接接入命名管道

高级客户端可以通过 `\\.\pipe\fastcua` 交换换行分隔 JSON：

```js
import net from "node:net";

const socket = net.connect("\\\\.\\pipe\\fastcua", () => {
  socket.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
socket.on("data", data => process.stdout.write(data));
```

## 7. 运行检查

```powershell
node --check daemon.mjs
node --check server.mjs
$null = [xml](Get-Content -Raw card.xaml)
$null = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path overlay.ps1), [ref]$null, [ref]$null)
cargo test --manifest-path native-host/Cargo.toml
```

编译原生 Host 后，再运行 `tests/` 中的协议回归脚本。

## 故障排查

- **找不到 Host：** 编译 release 版本，或把 `CUA_BIN` 指向真实存在的 `.exe`。
- **岛没有出现：** 确认 `overlayEnabled` 为 true，并检查 `overlay.log`。
- **快捷键无反应：** 其他程序可能占用了同一全局快捷键；关闭冲突程序后重启 FastCUA。
- **未知应用等待处理：** 在展开的状态岛中选择仅允许一次、加入可信名单或拒绝。
- **端口被占用：** 在 `config.json` 中选择 1024–65535 的端口，再重启 daemon。

HTTP 服务必须保持在 `127.0.0.1`，不要通过代理暴露到公网。

English version: [SELF_HOSTING.md](SELF_HOSTING.md).
