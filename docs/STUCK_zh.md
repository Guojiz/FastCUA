# FastCUA / Agent 为什么会卡住（以及怎么办）

**读者：** 使用方与正在执行桌面任务的 Agent。  
**不在这里写：** 安装步骤（[SELF_HOSTING_zh.md](SELF_HOSTING_zh.md)）、产品总览（[README_zh](../README_zh.md)）、完整 Agent API 规程（`skills/computer-use/`）。

软件侧必须**快速失败**。人类暂停 / 审批是故意阻塞——不是用工具刷请求去「修」的挂起。

## 软件动作预算：30 秒

| 层 | 上限 |
|----|------|
| 原生 Host 请求（daemon → host） | **30s**，超时并重置 helper |
| MCP 请求（`server.mjs` → daemon） | **30s** |
| JS REPL 单元（默认） | **30s**（可用 `FASTCUA_JS_TIMEOUT_MS` 覆盖） |
| UIA 快照线程 | 约 1.5s（失败则标记树差） |
| 人类审批等待 | 另算（等人，不是软件动作） |

超时后：**同一调用最多再试 1 次**，然后换策略或报告。禁止空转重试。

这些是产品在 `daemon.mjs` / `server.mjs` 中的默认；Agent 侧须在 `skills/computer-use`（Skill + guidance）中遵守同一预算。

## 为什么会出现「烂树」

树是 **Windows UI Automation**，不是截图。常见原因：

1. **应用无障碍做得很差** — Electron、自绘画布、游戏、大量自定义控件。
2. **有节点但点不到** — 无包围盒（树中 `[no-hit]`）、虚拟化导航、DirectUI 另存为等。
3. **Provider 超时** — 该进程 UIA 挂起，FastCUA 放弃本次树。
4. **只有壳** — 只有 Window / Pane / TitleBar，没有真正的 Button / Edit / 菜单项。
5. **索引过期** — `element_index` 只对**最近一次** `get_window_state(include_text: true)` 有效；弹窗、列表刷新后作废。

截图可以很清晰，树仍然不可用——这是正常现象。

### Agent 必须怎么做

文本快照后读 **`state.uia`**（见 Skill bootstrap）：

| 信号 | 必须行为 |
|------|----------|
| `prefer_vision: true` 或 `quality` 为 `broken` / `weak` | **立刻** `sky.grid_view`，**禁止**再点 `element_index` |
| `element_index` stale / 不可用一次 | 同样立刻切视觉，不要死磕同一索引 |

产品规则与 Skill 规则一致：烂树 → **立刻**视觉，不是再多试几次索引。

## 卡住类型

| 类型 | 进程 | 日志 | 原因 | 处理 |
|------|------|------|------|------|
| 假完成 | 已退出 | 停 | 口头完成无产物 | 必须验证文件 / UI |
| 审批 / 暂停 | 活 | 可能刷错误 | Safe / F8 | 等人；勿刷工具 |
| 烂树 + 死点索引 | 活 | 涨 | 仍点 UIA | `prefer_vision` → 网格 |
| 另存为 / DirectUI | 活 | 涨 | 假点击 | SendInput + 网格 / 快捷键 |
| 管道死锁 | 活 | **不涨** | 父进程堵 helper stdio | 重定向日志 / 异步读 |
| 模型 / 客户端挂起 | 活 | **不涨** | LLM 或 MCP 客户端 | 外层客户端看门狗 |

## 默认白名单（仅影响审批）

Safe 模式对**未知**应用仍要审批。默认项为**精确**可执行文件名 / AUMID（无子串匹配）。常见本地工具默认在列（画图、记事本、资源管理器、计算器、终端、cmd/PowerShell、写字板、VS Code、部分 Agent 宿主）。

**默认不**整站放行：浏览器类、密码管理器、系统安全界面。

一致性：

- **白名单 ≠ 允许自动化。** Skill 仍禁止自动化终端、密码管理器、认证框与安全界面。白名单只表示：若触碰这些应用，**可跳过审批弹窗**。
- 已有用户 `config.json` **不会**在默认列表扩展时自动合并。请编辑 `whitelist`，或在灵动岛选「始终批准」/「完全访问」。新安装使用代码默认。

## 相关（各写各的）

| 主题 | 位置 |
|------|------|
| 产品原理、一键安装 | [README_zh](../README_zh.md) |
| 编译 + 安装 Skill **与** MCP | [SELF_HOSTING_zh.md](SELF_HOSTING_zh.md) |
| Agent 运行规程（接入、标签、网格、安全） | `skills/computer-use/SKILL.md` + `docs/guidance.md` |
| 可选客户端说明（如 OpenCode 无头） | [OPENCODE.md](OPENCODE.md) |
