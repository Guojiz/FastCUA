# FastCUA Windows 桌面操控原理

原生 host 到底是怎么驱动 Windows 的：UI Automation 导航、输入注入、窗口激活、截图捕获、视觉网格定位、DPI 坐标系、卡死防护，以及主循环里的安全门。以下所有事实均直接读自源码（`native-host/src/`），行号对应 `main.rs`、`desktop.rs`、`uia.rs`、`win32.rs`、`overlay.rs`（commit `d0613e9`）。

- [1. 操控链全景](#1-操控链全景)
- [2. UI Automation](#2-ui-automation)
- [3. 输入注入](#3-输入注入)
- [4. 窗口管理](#4-窗口管理)
- [5. 截图与视觉网格](#5-截图与视觉网格)
- [6. DPI 与坐标契约](#6-dpi-与坐标契约)
- [7. 主循环与安全门](#7-主循环与安全门)
- [8. 并发与资源模型](#8-并发与资源模型)
- [9. 值得了解的工程取舍](#9-值得了解的工程取舍)

## 1. 操控链全景

每个请求都走
`daemon（JSONL over stdio）→ main.rs → dispatch → desktop.rs/uia.rs → Win32 API`。
host 是单一共享进程（一个光标）。三个设计约束塑造了下面的一切：

1. **每个跨进程调用都有预算**。UIA 快照 1.5s、激活 1.5s、截图 3s、WM_GETTEXT 300ms、点命中 800ms——僵死的应用只能造成降级，永远不会挂住 host。
2. **坐标是目标窗口截图的物理像素**。启动即声明 DPI 感知，让 `GetWindowRect`、UIA 边界、`PrintWindow` 位图、点击坐标全部落在同一个坐标系。
3. **输入走真人同样的 API**（`SendInput`/`keybd_event`/`SetCursorPos`），绝不发合成窗口消息——对话框和 DirectUI 控件会忽略合成的 `BM_CLICK`，但接受真实输入。

## 2. UI Automation

### 2.1 手写 COM 绑定（不用 `windows` crate）

host 在 ABI 层面直接说 COM。`method<T>(object, index)`（`uia.rs:773-777`）从对象取 vtable 指针、按下标取槽位、`mem::transmute_copy` 还原目标签名。槽位为硬编码并经实测验证：

| 接口 | 槽位 | 方法 |
|---|---|---|
| IUnknown | 0 / 2 | QueryInterface / Release |
| IUIAutomation | 5 / 6 / 7 / 8 / 14 | GetRootElement / ElementFromHandle / ElementFromPoint / GetFocusedElement / ControlViewWalker |
| IUIAutomationElement | 16 / 21 / 23 / 29 / 36 / 43 | GetCurrentPattern / CurrentControlType / CurrentName / CurrentAutomationId / CurrentNativeWindowHandle / CurrentBoundingRectangle |
| IUIAutomationValuePattern | 3 / 4 / 5 | SetValue / get_CurrentValue / get_CurrentIsReadOnly |

对象经 `CoCreateInstance(CLSID_CUI_AUTOMATION ff48dba4-…, IID_IUI_AUTOMATION 30cbe57d-…)` 创建，`CoInitializeEx(COINIT_MULTITHREADED)` 初始化；BSTR 经 `SysAllocStringLen`/`SysFreeString` 进出边界，UTF-16 有损转 String。HRESULT 容错 `RPC_E_CHANGED_MODE`（线程已处于其他 COM 模式可继续），且仅当本次调用真正初始化了 COM 才 `CoUninitialize`（`uia.rs:185-189`）。

### 2.2 快照采集算法（`snapshot_inner`，`uia.rs:476-615`）

1. 跑在独立线程 `cua-uia-snapshot`；调用方 `recv_timeout(1500ms)` 等待。
2. 探活：创建 UIA 对象后先取一次 `GetRootElement`（随即释放——只为证明 provider 会应答）。
3. 取 **ControlViewWalker**（控件视图，不是原始树）。
4. 根节点：优先 `ElementFromHandle(hwnd)`——`ElementFromPoint(中心)` 可能命中重叠窗口或 Office 浮动任务窗格，把树打成碎片（`uia.rs:526-531`）。FromPoint 回退时沿父链最多上溯 20 层，直到元素的 `NativeWindowHandle` 等于目标 hwnd。
5. **手动递归**（`walk_element`，`uia.rs:617-696`）——不用 `FindAll`：`GetFirstChildElement` + `GetNextSiblingElement`，受 `depth > 12` 与 `visited >= 600` 双重上限约束。
6. 每节点取：Name(23)、AutomationId(29)、ControlType(21，失败默认 `UIA_CUSTOM`)、Bounds(43)。

**文本树编码**（`uia.rs:643-665`）——这段字符串就是 Agent 要解析的东西，格式即契约：

```
\t{index} {role} #{automationId} {name} [no-hit]? [Secondary Actions: Raise]?
```

- `{index}` 是 1 起始行号，供 `click({element_index})` 使用。
- AutomationId 是**重启稳定键**，录制器用它重解析锚点（名字变化只是外观性的）。
- `[no-hit]` 标记无边界矩形的元素（不可点击）。
- index 0 永远带 `" Secondary Actions: Raise"`（唯一支持的辅助动作，经 `perform_secondary_action` 暴露）。

树只有 ≤1 行则判定"空树"报错；快照还返回 `focused_element` 与 `document_text`（文本部件拼接）。

### 2.3 focused value 的读写

读（`uia.rs:305-427`）：当前窗口必须是前台（`ensure_target_foreground`）→ GetFocusedElement → GetCurrentPattern(10002, `UIA_VALUE_PATTERN_ID`) → QI 到 ValuePattern → `get_CurrentValue`。写（`set_focused_value_inner`，`uia.rs:429-474`）：先查 `get_CurrentIsReadOnly`，只读则拒绝（"focused value is read-only"），再以 `SysAllocStringLen` 构造 BSTR 调 `SetValue`。读写在**同步请求线程**执行（不挂 detached worker）——破坏性写绝不能滞留在被遗弃的 worker 上。

### 2.4 卡死防护（bad-app 机制）

- 超时 worker（`cua-uia-snapshot`、`cua-uia-point`、`cua-uia-focused-value`）用 mpsc + `recv_timeout`；超时后 worker 线程被 **detach**（它只碰自己的 COM/GDI 对象，不会毒化 host）。
- 超时即标记应用：`UIA_TIMEOUT_APPS: HashSet<String>` 按 `window.app` 存。该应用后续请求**快速失败**（"UI Automation disabled after provider timeout"）——本会话不再有阻塞等待。
- **短探针**：daemon 可经 meta `x-fastcua-uia-probe-ms`（默认 300ms）下发；`snapshot_with_timeout` 用它替换 1.5s 预算。健康的 provider 能在探针内应答从而被"康复"；僵死的快速失败并保持会话禁用。probe_ms 会回显进 `uia_meta.probe_ms`。
- `FASTCUA_TEST_FORCE_UIA_FALLBACK=1` 强制 HWND 回退供测试。

### 2.5 UIA 质量评估（`assess_uia_quality`，`desktop.rs:561-664`）

每个快照产出 `{quality, prefer_vision, confidence, reason}` 三元组，驱动 Agent 的"文本 vs 视觉"决策：

| 条件 | quality / prefer_vision | reason |
|---|---|---|
| provider 错误（超时/禁用） | broken / true | `timeout_or_provider_disabled` |
| 空树 | broken / true | `empty_tree` |
| 全部 role ∈ shell 集合 或 actionable < 3 | broken / true | `only_shell` |
| `[no-hit]` ≥ 50% | weak / true | `high_no_hit` |
| actionable < 5 | weak / true | `few_actionable` |
| 其余 | good / false | — |

`confidence` 从分级基数起步（error 0.05 … good 0.75），再叠加 `+0.2*actionable_ratio − 0.3*no_hit_ratio`，clamp 到 `[0, 0.98]`。

### 2.6 HWND 回退树

provider 无响应（`provider_unresponsive=true`）时改用 `EnumChildWindows` 建树（`desktop.rs:518-558`）：只收可见子窗口，类名→角色映射（`"edit"`→Edit、`"button"`→Button、`"msctls_trackbar32"`→Slider、…），无边界。窗口文本用 `SendMessageTimeoutW(WM_GETTEXTLENGTH/WM_GETTEXT, 300ms, SMTO_ABORTIFHUNG|SMTO_BLOCK)` 读；挂起应用短路到 `InternalGetWindowText`（直接读窗口结构里存的文本，无需消息泵）。置位 `uia.prefer_vision` 让 Agent 切到网格/截图。

## 3. 输入注入

### 3.1 点击时序（`click`，`desktop.rs:1784-1908`）

```
activate_window → 解析 (x,y) → 可选 snap → invalidate_capture_dedup
→ move_and_settle（SetCursorPos + Sleep 50ms）
→ ensure_cursor_position → ensure_foreground_window
→ 每次点击（1..3 次，clamp）：ensure_foreground_window → dispatch_click → Sleep 35ms
```

- **坐标解析**：显式 `x,y` 优先；否则 `element_index` 查元素缓存 bounds 中心，越出外层 HWND 时 clamp 进 `[left+1, right-2]`。
- **Snap**（`snap:true`，`click_cell` 用）：在点位做 `ElementFromPoint`（800ms 有界）；命中真实控件就点其**中心**；任何失败都退回原坐标。命中元素 bounds 与窗口矩形各边相差 ≤2px 视为"窗口背景本身"，忽略（防劫持）。
- **移动与点击分离**：移动用 `SetCursorPos`（绝对定位快）；点击本身用 `SendInput`（`INPUT` MOUSEEVENTF_LEFTDOWN/UP）——真实输入被接受之处，合成的 `BM_CLICK` 会被忽略。按下 → Sleep 20ms → 抬起；抬起最多 3 次重试（Sleep 5ms）。
- **前置校验**：`ensure_cursor_position` 复读 `GetCursorPos`，位置不符即中止（"cursor moved; action cancelled"）——人抢鼠标会取消动作而不是误点。`ensure_foreground_window` 在每次点击前复查前台 HWND。

### 3.2 键盘

- **文本**（`send_text`，`desktop.rs:1983-2037`）：每个 UTF-16 码元是一对 `SendInput` INPUT——`(wVk=0, wScan=码元, KEYEVENTF_UNICODE)` + `(KEYEVENTF_UNICODE|KEYEVENTF_KEYUP)`——每 256 个一批 flush，批间做 `ensure_foreground_window`。若 `SendInput` 返回奇数 `sent` 数（卡在按下态），补发一个 KEYUP，最多 3 次，防按键粘连。
- **和弦**（`press_key`，`desktop.rs:2039-2066`）：`"Control_L+a"` 按 `+` 拆分，每个 token 经 `key_to_vk` 映射（修饰键→`VK_CONTROL`/`VK_SHIFT`/`VK_MENU`；单字符走 `VkKeyScanW`；`F1`-`F20` 按前缀；`KP_*`/`NUMPAD_*` 小键盘常量）。按键**按顺序按下**（`keybd_event`，`MapVirtualKeyW` 转 scan code，每键 Sleep 8ms），再**逆序抬起**（每键 Sleep 4ms）。分工：和弦 VK 键用 keybd_event，Unicode 文本用 SendInput——各用最可靠的 API。
- **值写入**走 UIA `ValuePattern.SetValue`（见 2.3）而非按键——`type_text {replace:true}` 用的就是它（控件可写时）。

### 3.3 拖拽（`desktop.rs:2087-2127`）

`move_and_settle(from)` → `send_mouse(LEFTDOWN)` → **20 步线性插值**（`x = from_x + (to_x − from_x)*step/20`），每步先 `ensure_foreground_window` + `ensure_cursor_position(上一步)` 再 `set_cursor_position`，Sleep 8ms → 终点校验 → `send_mouse_release`。释放失败并入上报错误。

### 3.4 滚动（`desktop.rs:2068-2085`）

`move_and_settle` 到位后：垂直 → `MOUSEEVENTF_WHEEL` 传 `(−vertical)`（符号翻转：正 delta = 向上），水平 → `MOUSEEVENTF_HWHEEL`。`scroll_element` 与 `scroll` 同一函数，元素只用于推导坐标。

## 4. 窗口管理

### 4.1 枚举与过滤（`list_windows`，`desktop.rs:209-266`）

`EnumWindows` 回调过滤：跳过不可见窗口、`PID==0`、`PID==自身`、空标题、解析不出镜像路径的进程（`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `QueryFullProcessImageNameW`）。窗口 id = **hwnd 转 u64**——会话内稳定。`list_apps` 用 `BTreeMap` 按 app 分组。

### 4.2 激活（`activate_window_inner`，`desktop.rs:439-473`）

Windows 前台锁只允许拥有输入队列的线程成功调 `SetForegroundWindow`。算法绕开它：

```
GetForegroundWindow → 已是目标？直接成功（保留折叠选区）
IsHungAppWindow 检查
worker 线程 "cua-activate"，调用方 recv_timeout(1500ms)：
  ShowWindow(SW_RESTORE)
  前台线程 ≠ 当前线程：AttachThreadInput(current, fg, TRUE)  ← 合并输入队列
  BringWindowToTop → SetForegroundWindow → SetActiveWindow
  AttachThreadInput(FALSE)
重试循环 ×10：Sleep 10ms → GetForegroundWindow == hwnd？否则重发 Bring+Set
超预算 → Err
```

外层 1.5s 预算（worker + `recv_timeout`）保证激活不可能超出 daemon 的每请求预算。

### 4.3 启动校验（`validate_launch_app`，`desktop.rs:319-403`）

三种严格校验的合法形式：

1. `paint` / `mspaint` / `mspaint.exe` 别名 → 打包应用 `shell:AppsFolder\Microsoft.Paint_8wekyb3d8bbwe!App`（大小写不敏感）；缺 `mspaint.exe` 也回退打包应用。
2. `shell:AppsFolder\` 前缀 → AUMID 必须含 `!`（PackageFamily!AppId），每部分只允许 `[A-Za-z0-9._-]`。
3. 否则：**绝对路径 + `.exe` 扩展名（大小写不敏感）+ `is_file()`**，最后 `canonicalize()`。

启动用 `ShellExecuteW(null, "open", target, …)`，返回值 ≤32 判失败。

## 5. 截图与视觉网格

### 5.1 捕获管线（`capture_window_rgb_inner`，`desktop.rs:1137-1218`）

`cua-capture` worker 线程，调用方 `recv_timeout(3000ms)`：

```
GetWindowRect（≤ u16::MAX 合理性校验）→ GetWindowDC → CreateCompatibleDC/Bitmap
IsHungAppWindow 为真 或 PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT) 失败：
    BitBlt(SRCCOPY | CAPTUREBLT)          ← 挂起窗口也能截
GetDIBits → 32 位 BGRA（biHeight 为负 = 自顶向下）
BGRA → RGB 逐像素（[B,G,R] → [R,G,B]）
```

为什么 BitBlt 对挂起窗口有效：它直接读窗口当前表面，不经过目标进程的消息泵；`CAPTUREBLT` 连被其他/分层窗口遮挡的区域一起捕获。

### 5.2 下采样与去重

- 盒式平均缩放到 `max_edge`（默认 **1568**；`FASTCUA_MAX_EDGE` 或逐请求覆盖；≤0 禁用）：`scale = long_edge/max_edge`，每个输出像素是源区域均值——无插值伪影、开销低。
- `frame_hash`：FNV-1a 按 4096 字节块计算（offset 0xcbf29ce4…，prime 0x100000001b3）。2 秒 TTL 缓存，键 `"{id}:shot"`；命中返回 `unchanged:true` 仅元数据——不带图片。**任何输入动作都使缓存失效**（`invalidate_capture_dedup`），保证点击后的状态总是重新捕获。
- JPEG 质量：普通截图 82，**网格图 72**（更小，它们是定位辅助）。

### 5.3 方形网格打包（`pack_square_cells`，`desktop.rs:1270-1334`）

纯**方形**格子（Apple 风格，不用矩形）：

- refine=false：先试 3 行（`side = rh/3`，`cols = floor(rw/side)`）；`cols < 2` 改 2 行；`cols < 1` 退化为单个 1×1 格。网格以 `(gl, gt)` 偏移居中。
- refine=true：强制 3×3（`side = min(rw,rh)/3`，居中）。
- cell id 行优先从 1 递增——这就是 Agent 要"选择"的数字。

### 5.4 渲染是纯 CPU 像素操作（无 GDI/Direct2D）

网格直接画进 RGB 缓冲：半透明青色 `(80,220,255)` 边框 `alpha 0.38`，线宽 `(side/90).clamp(1,2)`；数字用手写 5×7 位图字体（`DIGIT_FONT`）画两遍——1px 黑色描边环（alpha ≈ 0.385）再白色填充（alpha 0.72），缩放 `(side*0.045).round().clamp(1,3)`，以格子点击点为中心。`refine` 只经 `capture_region_rgb` 重捕获目标区域（该区域 BitBlt，跳过整窗缓冲）。

### 5.5 网格响应契约

`{window, path, select_only, unchanged, phase, viewport, view, grid{…, cells[{id,row,col,left,top,right,bottom,cx,cy,width,height,square}]}, screenshots[1]}`——单张标注图（base64 JPEG），`grid.cells[].cx/cy` 是点击点，`select_only:true` 提醒 Agent 选数字不等于点击。

## 6. DPI 与坐标契约

启动即 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2 = -4)`（`main.rs:33-35`）。否则在 125%/150% 显示下 `GetWindowRect` 返回的是**虚拟化**矩形，与 PrintWindow 位图、UIA 边界对不上。V2 感知下，窗口矩形、截图像素、UIA 边界、注入坐标共享同一物理像素空间——这就是 README 敢承诺"click 的 x,y 就是窗口截图像素"的原因。Skill 录制器声明同样的感知，保证钩子点、`ElementFromPoint`、UIA 边界对齐（缩放显示上的物理像素锚定）。

## 7. 主循环与安全门

### 7.1 分发循环（`main.rs:43-115`）

`stdin.lock().lines()`——每行一个 JSON 请求；空行跳过；解析失败 `eprintln` + 继续；`method == "close"` 结束循环（并删除该会话的中断文件）。`dispatch` 匹配 method 白名单，其余 → `Err("unsupported method")`。

### 7.2 审批门

`request_app` 推导目标应用：`list_apps`/`list_windows`/`close` 免审批；`launch_app` 校验参数；带 `params.window` 的用窗口所属应用。门禁把 meta `x-fastcua-approved-app`（或旧 `x-oai-cua-approved-app`）与目标比对——不匹配返回 `{ok:false, approvalRequest:{app, displayName, riskLevel:"low"}}`。`risk_level` 目前恒为 `"low"`；是否弹审批由 daemon 决定（白名单/策略/缓存审批）。

### 7.3 中断门

`interrupt_path` 拼 `<home>/cache/computer-use/interrupts/<session>/<turn>`（home = `FASTCUA_HOME` → `FASTCUA_CACHE_DIR` → `CODEX_HOME`），两段都清洗到 `[A-Za-z0-9._-]`。文件存在即返回 `INTERRUPT_MESSAGE` 错误——就是 Agent 应当原样转述的那段话（"Computer Use was stopped by the user with the physical Escape key…"）。只有 `close` 清除标记。

### 7.4 父进程看门狗

`--parent-pid <pid>` → `OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION)` → 专用线程 `WaitForSingleObject(INFINITE)` → 信号到达即 `process::exit(0)`。原生 host 构造上就是 daemon 的子进程；daemon 一死，host 在一个等待周期内跟随退出。

### 7.5 光标光晕（`overlay.rs`）

独立线程 `cua-cursor-overlay` 创建跨虚拟屏的分层置顶可穿透窗口：`WS_EX_LAYERED|WS_EX_TRANSPARENT|WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE`，品红色键透明（`SetLayeredWindowAttributes(0x00ff00ff)`），`WM_NCHITTEST → HTTRANSPARENT` 点击穿透。`SetTimer(33ms)` ≈ 30fps 重绘：三层 GDI 圆——紫罗兰 (139,92,246) 2px 外圈，`pulse = 17 + phase/3` 呼吸半径（30 相三角波）；青色 (34,211,238) 3px 中圈半径 12；白色实心 4px 中心点。这就是"Agent 正在这里操作"的视觉信号。

## 8. 并发与资源模型

- **全局状态**：`UIA_TIMEOUT_APPS`、`UIA_ELEMENT_MAPS`、`LAST_CAPTURE_SCALE`、`CAPTURE_DEDUP`——全部 `OnceLock<Mutex<…>>`（惰性、串行化）。
- **线程**：`cua-uia-snapshot`、`cua-uia-point`、`cua-uia-focused-value`、`cua-capture`、`cua-activate`、`cua-cursor-overlay`，加父进程看门狗。所有超时 worker 都 detached，只碰自己的 COM/GDI 对象。
- **内存**：每个 COM 对象都释放（slot 2）；`FocusedValuePattern` 经 `Drop` 自动 release + `CoUninitialize`；BSTR 读完即 `SysFreeString`；位图管线完整清理（`DeleteObject/DeleteDC/ReleaseDC`）。`unsafe` 限定在 FFI 声明（win32.rs）、vtable 解引用 + transmute（uia.rs:773-777）、`from_raw_parts` 构造 BSTR/切片、Win32 回调四处。

## 9. 值得了解的工程取舍

1. **UIA 不用 crate**：手写 ABI 级 COM 让 host 零依赖（总共 4 个 crate）、发布自包含，代价是硬编码 vtable 槽位对 UIAutomationCore 版本敏感——所以 `tests/real-machine-validation.mjs` 里有大量实测验证。
2. **CPU 像素渲染而非 GDI/Direct2D**：管线本来就要 BGRA→RGB 和下采样，网格直接在 RGB 缓冲画；再加 GDI 表面会把捕获与 DC 耦合、搅乱 worker 线程所有权。网格分辨率下开销可忽略。
3. **三种输入 API 各司其职**：`SetCursorPos` 绝对快速移动、`SendInput` 点击与 Unicode 文本（真实输入胜过合成消息）、`keybd_event` 和弦 VK 键。各用在最可靠处，不求统一。
4. **detached 超时 worker**：host 绝不对 provider 无限等待；超时 worker 直接弃置。配合 bad-app 集合，"应用挂起"从阻塞器变成会话内降级。
5. **刻意无 OCR**：视觉定位基于网格；host 保持零依赖，真正的"读"交给 Agent 的视觉模型——token 花在视觉有信息量的地方（设计原则 1）。
