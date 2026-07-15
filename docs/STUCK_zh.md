# FastCUA / Agent 为什么会卡住（以及怎么办）

给**使用方和 Agent**。软件侧应快速失败；人类控制是故意的阻塞。

## 软件动作预算：30 秒

| 层 | 上限 |
|----|------|
| 原生 Host 请求（daemon → host） | **30s** 超时并重置 helper |
| MCP 请求（`server.mjs`） | **30s** |
| JS REPL 单元（默认） | **30s**（可用 `FASTCUA_JS_TIMEOUT_MS` 覆盖） |
| UIA 快照线程 | 约 1.5s（失败则标记树差） |
| 人类审批等待 | 另算（等人，不是软件动作） |

超时后：**同一调用最多再试 1 次**，然后换策略或报告。禁止空转重试。

## 为什么会出现「烂树」

树是 **Windows UI Automation**，不是截图。常见原因：

1. **应用无障碍做得很差** — Electron、自绘画布、游戏、大量自定义控件。
2. **有节点但点不到** — 无包围盒（树里 `[no-hit]`）、虚拟化导航、DirectUI 另存为等。
3. **Provider 超时** — 该进程 UIA 挂起，FastCUA 放弃本次树。
4. **只有壳** — 只有 Window/Pane/TitleBar，没有真正的 Button/Edit/菜单项。
5. **索引过期** — `element_index` 只对**最近一次** `get_window_state(include_text:true)` 有效；弹窗、列表刷新后作废。

截图可以很清晰，树仍然不可用——这是正常现象。

### Agent 必须怎么做

看 `get_window_state` 返回的 **`state.uia`**：

- `prefer_vision: true` 或 `quality` 为 `broken`/`weak` → **立刻** `sky.grid_view`，**禁止**再点 `element_index`。
- `element_index` **stale 一次** → 同样立刻切视觉，不要死磕同一索引。

## 卡住类型

| 类型 | 进程 | 日志 | 原因 | 处理 |
|------|------|------|------|------|
| 假 PASS | 已退出 | 停 | 口头完成无产物 | 必须验证文件/UI |
| 审批/暂停 | 在 | 可能刷错误 | Safe / F8 | 等人；勿刷工具 |
| 烂树 + 死点索引 | 在 | 涨 | 仍点 UIA | `prefer_vision` → 网格 |
| 另存为/DirectUI | 在 | 涨 | 假点击 | SendInput + 网格/快捷键 |
| 管道死锁 | 在 | **不涨** | 父进程堵 stdio | 重定向日志 |
| 模型挂起 | 在 | **不涨** | LLM/MCP | 客户端看门狗 |

## 默认白名单

Safe 模式对**未知**应用仍要审批。默认（精确 basename / AUMID）含：画图、记事本、资源管理器、计算器、终端、cmd/PowerShell、写字板、VS Code、部分 Agent 宿主。

**默认不**整站放行浏览器、密码管理器、系统安全界面。可在 `config.json` 的 `whitelist` 增删，或在灵动岛选始终批准 / 完全访问。

已有用户配置**不会**自动合并新默认项，需自行编辑或重装默认。

## OpenCode / 无头调试

- 不要用「打开某个 prompt 文件」当任务说明——模型会用 CUA 去开记事本。
- 步骤写进对话；`RESULT:PASS` 必须以**外部产物**为准。
- 长任务优先交互 TUI。

## 相关

- Skill：`skills/computer-use/SKILL.md`
- 自部署：[SELF_HOSTING_zh.md](SELF_HOSTING_zh.md)
