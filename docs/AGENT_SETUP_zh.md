# FastCUA Agent 自部署指南

一次完整的 FastCUA 安装必须在**同一个 Agent 宿主**中同时具备两部分：

1. 完整的 `skills/computer-use/` 操作规范（Skill）；
2. `sky-computer-use` stdio MCP Server（`server.mjs`）。

只装 MCP 有能力却缺少必要的操作规范；只装 Skill 则没有执行器。
本文档和 `scripts/agent-setup.ps1` 会为常见 Agent 宿主自动完成这两部分。

## 快速开始（Agent 或人均可执行）

```powershell
# 查看检测到的 Agent 及其当前 FastCUA 配置状态
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action List

# 为所有检测到的 Agent 安装 Skill + MCP
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Install

# 只配置某一个 Agent
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Install -Agent qoder

# 校验配置并运行真实 MCP 冒烟测试
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Verify
```

脚本会自动备份每个被修改的配置文件（`<文件>.bak.<时间戳>`），并支持 `-DryRun`。

## 支持的 Agent

| Agent | MCP 配置文件 | Skill 目录 |
|---|---|---|
| Qoder | `%USERPROFILE%\.qoder\mcp.json`（`mcpServers`） | `%USERPROFILE%\.qoder\skills\computer-use` |
| Claude Code | `%USERPROFILE%\.claude.json`（`mcpServers`） | `%USERPROFILE%\.claude\skills\computer-use` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`（`mcpServers`） | 无（仅 MCP） |
| Codex CLI | `%USERPROFILE%\.codex\.mcp.json`（`mcpServers`） | `%USERPROFILE%\.codex\skills\computer-use` |
| VS Code（Copilot MCP） | `%APPDATA%\Code\User\mcp.json`（`servers`） | 无（仅 MCP） |
| opencode | `%USERPROFILE%\.config\opencode\opencode.json`（`mcp`） | `%USERPROFILE%\.config\opencode\skills\computer-use` |
| Kimi Work | 在应用内配置 | `%APPDATA%\kimi-desktop\daimon-share\daimon\skills\computer-use` |

脚本写入的标准 stdio MCP 条目：

```json
{
  "sky-computer-use": {
    "command": "node",
    "args": ["%LOCALAPPDATA%\\FastCUA\\app\\server.mjs"]
  }
}
```

## 谁负责启动什么（生命周期）

任何组件都**不需要手动启动**。daemon 由 MCP Server 在首次调用时按需拉起。

| 组件 | 由谁启动 | 何时启动 | 是否需要手动操作 |
|---|---|---|---|
| `server.mjs`（stdio MCP） | Agent 宿主 | Agent 建立连接时 | 否 |
| 常驻 daemon | `server.mjs` | 首次 MCP 调用 | 否 |
| Rust 原生 host | daemon | 首次桌面操作请求 | 否 |
| 历史存储 | daemon | 随 daemon 启动 | 通过宿主插件查看 |

配置时**不要**手动运行 `node daemon.mjs`。

## 验证

Agent 客户端重启后，Agent 必须确认以下三点：

1. `sky-computer-use` MCP 工具存在（`list_apps`、`list_windows`、`js`、`close` 等）；
2. `runtime_info` 报告 `root = %LOCALAPPDATA%\FastCUA\app` 且版本与已安装版本一致；
3. `list_apps` 或 `list_windows` 返回真实的 Windows 数据。

`-Action Verify` 为人类执行同样的检查，包括对 `server.mjs` 的真实 stdio
MCP 往返调用（initialize → tools/call `list_windows`），要求常驻 daemon 返回成功结果；
仅凭 tools/list 的工具元数据不算通过。

如果 `runtime_info` 报告了其他目录或版本，说明 Agent 正在连接一个过期的
检出副本。运行：

```powershell
& "$env:LOCALAPPDATA\FastCUA\app\install.ps1" -Action Doctor
& "$env:LOCALAPPDATA\FastCUA\app\scripts\agent-setup.ps1" -Action Verify
```

`-Action List` 会在某个宿主指向与已安装运行时不同的 `server.mjs`
（例如开发检出目录）时标记 `MCP configured but STALE`。

## 配置与控制

FastCUA 无界面运行，默认 **Full access**。所有设置在本地 `config.json`（`%LOCALAPPDATA%\FastCUA\data\config.json`）中，编辑后重启 daemon 生效。暂停、插话、审批等控制由宿主（DeepSeek Harness 插件）或 daemon 命名管道方法提供。

## 故障排除

| 现象 | 解决方法 |
|---|---|
| Agent 报告 FastCUA 不可用 | 重启 Agent 客户端；MCP 配置在启动时加载 |
| `MCP configured but STALE` | 重新运行 `-Action Install -Agent <名称>` |
| 冒烟测试失败 | `install.ps1 -Action Doctor`；检查 `node --version` |
| Verify 提示桌面控制已暂停 | 通过宿主控制面（DeepSeek Harness 插件）恢复，或重启 daemon |
| Skill 未被发现 | 确认复制的是完整的 `computer-use` 文件夹，而不是单个 SKILL.md |

## 安全说明

- 不要安装转发式或删减版的 `SKILL.md`；完整操作规范是必需的。
- 不要将本地管道暴露到本机之外。
- 配置备份文件（`*.bak.*`）可能包含其他 MCP 注册信息，仅在本机使用。
