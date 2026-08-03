# FastCUA 技术实现报告

覆盖整个软件的综合性技术报告：架构、组件、通信协议、安全模型、Skill 录制器子系统、运行时标识与发布机制、测试与 CI/CD。与
[`control-center-window.md`](control-center-window.md)（独立控制台窗口）和
[`skill-recorder-design.md`](skill-recorder-design.md)（录制器设计笔记）互为补充。

- [1. 概述](#1-概述)
- [2. 系统架构](#2-系统架构)
- [3. 组件深入解析](#3-组件深入解析)
- [4. 通信协议](#4-通信协议)
- [5. Skill 录制器子系统](#5-skill-录制器子系统)
- [6. 安全模型](#6-安全模型)
- [7. 运行时标识、更新与发布](#7-运行时标识更新与发布)
- [8. 测试体系](#8-测试体系)
- [9. CI/CD](#9-cicd)
- [10. 边界与已知限制](#10-边界与已知限制)

## 1. 概述

FastCUA 把 Windows GUI 变成 AI Agent 可执行的快速接口，是一个本地优先（local-first）的 Windows Computer Use 运行时，核心特性：

- **无障碍优先、视觉可选** —— 导航优先使用 Windows UI Automation（UIA）文本；仅在像素能提供额外信息（画布、自绘控件、校验）时才请求截图。
- **单一热控制面** —— 所有 Agent 客户端共享一个常驻 daemon 和一个原生 host（一个光标）。窗口标识、审批、暂停、插话都住在控制面里，而不是每次点击重建。
- **单轮多次动作** —— 通过 MCP，Agent 获得持久 JS 环境（`sky.*`），键盘、文本、点击、拖拽、滚动可以在一个模型回合内顺序执行。
- **默认安全、本地设计** —— 安全模式下未知应用需人工审批；控制台仅绑定回环地址；策略留在本机。

运行时以单一版本化 Windows 包发布：MCP server、daemon、编译好的 Rust 原生 host、WPF 悬浮岛、Web 控制中心、Skill 录制器工具链和完整 Skills。薄壳 npm CLI（`fastcua`）负责引导安装；真正的运行时从 GitHub Release 下载并做 SHA-256 校验。

## 2. 系统架构

```
Agent + computer-use Skill（任意厂商客户端）
  │  stdio MCP（JSON-RPC，换行分隔）
  ▼
server.mjs  "sky-computer-use"（Node，每客户端一个）
  │  命名管道：\\.\pipe\fastcua-<rootHash12>
  ▼
daemon.mjs  控制面（Node，单一常驻）
  │  stdio JSONL（换行分隔）
  ▼
cua-native-host.exe（Rust，单一共享 helper）
  ├─ UI Automation（手写原始 COM 绑定）
  ├─ 截图 / 网格覆盖层（GDI + PrintWindow/BitBlt）
  └─ SendInput 键盘与鼠标
daemon.mjs 同时负责：
  ├─ 策略 · 暂停 · 审批 · 插话
  ├─ HTTP 控制台  http://127.0.0.1:<端口>（web.html，仅回环）
  └─ overlay.ps1 + card.xaml（WPF 动态悬浮岛，F7/F8/F9/F10）
```

| 层 | 职责 | 谁读它 |
|---|---|---|
| Skill `skills/computer-use/` | 如何执行桌面任务（bootstrap、标签、网格、安全） | 仅 Agent |
| MCP `server.mjs` | 工具 + 持久 `js`/`sky` | Agent 工具 |
| Daemon + 原生 host | 共享生命周期、UIA、截图、输入、策略 | 运行时 |
| README / 自托管文档 | 面向人的产品与安装 | 人 |
| 悬浮岛 / 控制台 | 暂停、审批、插话 UI | 人 |

单次动作的数据流：Agent 调用 MCP 工具（或执行 JS cell）→ `server.mjs` 经命名管道转发请求给 daemon → daemon 检查审批/暂停/中断状态后经 stdio 转发给原生 host → host 执行 Windows 操作并返回 JSON 结果 → 每一跳都有 30 秒预算；host 内部对僵死 UIA provider 超时约 1.5 秒，不会阻塞共享 helper。

## 3. 组件深入解析

### 3.1 MCP server —— `server.mjs`（约 814 行）

- **手写 stdio JSON-RPC 2.0**，不依赖任何 MCP SDK。`process.stdin` 逐行读取（换行分隔 JSON，非 LSP Content-Length 帧）。支持 `initialize`（protocolVersion `2024-11-05`，capabilities `{tools:{}}`，serverInfo `sky-computer-use`）、`initialized`、`tools/list`、`tools/call`；未知方法返回 `-32601`，内部错误 `-32603`。
- **两个 daemon 连接**：`DaemonClient` 连命名管道 `runtimePipe(HERE)`（工具用），外加第二个 `replDaemon`（JS REPL 用）。若 daemon 未运行且 `costartMode !== "manual"`，server 以 detached 方式 spawn `node daemon.mjs`，并重试管道连接最多 40 × 350ms（约 14 秒冷启动预算）。
- **MCP 工具（17 个）**：`runtime_info`、`list_apps`、`list_windows`、`get_window`、`launch_app`、`get_window_state`、`click`、`press_key`、`type_text`、`scroll`、`set_value`、`drag`、`perform_secondary_action`、`activate_window`、`close`、`js`、`grid_view`。
- **`js` REPL**：`vm.createContext` + `vm.Script`，默认 30 秒预算（`FASTCUA_JS_TIMEOUT_MS` 可覆盖）。`AsyncLocalStorage` 追踪当前 cell；`trackedSetTimeout/Interval` 让所有定时器跟随 cell 生命周期；cell 结束时取消所有在途 `sky` 调用（`cancelOwner`），保证"脱离的桌面副作用"不会晚到。图片输出刻意最小化——`grid_view` 只发 1 张标注图；`get_window_state` 返回全部截图。
- **`sky` 客户端辅助**：`sky.viewport(state)`、`sky.grid(...)`（Apple 风格方形打包；refine 强制 3×3）、`sky.grid_cell(grid, id)`。点击安全模式：`grid_view`（选≠点）→ `grid_refine`（裁剪下钻）→ `click_cell`（格中心）/ `click_in_cell`（格内局部坐标，越界拒绝）/ `click_view`（view 图像内坐标，越界拒绝）。
- **客户端分组**：每个 server 进程生成 `CLIENT_GROUP = randomUUID()` 随管道请求发送，使中断锁存与一次性插话在客户端分组内共享。
- `close` 关闭两个 daemon 连接并退出进程；共享 daemon 保持运行。

### 3.2 常驻 daemon —— `daemon.mjs`（约 996 行）

- **HTTP server**：Node 内置 `node:http`，仅监听 `127.0.0.1`。端口：`config.port` → `runtimeDefaultPort()`（正式版 `8420`；开发版 `18000 + (rootHash 前 4 位 hex % 1000)`；`FASTCUA_HTTP_PORT` 可覆盖）。
- **每个响应携带安全头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`，以及 `Content-Security-Policy: default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:`。
- **POST origin 校验**（`trustedMutationOrigin`）：无 Origin 头（如 curl）视为可信；有 Origin 头则必须是 `http:` + hostname `127.0.0.1`/`localhost` + daemon 自身端口，否则返回 `403 untrusted request origin`。POST 体有大小上限（配置 64KB、动作 16KB）。
- **API 端点**：

  | 端点 | 方法 | 用途 |
  |---|---|---|
  | `/`, `/index.html` | GET | `web.html` 控制中心 |
  | `/api/state` | GET | 客户端数、`binaryPid`、`approvedApps`、`pendingApprovals`、`approvalPolicy`、`controlState`、uptime、运行时身份、更新状态、近期日志 |
  | `/api/config` | GET/POST | 读写配置；策略/白名单变化清空 `approvedApps`；costart 变化重写注册表 Run 键 |
  | `/api/skill-writer/config` | GET/POST | Skill 合成子代理配置；API key 单独存储，POST 只返回 `hasApiKey`/末 4 位提示——绝不返回明文 |
  | `/api/events?since=N` | GET | 轮询式事件流（非 SSE）：返回 `id > since` 的事件数组 + `inflight` + `pendingApprovals` + `controlState` |
  | `/api/action` | POST | `killBinary`、`clearApprovals`、`pause`、`resume`、`allowOnce`、`allowAndWhitelist`、`alwaysApprove`、`fullAccess`、`denyApproval`、`restart`、`shutdown`、`stopAll` |
  | `/api/interject` | POST | 注入插话文本（≤2000 字符）；原子执行"取消在途 + 锁存一条指令 + 自动恢复" |

- **事件模型**：内存环形缓冲 200 条；类型 `action_start`、`action_end`、`approval_required`、`approval_allowed`、`approval_denied`、`paused`、`resumed`、`interjection`、`interrupt`、`policy`、`shutdown`。悬浮岛每 2 秒轮询 `/api/events?since=`。
- **原生 host 生命周期**：二进制发现顺序——`config.cuaBinPath` → `CUA_BIN` 环境变量 → 本地候选路径（`native-host/target/release/`、`helper/`、仓库根）。以 `--parent-pid <daemon pid>` 拉起，daemon 退出则 host 自动退出；`FASTCUA_HOME`/`CODEX_HOME` 指向运行时数据目录。单一共享 helper；30 秒请求预算；超时用 `taskkill /PID <pid> /T /F` 杀整个进程树并 `resetBinary`。`proc !== child` 守卫防止旧进程的 exit 回调清掉新一代的 pending 请求。
- **UIA 质量档案**：持久化到 `uia-profile.json`（30 天 TTL），helper 重启时清空；已知坏应用做 300ms 短探针。
- **审批流**：host 响应可携带 `approvalRequest` → daemon 在应用已入白名单或策略为 `full` 时自动放行（缓存进 `approvedApps`）；否则创建 `pendingApprovals` 条目，token 为 `crypto.randomUUID()`，60 秒超时自动拒绝。决策语义：`allow_once` / `allow_and_whitelist`（持久化到白名单）/ `full_access`（切换策略并放行全部 pending）/ `deny`。元数据键 `x-fastcua-approved-app` / `x-fastcua-request-budget-ms` 与旧键 `x-oai-cua-*` 双写兼容。
- **中断**：向 `<dataDir>/cache/computer-use/interrupts/<session>/<turn>` 写标记文件；Agent 侧收到带前缀的错误消息。控制面标签（Agent 契约）：`[control_plane:stopped]`、`:paused`、`:shutdown`、`:awaiting_approval`、`:interjection`（唯一的"指令"，自动恢复）。
- **开机自启**：写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`；值名正式版 `FastCUA`、开发版 `FastCUA-dev-<hash>`，多安装互不干扰。
- **悬浮岛启动**：`overlayEnabled && FASTCUA_DISABLE_OVERLAY !== "1"` 时以 `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File overlay.ps1 -Port <port> ...` 拉起；stderr 写 overlay.log；进程 `unref()`。

### 3.3 原生 host —— `native-host/`（Rust）

| 文件 | 职责 |
|---|---|
| `src/main.rs`（约 290 行） | DPI 感知、`--parent-pid` 看门狗线程、悬浮圈启动、stdin JSON 分发、审批校验、中断文件检查 |
| `src/desktop.rs`（约 2530 行） | 全部桌面能力：窗口枚举/启动/激活、UIA 快照协调、截图、网格、输入 |
| `src/uia.rs`（约 820 行） | 手写原始 COM 绑定（不用 `windows` crate）：快照、点命中、focused value 读写 |
| `src/win32.rs`（约 410 行） | kernel32/user32/gdi32/shell32 的 FFI 声明 |
| `src/overlay.rs`（约 163 行） | 光标光晕覆盖层（GDI 分层窗口，脉动光圈） |

- **依赖**：仅 `base64`、`jpeg-encoder`、`serde`、`serde_json`——无 `windows`/`winapi` crate，全部 FFI 手写（COM 通过 vtable 槽号 transmute 调用）。release profile：`codegen-units=1, lto=true, opt-level="z", panic="abort", strip=true`，体积最小化。
- **UIA**：`CoInitializeEx(MULTITHREADED)`；快照在独立线程跑并 `recv_timeout(1500ms)`，僵死 provider 永不阻塞 host；该应用的 UIA 在本会话内禁用，调用回退 HWND 树并标记 `uia.prefer_vision: true`。
- **输入**：`SendInput`（`INPUT`/`KEYBDINPUT`，Unicode 文本走 `KEYEVENTF_UNICODE`）、`SetCursorPos` + `SendInput` 点击，以及旧式 `keybd_event` 和弦路径。鼠标动作做稳定等待、前台/光标复检，文本按批复查前台；这些是采样式“检测并中止”，不是设备排他锁。`keybd_event` 已被官方标为 superseded，应迁移为一次平衡且可检查插入数的 `SendInput[]` 事务。
- **窗口激活**：`ShowWindow` + `AttachThreadInput` + `BringWindowToTop` + `SetForegroundWindow`，1.5 秒预算内重试 10 × 10ms。
- **截图**：优先 `PrintWindow(PW_RENDERFULLCONTENT)`，挂起窗口回退 `BitBlt`（`SRCCOPY|CAPTUREBLT`）；BGRA→RGB；盒式平均缩放到 `max_edge`（默认 1568）；FNV-1a `frame_hash` + 2 秒 TTL 去重（`unchanged: true` 复用旧图）。
- **网格定位**：纯方形打包，5×7 位图数字字体绘制半透明描边格子；refine 强制 3×3。
- **无 OCR**：视觉定位靠 UIA 质量评估 + 编号方形网格——host 保持零额外依赖。
- **通信**：stdin/stdout 换行分隔 JSON `{id, method, params, meta}`；响应 `{id, ok:true, result}` 或 `{id, ok:false, error}` 或 `{id, ok:false, approvalRequest}`。method 白名单与 MCP 工具一一对应。
- **单调用预算**：UIA 1.5s、激活 1.5s、截图 3s、WM_GETTEXT 300ms、点命中 800ms。`FASTCUA_TEST_FORCE_UIA_FALLBACK=1` 强制 HWND 回退供测试。

> 深度解析：host 到底怎么驱动 Windows——原始 COM UIA 绑定与 vtable 槽位、快照算法、卡死防护、输入注入时序、窗口激活、捕获/去重、方形网格打包与 CPU 像素渲染、DPI 坐标契约、主循环安全门、并发模型——见 [`windows-control-internals.md`](windows-control-internals.md)（EN）/ [`windows-control-internals_zh.md`](windows-control-internals_zh.md)（ZH）。
>
> Windows 输入路径的论文级分析——形式化坐标映射、状态机、不变量、部分插入恢复前提、UIPI、证据边界与和弦重构——见 [`input-injection-internals.md`](input-injection-internals.md)（EN）/ [`input-injection-internals_zh.md`](input-injection-internals_zh.md)（ZH）。

### 3.4 悬浮岛 —— `overlay.ps1` + `card.xaml`

- PowerShell 承载的 WPF 动态悬浮岛（`Add-Type` 加载 `PresentationFramework`），UI 来自 `card.xaml`。
- `RegisterHotKey` 注册全局热键：`F7` 暂停 + 打开控制中心、`F8` 暂停/恢复、`F9` 暂停后插话、`F10` 退出（Agent 不得自行重启）。
- 每 2 秒轮询 `/api/state` + `/api/events?since=`，按状态变色：运行中（紧凑小岛 + 可穿透边框）、审批（琥珀色，按键 `1` 一次 / `2` 总是 / `3` 完全访问 / `4` 拒绝）、完全访问（紫/粉色）、暂停（红色）。
- 「设置」按钮 / F7 现在通过 `scripts/console.ps1`（Edge `--app` 模式）把控制中心打开为**独立窗口**，不再是浏览器标签页。

### 3.5 Web 控制中心 —— `web.html`（约 424 行）

- 由 daemon 在 `http://127.0.0.1:<端口>/`（仅回环）提供服务的单页控制中心，中英双语，无构建步骤。
- 在上述 CSP 下同源 `fetch('/api/...')`；交互模块：运行时状态、待审批（一次/加入白名单/完全访问/拒绝）、活动时间线（轮询事件）、设置（配置 + Skill 合成子代理）、更新横幅。

### 3.6 Skill 层 —— `skills/`

- `skills/computer-use/` —— 唯一的 Agent 操作规程（SKILL.md + docs/api.md + guidance.md + confirmations.md）。`allowed-tools: mcp__sky-computer-use mcp__sky-computer-use__*`。强制要求：先 `list_apps`/`list_windows` 一次完成 bootstrap；通过 MCP `js` 工具 + 持久 `sky` 对象工作；**禁止**直接 spawn 原生 host、自写协议客户端或回退 PowerShell/pyautogui；每轮结束调用 `close`。含 `uia.quality/prefer_vision` 决策表和 `[control_plane:*]` 标签行为映射。
- `skills/skill-recorder/` —— 七工具录制器 playbook（record → compile → synthesize → lint → dry-run → frame-extract → promote），含安全不变式（从不重建密码/安全桌面内容、promotion 永远需显式批准、dry-run 必须走 FastCUA 控制面）。

## 4. 通信协议

| 跳点 | 传输 | 帧格式 | 认证方式 |
|---|---|---|---|
| Agent ↔ MCP | stdio | JSON-RPC 2.0，换行分隔 JSON | 管道属主 + 本地配置 |
| MCP ↔ daemon | 命名管道 `\\.\pipe\fastcua-<rootHash12>` | JSON-RPC 风格 `{id, method, params}` | 管道名按安装路径隔离 |
| daemon ↔ 原生 host | stdio | 换行分隔 JSON `{id, method, params, meta}` | `--parent-pid` 看门狗；审批 token 在 `meta` |
| daemon ↔ Web/悬浮岛 | HTTP 回环 | REST JSON + 轮询 `?since=` | Origin 校验 + CSP；仅回环故无需认证 token |

命名管道名由规范化的安装根（sha256 前 12 位 hex）派生，因此每个运行时根都有独立管道——开发 checkout 永远无法挂到已安装 daemon 上。

## 5. Skill 录制器子系统

独立的"录制 Skill"工具（issue #3，阶段 2–5），参照 Claude Cowork 的 *Record a skill*。用户在真实桌面上演示工作流并口述意图；工具产出**不可执行、明确未验证**的证据包；独立配置的无工具子代理撰写自然语言 `SKILL.md`；溯源 lint 拒绝无证据支持的表述。

| 部件 | 路径 | 职责 |
|---|---|---|
| 录制器（原生） | `tools/skill-recorder/`（Rust 单文件约 3300 行） | 捕获 |
| 证据编译器 | `compile.mjs` | 确定性证据 + 回放草稿 |
| 专用 writer | `synthesize.mjs` | 自然语言 Skill 文稿 |
| 溯源 lint | `lint-skill.mjs` | 拒绝缺失/编造证据 |
| dry-run | `dryrun.mjs` | 回放验收证据 |
| 帧提取 | `frame-extract.mjs` | 视觉审查辅助 |
| 受控晋升 | `promote.mjs` | 属主批准后安装 |

**捕获引擎（Rust）**：
- 低级钩子 `WH_KEYBOARD_LL` + `WH_MOUSE_LL` + `SetWinEventHook(EVENT_OBJECT_FOCUS)`；钩子回调经 mpsc 送 writer 线程逐行 flush 写 `session.jsonl`（录制器被杀也留下可读的部分会话）。
- **会话格式 `fastcua-recording/1`**：第 0 行是头（工具版本、机器上下文、脱敏策略、热键映射）；之后每行一条：`key_down/up`、`mouse_down/up/move`、`wheel_*`（带 `injected`/`lower_il` 来源标记与前台窗口边界；移动采样 ≤ 1/40ms）、`focus_change`/`heartbeat`（聚焦元素 UIA 快照，含 `is_password`、value 类）、`keyframe`（稀疏 JPEG q75，原因 `note`/`action`/`focus`/`periodic`，或密码语境下 `suppressed:true`）、`note`（Ctrl+Alt+N 对话框）、`media`（音频轨可用性）、`stats`（钩子健康 + 媒体计数）。
- **锚点**：指针按下/抬起在两端点做 `ElementFromPoint`（300ms 有界工作线程）；按键关联最近焦点快照（≤800ms → `confidence:"high"`，≤2000ms → `"low"`）。锚点带 `value_class`，文本控件做有界 `WM_GETTEXT` 快照。**输入的文本只从 UIA/value 快照恢复——vk 码永不逆向映射为字符**（脱敏边界）。
- **脱敏**：密码字段（UIA `IsPassword` **或** `ES_PASSWORD`）丢弃 vk 与 value，标记 `redacted:"password-field"`，keyframe 记 `suppressed:true` 无图，视频帧替换为标记黑帧并记 gap（`reason:"password-focus"`）。安全桌面经 `OpenInputDesktop` 检测（非 "default" 即静默跳过）。
- **媒体轨**：手写 RIFF MJPEG-in-AVI 写入器（零依赖），整屏 `BitBlt`+`StretchBlt` HALFTONE 缩放到 ≤1568，默认 4fps，`video/index.jsonl` 供随机取帧；WASAPI 共享捕获 PCM 16kHz 单声道 16-bit → `audio/narration.wav`，无麦克风时优雅降级（`t:media` 记录）。
- **热键**：`Ctrl+Alt+N` 笔记、`Ctrl+Alt+R` 暂停、`Ctrl+Alt+X` 紧急停止。录制器启动即声明 Per-Monitor-V2 DPI 感知，保证钩子点、`ElementFromPoint`、UIA 边界共享同一物理像素坐标系。

**编译**（`compile.mjs`）：`session.jsonl` → 规范 `evidence.json`/`md`（不可执行）+ 确定性 `draft.json`/`md`（回放工件）+ `synthesis-request.json`（给 writer）。核心逻辑：`buildSteps`（type run 合并、redacted run 标记、指针手势 click-vs-drag 判定、wheel 独立成步）、`inferParameters`（日期/文件名/文本参数化 `{{param}}` 并保留溯源）、`sessionWarnings`（`⚠ unresolved` 标记）。快照选择在 Windows 保存对话框 Tab 后把目录路径剥离进地址栏时，优先采用更完整的在途 UIA 值（`a1c8077` 修复）。**编译器绝不写 SKILL.md**。

**合成**（`synthesize.mjs`）：OpenAI 兼容 `chat/completions`，可选直接把 WAV 当 `input_audio` 喂入或走 `audio/transcriptions`；`audioMode: auto|direct|transcribe|typed` 回退链（`typed` 模式音频完全留在本地）。API key 单独存放（`skill-writer-auth.json`，0600，或环境变量）。产出先经 lint 再原子落盘。

**Lint**（`lint-skill.mjs`）：frontmatter name/description/`verified:false`、≤200 行、必须有 Safety/Scope 节、每个 step/param/warning 必须带 `[evidence:*]` 引用（拒绝编造）、禁止内嵌 base64 媒体、必须有显式用户批准边界。

**Dry-run**（`dryrun.mjs`）：经真实控制面（命名管道）用**新的参数值**回放 `draft.json`；UIA 锚点现场重新解析，审批/暂停全部激活。退出码：0 ok / 2 用法 / 3 需要决策 / 4 fail-safe 中止 / 5 控制面停止。`decisions.json` 可确认 session 警告、按 step proceed/skip；越界、锚点无法解析、值不匹配一律 fail-safe。脱敏步骤永不执行。

**帧提取**（`frame-extract.mjs`）：按 `off/len` 从 AVI 切出单帧 JPEG（校验 SOI/EOI）；命中脱敏 gap 退出码 4。

**晋升**（`promote.mjs`）：门禁——`--yes-i-reviewed`、`verified:false` 需 `--force-unverified`、目标已存在需 `--overwrite`；`--detect-host` 探测活动宿主 Skill 目录（`FASTCUA_SKILLS_DIR` → Kimi Work → Claude Code → opencode）。任何东西都不会静默安装。

真机端到端由 `tests/skill-recorder-validation.mjs`（112 项检查）和 `tests/office-demo-e2e.mjs`（真实 Excel：录制→编译→换参数 dry-run→openpyxl 单元格校验）验证。

## 6. 安全模型

- **网络面**：HTTP 仅绑定 `127.0.0.1`；变更请求做严格 Origin 校验；CSP `connect-src 'self'`；`nosniff`/`DENY`/`no-referrer` 头；请求体大小上限。无 HTTP 认证 token——回环 + origin 校验即边界。
- **审批与信任**：安全模式下未知应用需人工审批；白名单匹配**精确**可执行文件路径/名称（绝不用模糊子串）；审批 token 为 `crypto.randomUUID()`，60 秒自动拒绝；审批状态按会话缓存（`approvedApps`），策略变化时清空。常见本地工具随默认白名单发布——白名单只跳过提示，Skill 的安全禁令（终端、密码管理器、安全 UI）仍然生效。
- **人工控制**：F7 暂停+控制台、F8 暂停/恢复、F9 插话、F10 退出；插话原子地取消在途工作并锁存一条指令。
- **脱敏**：录制器从不把按键码逆向映射为字符；密码字段丢弃 vk/value 并抑制 keyframe 与视频（标记帧）；安全桌面静默跳过；录制器自身窗口从事件流排除。
- **版本隔离**：管道名、开发版 HTTP 端口、数据目录、Run 键名全部由规范安装根哈希派生——多安装（开发 checkout vs 正式版）互不可见。
- **供应链**：每个发布资产都做 SHA-256 校验（zip + 逐文件 manifest）；更新器保留 `app.previous` 用于回滚，绝不覆盖开发 checkout；开发版永不联网检查更新。
- **凭据卫生**：skill-writer API key 单独存放（`~/.fastcua/skill-writer-auth.json`，0600），API 永不返回明文（只有 `hasApiKey`/末 4 位提示）。

## 7. 运行时标识、更新与发布

- **运行时标识**（`lib/runtime.mjs`）：`runtimeRootHash(root)` = `sha256(canonicalRoot)` 前 12 位 hex；`runtimePipe(root)` = `\\.\pipe\fastcua-<hash>`；`runtimeDataDir` = `FASTCUA_HOME` > `FASTCUA_CACHE_DIR` > 开发版 `root/.fastcua` > 正式版 `%LOCALAPPDATA%\FastCUA\data`；`runtimeDefaultPort` = 正式版 8420 / 开发版 `18000 + hash%1000`；`runtimeInfo` 合并 manifest + root/pipe/dataDir/configPath/port/pid。`compareVersions` 实现 semver（含 prerelease）排序。
- **更新检查**（`lib/update-check.mjs`）：状态机 `development → disabled → cached(24h) → available/current → error`；GitHub `releases/latest`，8 秒 AbortController 超时；`update-state.json` 原子写（tmp + rename）。已安装版本每天最多检查一次、只通知。
- **安装 / 更新 / 回滚**（`scripts/manage.ps1`，约 445 行）：
  - `Ensure-Node`：缺 node 时 `winget install --id OpenJS.NodeJS.LTS --silent` 自动装。
  - `Get-LatestRelease`：GitHub API `releases/latest` 或指定 tag。
  - `Assert-Runtime`：`runtime-manifest.json` 模式（schemaVersion 1、platform win32-x64）+ 逐文件 SHA-256 校验。
  - `Get-ReleaseRuntime`：下载 zip + `SHA256SUMS.txt`，校验、解压、再断言。
  - `Install-Runtime`：停已装 daemon（`POST /api/action` shutdown）→ 旧 `app` 移 `app.previous` → 新包就位 → 写 `install-state.json`；失败自动用 `app.previous` 回滚。
  - `Write-DesktopFiles`：桌面 `FastCUA Console.url` + `FastCUA Agent Setup.txt`（教 Agent 安装 Skill + MCP 的提示文本）。
  - `Invoke-Doctor`：检查已装运行时、扫描 AI 客户端配置中的 `server.mjs` 路径（`.codex/config.toml`、`.claude.json`、VS Code `mcp.json`、`repos/.mcp.json`）、校验存活 daemon 的 root 一致、检测多 daemon。
- **薄壳 npm CLI**（`bin/fastcua.mjs`）：子命令 `install`/`update`/`check`/`doctor`/`version`/`help`；非 win32 拒绝运行；每个动作 spawn `powershell.exe ... manage.ps1 -Action <Action>`。npm 包只装 CLI + `manage.ps1` + manifest——**不含运行时**；运行时从 GitHub Release 下载并校验。
- **发布流水线**（`scripts/build-release.ps1`）：两个 Rust crate `cargo build --release --locked` → 按固定清单复制到 stage 目录 → 写 `runtime-manifest.json`（version/channel/buildType/commit/buildTime/defaultPort + 逐文件 SHA-256）→ `Compress-Archive` 到 `dist/fastcua-runtime-win-x64.zip` → `SHA256SUMS.txt`。
- **发布包**（v0.3.0，commit 74c15bc，30 个文件）：`daemon.mjs`、`server.mjs`、`web.html`、`card.xaml`、`overlay.ps1`、`config.json`、`lib/runtime.mjs`、`lib/update-check.mjs`、`helper/cua-native-host.exe`、`install.ps1`、`uninstall.ps1`、`scripts/{manage,console}.ps1`、LICENSE、README（中英）、完整 `skills/computer-use/` 与 `skills/skill-recorder/`（SKILL.md + docs）、`tools/skill-recorder/`（`compile`、`dryrun`、`frame-extract`、`lint-skill`、`promote`、`synthesize`、`writer-config`.mjs + `target/release/skill-recorder.exe`）。不含 git 历史、测试、录制、日志、API key 或凭据。

## 8. 测试体系

| 套件 | 验证内容 |
|---|---|
| `real-machine-validation.mjs`（65 项） | 真机：UIA 路径（Notepad/fixture 编辑回读）、视觉截图 + `grid_view`、冻结应用 A/B/C（僵死 UIA 快速失败、杀窗口、断连恢复）、5 种点击模式、去重、UIA profile 短探针与康复 |
| `skill-recorder-validation.mjs`（112 项） | 真机录制 fixture 演示（含密码脱敏、注入标注）→ 编译断言 → 媒体轨（AVI/index/WAV）→ 帧提取脱敏门 → 晋升门（拒绝/强推/覆盖） |
| `office-demo-e2e.mjs`（23 步） | 真实 Excel 全链路：录制（开始页→工作簿→3 条笔记→SUM→F12 另存）→ 编译 → 用**不同**参数值 dry-run → openpyxl 断言新值真正写入单元格 |
| `approval-lifecycle.mjs` | 直接驱动原生 host：launch 触发 `approvalRequest` → 带 `x-oai-cua-approved-app` 重试放行 → close 生命周期 |
| `control-plane-integration.mjs`（12 项） | 跨源 POST 403、pause/resume、断连取消在途、审批 deny/allowOnce/allowAndWhitelist/fullAccess、孤儿审批吊销、一次性插话、clientGroup |
| `runtime-identity-integration.mjs` | daemon `runtime_info` 的 root/version/pipe/port/dataDir/nativeHost 完全一致 |
| `runtime-release-contract.mjs` | dev/release 隔离（管道/端口/数据目录不同）、四端版本一致、更新检查缓存与 dev 不联网 |
| `protocol-regression.mjs` | 原生 host 协议：环境变量优先级（`FASTCUA_HOME`/`CACHE_DIR`/`CODEX_HOME`）、请求/响应格式 |
| `fallback-regression.mjs` | `FASTCUA_TEST_FORCE_UIA_FALLBACK=1` 下 HWND 树回退仍可用 |
| `server-lifecycle.mjs` | mock daemon 管道驱动 `server.mjs`：MCP 工具 → sky → 管道 method 映射、JS REPL、close 行为 |
| `skill-writer-contract.mjs` | writer 配置归一化、key 隔离、公开视图、synthesize 环境覆盖、lint 门 |
| `installer-contract.mjs` | 对 install/manage/build-release/uninstall/config/web.html 中的契约字符串做静态断言 |
| `paint-drawing.mjs` | 启动 Paint、经管道协议绘制、输出审计 JPG |

配套：`tests/Fixture.cs` + `build-fixture.ps1`（C# Win32 测试夹具，含 EDIT/BUTTON/LISTBOX/trackbar/ES_PASSWORD 等控件）、`run-control-plane.ps1`（临时端口/管道/配置拉起 daemon 跑 control-plane-integration，结束自动 shutdown）。

## 9. CI/CD

- **`ci.yml`**（push main / PR，`windows-latest`）：rust-toolchain@stable + setup-node@v4（node 22）。静态检查：两个 crate `cargo fmt --check` + `cargo test --locked`，所有 `.mjs` `node --check`，所有 `.ps1` `[scriptblock]::Create` 语法检查，`card.xaml` XML 校验。测试：installer-contract、runtime-release-contract、runtime-identity-integration、server-lifecycle；然后编译夹具 + release 构建 + approval-lifecycle。尽力而为的真机回归（`continue-on-error`）：fallback-regression、protocol-regression。
- **`release.yml`**（tag `v*`，`permissions: contents: write`）：强制**四方版本一致**——tag 必须等于 `runtime-manifest.json`、`package.json`、`native-host/Cargo.toml`、`tools/skill-recorder/Cargo.toml`——跑静态检查 + `build-release.ps1 -Version <tag> -Commit <sha>`，发布 4 个资产（`fastcua-runtime-win-x64.zip`、`SHA256SUMS.txt`、`runtime-manifest.json`、`install.ps1`），配置了 `NPM_TOKEN` 时执行 `npm publish --access public`。

## 10. 边界与已知限制

- 仅 Windows 11 x64。安全桌面、UAC 提权、认证对话框、密码管理器、Windows 安全 UI 均不在常规路径内。
- 无障碍数据少的应用需要截图/网格定位；元素索引属于最新 UIA 快照，布局变化后必须刷新。
- host 内无 OCR——视觉定位按设计是基于网格的。
- 独立控制台窗口基于 Edge `--app`（WebView2 托管 DLL 离线拿不到），窗口尺寸不持久、多实例行为尚未管理（见 [`control-center-window.md`](control-center-window.md)）。
- npm CLI 尚未发布；README 里的 `npx fastcua` 命令需 `npm publish` 后才可用（发布工作流已就绪，配置 `NPM_TOKEN` 即触发）。
- Skill 录制器是已验证的预览版：目前所有端到端验证输入都是自动化注入的；还欠一次简短的人工输入对比会话。
- 挂起目标应用：UIA 按会话禁用、截图经 BitBlt 继续工作、跨进程窗口文本永不阻塞 host——完整重启 helper 是最后手段而非默认。
