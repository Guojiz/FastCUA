# FastCUA 中文自部署指南

本指南部署完整本地栈：Windows 原生 Host、常驻 daemon、灵动岛、本地控制台、Computer Use Skill 与 MCP 桥接层。

> **完整安装必须同时包含 Skill 和 MCP。** 只启动 daemon、只读取 `SKILL.md`、只添加 MCP，或只复制 Skill，都不算安装完成。

默认安装目标是**当前执行部署指令的 Agent 自己**。除非用户明确指定另一个客户端，否则不要修改、切换或代替其他 AI 客户端进行安装。

## 1. 前置条件

- Windows 11 x64
- Node.js 18 或更高版本
- Rust stable，使用 MSVC 工具链
- Rust 编译需要时，安装 Visual Studio Build Tools 的 **Desktop development with C++**
- 一个同时支持本地 Skill 和 stdio MCP 的 Agent

检查工具：

```powershell
node --version
rustc --version
cargo --version
```

## 2. 克隆并编译运行时

```powershell
git clone https://github.com/Guojiz/FastCUA.git
cd FastCUA
.\native-host\build.ps1
```

Release 二进制位于：

```text
native-host\target\release\cua-native-host.exe
```

daemon 会自动发现它。若要使用其他兼容 Host，可在当前进程设置 `CUA_BIN`，或在本地控制台填写 `cuaBinPath`：

```powershell
$env:CUA_BIN = 'C:\tools\cua-native-host.exe'
```

不要把本机专属路径或 Helper 二进制提交到仓库。

## 3. 安装到当前 Agent，必做

部署分为两个缺一不可的部分：

1. 把完整的 `computer-use` Skill 安装到当前 Agent。
2. 把 `sky-computer-use` MCP Server 安装到同一个 Agent。

### 3.1 安装完整 Skill

Skill 源目录是：

```text
<FastCUA 仓库绝对路径>\skills\computer-use
```

当前 Agent 必须执行下面的动作：

1. 找到它自己正在使用的 Skill 目录或 Skill 注册机制。
2. 把整个 `computer-use` 文件夹复制、链接或注册进去。
3. 保留目录内的 `SKILL.md` 及同目录资源，不能只读取源文件。
4. 重新加载或重新索引 Skill。
5. 确认当前 Agent 可以发现并启用名为 `computer-use` 的 Skill。

只让 Agent 阅读仓库中的 `SKILL.md` 不算安装。

### 3.2 安装 MCP Server

先取得绝对路径：

```powershell
$node = (Get-Command node).Source
$root = (Resolve-Path .).Path
$node
$root
```

然后在**当前 Agent 自己的 MCP 配置**中添加：

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

把示例路径替换为 `$node` 和 `$root\server.mjs` 的真实绝对路径。

不要默认写入另一个 AI 客户端的配置。接收部署指令的 Agent 应优先修改自己的 MCP 配置。

## 4. 重新加载并完成双重验证

安装后，按当前客户端要求重新加载 Skill、重连 MCP，必要时重启 Agent。

必须同时通过下面两项：

1. **Skill 验证**：当前 Agent 能发现或调用 `computer-use` Skill。
2. **MCP 验证**：通过 `sky-computer-use` 调用 `list_windows`，并返回真实的 Windows 窗口数据。

安装 Agent 最后必须报告：

- Skill 被复制、链接或注册到哪个位置；
- 修改了哪个 MCP 配置文件；
- `computer-use` Skill 是否已加载；
- `list_windows` 是否成功返回。

任意一项失败都应报告为**安装失败或客户端不兼容**，不能改用 PowerShell UI Automation、SendKeys、pyautogui、浏览器自动化或其他桌面控制方式假装完成。

## 5. daemon 的默认启动方式

正常使用时不必手动运行 daemon。`server.mjs` 在 MCP 第一次连接时会自动启动本地 daemon。

需要调试时才手动启动：

```powershell
node daemon.mjs
Invoke-RestMethod http://127.0.0.1:8420/api/state
```

响应应包含 `controlState`、`pendingApprovals`、`clients` 和 `uptime`。打开 `http://127.0.0.1:8420` 使用双语控制台。

检查交互：

1. 正常状态只显示透明小岛。
2. 屏幕四周显示不拦截点击的彩色边框。
3. `F7` 或单击紧凑状态岛会先暂停控制，再打开本地控制台。
4. `F9` 展开并聚焦插话框。
5. `F8` 在暂停与运行之间切换。
6. `F10` 释放 Helper、浮窗、命名管道和 HTTP 服务。

## 6. 选择安全策略

`safe` 是默认且推荐的模式。可信条目必须是精确可执行文件名，例如 `notepad.exe`，或精确绝对路径。未知应用会让控制平面进入 `awaiting_approval`，用户可选择仅允许一次、加入可信名单或拒绝。请求 60 秒后自动过期。

`full` 是独立且显式开启的免询问模式，启用期间始终以紫粉色明确提示。

公开控制台不提供无条件自动授权选项。

## 7. 直接接入命名管道

只有不使用 MCP 的高级客户端才需要直接接入 `\\.\pipe\fastcua`。普通 Agent 应安装 Skill 与 MCP，不应把直接管道当成默认安装路径。

```js
import net from "node:net";

const socket = net.connect("\\\\.\\pipe\\fastcua", () => {
  socket.write(JSON.stringify({ id: 1, method: "list_apps", params: {} }) + "\n");
});
socket.on("data", data => process.stdout.write(data));
```

## 8. 发布前检查

```powershell
node --check daemon.mjs
node --check server.mjs
$null = [xml](Get-Content -Raw card.xaml)
$null = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path overlay.ps1), [ref]$null, [ref]$null)
cargo test --manifest-path native-host/Cargo.toml
node tests/installer-contract.mjs
```

编译原生 Host 后，再运行 `tests/` 中的协议、备用元素编号和控制平面回归脚本。

## 故障排查

- **Agent 只读取 Skill，没有安装：** 要求它把整个 `skills\computer-use` 目录复制、链接或注册到自己的活动 Skill 系统，并重新索引。
- **MCP 工具不存在：** 确认 `sky-computer-use` 已写入当前 Agent 自己的 MCP 配置，并重新连接。
- **只完成其中一项：** 判定为安装失败，不要继续桌面任务。
- **找不到 Host：** 编译 release 版本，或把 `CUA_BIN` 指向真实存在的 `.exe`。
- **岛没有出现：** 确认 `overlayEnabled` 为 true，并检查 `overlay.log`。
- **快捷键无反应：** 其他程序可能占用了同一全局快捷键，关闭冲突程序后重启 FastCUA。
- **未知应用等待处理：** 在展开的状态岛中选择仅允许一次、加入可信名单或拒绝。
- **端口被占用：** 在 `config.json` 中选择 1024 到 65535 的端口，再重启 daemon。

HTTP 服务必须保持在 `127.0.0.1`，不要通过代理暴露到公网。

English version: [SELF_HOSTING.md](SELF_HOSTING.md).
