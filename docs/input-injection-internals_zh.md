# FastCUA 输入注入机制：原理、实现与正确性分析

## 摘要

在 Windows GUI 中执行可靠自动化，关键不只是“生成鼠标键盘事件”，而是让事件在正确的输入层级进入系统、被目标应用接受，并在用户、操作系统或其他自动化随时可能改变前台窗口与光标位置的共享桌面上避免误操作。Windows 至少提供三类输入生成途径：直接发送窗口消息、在 USER 输入流中注入虚拟输入、在内核驱动层模拟 HID。三者看似都能产生“点击”或“按键”，但进入输入管线的位置不同，接受性、权限边界、阻塞行为和可观测性也完全不同。

本文基于 FastCUA `native-host/src/desktop.rs` 与 `win32.rs`（commit `40f0f71`）逐行分析其输入注入系统。本文给出：Windows 输入管线背景；为何 `SendMessage(BM_CLICK)` 一类合成消息在 Common Item Dialog、DirectUI 和现代打包应用中失效；FastCUA 对 `SetCursorPos`、`SendInput`、`keybd_event`、UIA `ValuePattern.SetValue` 的职责划分；从模型所见截图像素到桌面屏幕坐标的形式化变换；点击、文本、和弦、拖拽、滚动的状态机与时序；前台窗口和光标所有权的不变量；部分插入后的释放补偿；现有真机证据；以及目前仍未解决的物理修饰键污染、扩展键、UIPI 归因与 down/up 竞态。

本文的核心结论是：FastCUA 的输入注入并非一个 API 调用，而是“输入层级选择 + 坐标变换 + 状态验证 + 平衡事件 + 故障恢复”的组合系统。现有实现已能在真实 Notepad、测试夹具与 Excel 工作流中验证，但和弦路径仍使用 Microsoft 已标记为 superseded 的 `keybd_event`，且缺少注入前的物理按键状态检查；这些应当作为下一阶段的明确改进对象。

## 1. 研究问题与威胁模型

### 1.1 研究问题

本文试图回答五个问题：

1. Agent 提供的是窗口截图坐标，Windows 注入 API 需要桌面屏幕坐标，两者如何无歧义地转换？
2. 为什么直接发送 `WM_LBUTTONDOWN`、`BM_CLICK` 等窗口消息不足以模拟真人输入？
3. 一次点击、拖拽或键盘和弦在操作系统层面具体由哪些 down/up 事件构成，顺序为何重要？
4. 当用户移动鼠标、切换窗口或按住修饰键时，如何避免 Agent 的输入落到错误对象？
5. 当 `SendInput` 只插入部分事件时，系统如何避免鼠标键或键盘键永久停留在按下态？

### 1.2 威胁模型

这里的“威胁”不只指恶意行为，也包括共享桌面上的正常竞争：

- 用户在 Agent 行动期间移动光标或切换前台窗口；
- 目标应用消息泵卡死，导致跨进程同步消息不返回；
- Windows 前台锁阻止窗口激活；
- 输入目标进程完整性级别高于 FastCUA，UIPI 拒绝注入；
- `SendInput` 只插入事件数组的一部分；
- 用户物理按住 Shift/Ctrl/Alt，污染 Agent 的文本或和弦；
- 多显示器和 125%/150% DPI 导致截图像素、窗口矩形与屏幕坐标不一致；
- 目标控件忽略合成窗口消息，只接受真正的输入流事件。

FastCUA 的目标不是锁死物理设备，而是采用“检测并中止”：在每个不可逆的输入转换前重新验证共享状态，一旦状态不满足就失败，而不是继续猜测。

## 2. Windows 输入管线

物理输入大致沿以下路径进入应用：

```
硬件中断
  → 键盘/鼠标类驱动（kbdclass / mouclass）
  → win32k 中的 Raw Input Thread（RIT）
  → 前台线程的输入队列
  → WM_MOUSEMOVE / WM_KEYDOWN / WM_CHAR 等消息
  → 应用 GetMessage / TranslateMessage / DispatchMessage / WndProc
```

Windows 提供三类注入位置：

| 注入层级 | API | 进入位置 | 主要性质 |
|---|---|---|---|
| 窗口消息层 | `SendMessage` / `PostMessage`，例如 `BM_CLICK`、`WM_LBUTTONDOWN`、`WM_SETTEXT` | 直接送目标窗口过程或消息队列，绕过 RIT | 不是真输入；许多现代控件忽略；`SendMessage` 会同步阻塞目标消息泵 |
| USER 虚拟输入层 | `SendInput`、旧式 `keybd_event`/`mouse_event` | 插入键盘或鼠标输入流，由输入系统串行分发 | 不是直送某个 WndProc；低级 hook 仍能识别 injected 标志；受 UIPI 限制 |
| 驱动/HID 层 | 虚拟 HID、过滤驱动 | 位于 USER 注入 API 以下 | 需要驱动或虚拟设备，部署、签名与安全成本完全不同 |

FastCUA 选择 USER 虚拟输入层。这是在“不安装内核驱动”前提下项目使用的最深层 USER 模式注入点。它让事件进入系统输入流，但不等于硬件事件：低级 hook 可以观察 injected 标志，应用也可以据此实施策略。

### 2.1 `SendInput` 的官方语义

Microsoft 文档明确说明：

- `SendInput` 把 `INPUT[]` 中的事件**串行插入**键盘或鼠标输入流；
- 同一次调用插入的事件不会被用户事件、`keybd_event`、`mouse_event` 或其他 `SendInput` 调用交错；
- 返回值是成功插入的事件数；少于请求数量即发生部分插入；
- 函数不会重置当前键盘状态，已有物理按键会干扰注入；
- 受 UIPI 限制，只能向完整性级别相等或更低的应用注入；
- UIPI 阻止时，返回值与 `GetLastError` **不会告诉调用方原因就是 UIPI**。

最后一点非常重要：FastCUA 可以识别“短插入”，但不能仅凭该错误准确宣称“UIPI 拒绝”。如果需要可解释诊断，必须另外查询目标进程 token 的完整性级别。

## 3. 为什么合成窗口消息不是输入注入

直觉上可以直接对按钮发送 `BM_CLICK`，或对窗口发送 `WM_LBUTTONDOWN/UP`。这在传统 Win32 控件中偶尔有效，但并不是通用输入模拟：

1. **缺少输入来源语义**。Common Item Dialog、DirectUI、自绘控件与部分打包应用响应的是输入系统产生的状态转换，而不是任意窗口消息。源码注释记录了实测结论（`desktop.rs:1891-1892`）：Common Item Dialog / DirectUI 经常忽略 `SendMessage(BM_CLICK)` 与合成 `WM_LBUTTON*`，但接受 `SendInput`。
2. **同步阻塞风险**。跨进程 `SendMessage` 要等目标 WndProc 返回；目标应用挂起时，调用方也被挂住。FastCUA 只在确有必要的文本读写场景使用 `SendMessageTimeoutW`：`WM_GETTEXT` 300ms、`WM_SETTEXT` 1000ms，并带 `SMTO_ABORTIFHUNG|SMTO_BLOCK`；绝不使用无界同步消息。
3. **权限过滤**。跨完整性级别窗口消息受 UIPI 过滤。
4. **窗口消息不建立全局输入状态**。直接投递一个 `WM_KEYDOWN` 并不等价于键盘状态表中某键真的处于按下态；依赖 `GetKeyState`、鼠标捕获、拖拽状态、焦点输入队列的应用可能得到不一致状态。

因此 FastCUA 的原则是：**消息用于有界读取和少数狭窄值写入；鼠标与键盘交互进入 Windows 输入流。** 这是一条架构规则，并不声称注入事件与硬件不可区分，也不声称每个应用都必然接受。

## 4. FastCUA 的注入架构

### 4.1 按职责选择 API

| 动作 | 当前 API | 选择原因与评价 |
|---|---|---|
| 绝对光标移动 | `SetCursorPos` | 接受桌面屏幕物理像素，避免相对移动加速与 0..65535 归一化误差；移动后再 `GetCursorPos` 验证 |
| 鼠标 down/up、滚轮 | `SendInput` | 插入系统输入流；可检查实际插入数量；单次数组提交具有不交错保证 |
| Unicode 文本 | `SendInput(KEYEVENTF_UNICODE)` | 绕过键盘布局，以 `VK_PACKET`→`WM_CHAR` 路径传递 UTF-16 码元 |
| 键盘和弦 | `keybd_event`（当前实现） | 明确逐键 down/up；但已被 Microsoft 标记为 superseded，应迁移到单批 `SendInput` |
| 聚焦文本的整值替换 | UIA `ValuePattern.SetValue` | 不模拟 Ctrl+A，避免误选整个文档/网格；仅聚焦控件暴露可写 ValuePattern 时允许；当前同步调用无本地超时 |
| HWND Edit 值写入 | 有界 `WM_SETTEXT` | 仅限 class=`edit`，超时 1000ms，属狭窄兼容路径 |

这里必须区分“实现事实”和“推荐设计”：`SendInput` 路径可检查插入数，现有 `keybd_event` 和弦路径不可检查；同步 UIA 替换避免了“调用方超时后 detached worker 迟到写入”，但保留 provider 卡死的活性风险。后文给出迁移方案。

### 4.2 `INPUT` 的 ABI

项目不依赖 `windows`/`winapi` crate，而是在 `win32.rs:177-210` 以 `#[repr(C)]` 手写 ABI：

```rust
#[repr(C)]
pub struct MOUSEINPUT {
    dx: LONG,
    dy: LONG,
    mouseData: DWORD,
    dwFlags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
}

#[repr(C)]
pub struct KEYBDINPUT {
    wVk: WORD,
    wScan: WORD,
    dwFlags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
}

#[repr(C)]
pub union INPUT_0 { mi: MOUSEINPUT, ki: KEYBDINPUT }
#[repr(C)]
pub struct INPUT { r#type: DWORD, Anonymous: INPUT_0 }
```

`#[repr(C)]` 保证字段布局与 User32 API 一致。`SendInput(count, ptr, size_of::<INPUT>())` 会验证第三个参数必须等于系统预期的 `INPUT` 大小；返回插入事件数。

FastCUA 使用：

- `INPUT_MOUSE = 0`；
- `INPUT_KEYBOARD = 1`；
- `KEYEVENTF_KEYUP = 0x0002`；
- `KEYEVENTF_UNICODE = 0x0004`；
- 鼠标 `LEFTDOWN/UP=0x2/0x4`、`RIGHTDOWN/UP=0x8/0x10`、`MIDDLEDOWN/UP=0x20/0x40`、`WHEEL=0x0800`、`HWHEEL=0x1000`。

`time=0` 让系统生成时间戳，`dwExtraInfo=0` 不设置自定义来源 cookie。单一 injector 场景下这是简化，但意味着未来低级 hook 诊断无法用应用自定义标记识别“本进程自己的事件”，只能依赖 Windows 的 injected flags。

## 5. 坐标模型：从截图到屏幕

Agent 看到的是**窗口截图像素**，`SetCursorPos` 需要**桌面屏幕坐标**。中间必须逆转截图下采样并叠加窗口位置。

设物理窗口外框：

\[
R=(L,T,W,H)
\]

其中 `(L,T)` 为窗口左上角桌面坐标，`W,H` 为物理像素宽高；最新截图相对完整窗口的缩放因子为 `s≥1`；Agent 给定点为 `p=(x,y)`。

### 5.1 三种输入坐标模式

**归一化模式**：仅当 x、y **同时**位于 `[0,1]` 时启用：

\[
P_w = (round(x(W-1)), round(y(H-1)))
\]

这样 0 精确对应首像素，1 精确对应末像素。

**截图像素模式**（默认数值模式）：若截图被缩小：

\[
P_w = (round(sx), round(sy))
\]

未缩小则 `s=1`。

**完整窗口像素模式**：调用方显式传 `space:"window_pixels"`，直接：

\[
P_w = (round(x), round(y))
\]

`click_cell` / `click_view` 已完成视图到窗口的变换，故使用此模式绕过二次缩放。

之后先验证：

\[
0 \leq P_w.x < W, \quad 0 \leq P_w.y < H
\]

越界立即拒绝。最后转桌面坐标：

\[
P_s = (L + P_w.x, T + P_w.y)
\]

代码位于 `screen_point_from_params` 与 `screen_point`（`desktop.rs:2254-2335`）。真机测试用两个相差 10px 的截图点验证下采样逆映射，允许误差 ≤2px（`tests/real-machine-validation.mjs:619-653`）。

### 5.2 为什么移动不用 `SendInput(MOUSEEVENTF_ABSOLUTE)`

`MOUSEEVENTF_ABSOLUTE` 的 dx/dy 不是物理像素，而是 0..65535 的归一化值；多显示器还必须配合 `MOUSEEVENTF_VIRTUALDESK`，否则只映射主显示器。相对移动又会受系统鼠标速度和两个加速度阈值影响，位移可能被放大至 4 倍。FastCUA 已有物理屏幕坐标，因此直接 `SetCursorPos(P_s)` 更简单、更精确，之后再用 `GetCursorPos` 检查是否真的到位。

## 6. 动作状态机与正确性不变量

设：

- `F(t)`：时刻 t 的前台 HWND；
- `C(t)`：实际光标桌面坐标；
- `T`：目标窗口 HWND；
- `P`：预期桌面点；
- `D_k/U_k`：键或按钮 k 的 down/up 转换。

FastCUA 试图维持以下不变量：

- **I1 前台所有权**：在输入生效点，`F(t_effect)=T`。
- **I2 光标所有权**：在鼠标输入生效点，`C(t_effect)=P`。
- **I3 平衡转换（安全目标）**：每个注入的 `D_k` 最终必须对应 `U_k`；若部分失败，必须尝试释放补偿并把整个动作判失败。当前文本与鼠标路径有补偿，旧式和弦路径尚未建立此性质。
- **I4 有界交互（部分成立）**：窗口消息、激活、快照、点命中与截图都有显式预算；同步 UIA `ValuePattern.SetValue` 为避免 detached worker 迟到执行破坏性写而留在请求线程，但没有本地超时，因此“所有等待均有界”尚未被证明。
- **I5 坐标包含性**：窗口相对点在转换前必须属于 `[0,W)×[0,H)`。
- **I6 失败不继续**：任何所有权、插入数量、范围或焦点验证失败，当前高层动作立即终止，不尝试“尽量完成”。

这些不变量是**检测并中止**，不是设备互斥锁。FastCUA 不阻止用户动鼠标，而是在不可逆转换之前重新观察共享状态。

## 7. 鼠标点击

### 7.1 完整时序

`click`（`desktop.rs:1784-1908`）执行：

```
1. params_window                  解析目标窗口
2. activate_window(T)            激活并验证前台窗口
3. resolve point                 显式坐标或 UIA element_index
4. optional UIA snap             point-hit 后改点控件中心
5. invalidate_capture_dedup(T)   输入后截图必须重新捕获
6. SetCursorPos(P)
7. Sleep(50ms)                   等待窗口管理器/输入栈稳定
8. GetCursorPos == P ?           否则“cursor moved; action cancelled”
9. GetForegroundWindow == T ?    否则取消
10. SendInput(ButtonDown)
11. Sleep(20ms)
12. SendInput(ButtonUp)，失败最多重试 3 次，每次 5ms
13. GetCursorPos == P ?           确认 down/up 期间未被移动
14. 多击：Sleep(35ms)，回到第 9 步；count 限制 1..3
```

### 7.2 UIA element_index 与 snap

若没有显式 x/y，`element_index` 从最近 UIA 快照缓存中取元素边界中心。边界轻微超出外层 HWND（DirectUI/Nav Pane 常见）时 clamp 到 `[left+1,right−2]×[top+1,bottom−2]`。

`snap:true` 用于视觉网格点击：先在候选点调用 `ElementFromPoint`（800ms 有界），若命中有合法矩形的控件，就把点击点改为控件中心；若命中元素边界与整个窗口外框各边相差 ≤2px，则认为只命中窗口背景，不吸附。UIA 超时、禁用、无命中均保留原点。

### 7.3 down/up 为什么分开提交

当前实现分别调用两次 `SendInput`，中间停 20ms。这能让控件观察到真实的按住时长，也便于 release 重试；但它不是原子事务：用户或其他输入可能在 down/up 之间介入。`SendInput` 只保证**同一次调用**中的数组事件不与其他输入交错，而当前 down 与 up 属于两次调用。因此：

- 当前设计优点：清晰的 dwell、up 可单独重试；
- 当前设计缺点：存在 down/up 竞态窗口。

这不是靠文字能消除的限制。若未来要更强原子性，可以把 down/up 放入一次 `INPUT[2]` 调用，但那会失去 20ms dwell；可选方案是保留分离提交，同时通过低级 hook/cookie 做冲突检测，或按控件类别配置是否需要 dwell。

### 7.4 部分插入与释放补偿

`send_inputs` 要求返回值等于请求长度；否则立即报：

```
SendInput inserted {sent}/{requested} events (GetLastError=...)
```

鼠标 up 使用 `send_mouse_release`，最多三次，每次间隔 5ms。原因是“click 失败”比“左键永久处于按下态”危害小得多：后者会把之后所有移动变成拖拽。释放补偿体现 I3。

## 8. Unicode 文本输入

### 8.1 `KEYEVENTF_UNICODE` 路径

`send_text`（`desktop.rs:1983-2037`）遍历 `text.encode_utf16()`。对每个 UTF-16 码元 `u` 构造：

```text
INPUT_KEYBOARD { wVk=0, wScan=u, dwFlags=KEYEVENTF_UNICODE }
INPUT_KEYBOARD { wVk=0, wScan=u, dwFlags=KEYEVENTF_UNICODE|KEYEVENTF_KEYUP }
```

官方语义是：系统产生 `VK_PACKET` 的 `WM_KEYDOWN/UP`；前台线程经 `TranslateMessage` 后产生带原 Unicode 字符的 `WM_CHAR`。这条路径绕过当前键盘布局：中文、日文或符号不需要先找到某个物理 VK 组合。

### 8.2 批处理与前台复检

事件向量容量 256；每满 256 个 `INPUT`（即最多 128 个 UTF-16 码元）就：

1. `ensure_foreground_window(T)`；
2. 一次 `SendInput` 批量提交；
3. 清空向量继续。

这样长文本不会无限分配内存，也不会在焦点丢失后继续把剩余文本送进错误窗口。需要注意：同一次 `SendInput` 调用内事件不会被交错，但不同批次之间仍可能有用户输入；批间前台检查只能发现窗口切换，不能发现用户在同一控件中移动了插入点。

### 8.3 防键盘粘连

每个 UTF-16 码元是 down/up 一对。当前恢复算法把成功插入集合视为该交替数组的前缀；在此前提下，若 `SendInput` 返回奇数 `sent`，成功前缀最后一个事件就是 down。`send_text_inputs` 读取该事件的 `wScan`，构造补偿 KEYUP，最多重试 3 次。若补偿也失败，错误中附：

```
key release cleanup failed (GetLastError=...)
```

这是一个严格利用事件对奇偶性的恢复算法：

\[
sent \bmod 2 = 1 \Rightarrow \exists \text{ unmatched down at } sent-1
\]

若短插入确实是成功前缀，则偶数 `sent` 结束于完整 pair，不存在未释放码元。需要明确的是：Microsoft 文档说明返回成功插入数量，并保证已插入事件的串行顺序，但 API 页面没有显式写出“短插入一定是数组前缀”。因此这段奇偶证明带有一个操作系统行为前提；应通过故障注入 shim 或低级 hook 轨迹补充实证。

### 8.4 `replace:true` 为什么不用 Ctrl+A

默认 `replace:false` 只在当前 caret 插入文本。`replace:true` 只有在：目标窗口前台、应用 UIA 未因超时禁用、聚焦元素暴露可写 ValuePattern 时才执行 `SetValue`。这避免盲目 Ctrl+A 把整个文档、表格、画布或应用选中。此写入在同步请求线程执行，不能放在超时后仍可能继续执行的 detached worker 上——破坏性写不能“迟到”。

### 8.5 补充平面字符

Rust `encode_utf16` 会把 U+10000 以上字符编码为一对 surrogate，每个 surrogate 各自作为一对 `VK_PACKET` down/up 发送。`KEYBDINPUT` 文档把 `wScan` 定义为 Unicode 字符，并另行提醒 hook 监听器处理触摸键盘产生的 surrogate 宏；但这不足以证明 FastCUA 当前序列在所有框架中都会被完全相同地重组。当前测试矩阵尚未覆盖 emoji 等补充平面字符在 Win32 Edit、WPF、Office 与浏览器控件中的一致性，因此必须把它列为测试义务，而不是已证明结论。

## 9. 键盘和弦

### 9.1 当前算法

`press_key`（`desktop.rs:2039-2066`）把 `"Control_L+Shift_L+period"` 按 `+` 拆为 VK 列表：

```text
for key in keys:          keybd_event(key, scan, DOWN); Sleep(8ms)
for key in reverse(keys): keybd_event(key, scan, UP);   Sleep(4ms)
```

以 Ctrl+A 为例：

```text
Ctrl↓ → A↓ → A↑ → Ctrl↑
```

逆序释放是和弦成立的必要条件：必须先释放基础键，再释放修饰键。

### 9.2 键名映射

`key_to_vk` 支持：

- `Ctrl/Control/Control_L/Control_R` → `VK_CONTROL`；
- `Shift_L/R` → `VK_SHIFT`；
- `Alt/Menu` → `VK_MENU`；
- Enter/Escape/Tab/Delete/Home/End/PageUp/PageDown/箭头；
- `F1..F20`；
- `KP_0..9` / `NUMPAD_0..9` 与算术键；
- 单字符走 `VkKeyScanW` 低字节。

### 9.3 当前实现的技术债

1. Microsoft 已明确把 `keybd_event` 标为 superseded，推荐 `SendInput`。
2. `keybd_event` 无返回值，无法知道某个 down/up 是否真正插入。
3. 左右修饰键别名都映射为通用 VK，`Control_L` 与 `Control_R` 实际不保真。
4. 没有为 E0 扩展键设置 `KEYEVENTF_EXTENDEDKEY`。
5. 逐键单独调用没有“整段和弦不与其他输入交错”的保证；官方串行不交错保证只覆盖单次 `SendInput(INPUT[])`。
6. 失败路径没有像 Unicode 文本那样的平衡释放补偿。

因此论文不能把当前实现描述为所有键盘的最佳方案。建议迁移为单批：

```text
INPUT[] = [K1↓, K2↓, ..., Kn↓, Kn↑, ..., K2↑, K1↑]
SendInput(INPUT[])
```

并检查插入数量；若部分插入，根据成功前缀计算仍处于 down 的键并发送补偿 up。

## 10. 拖拽与滚动

### 10.1 拖拽

拖拽状态机：

```text
move_and_settle(from)
LEFTDOWN
for i=1..20:
  verify foreground
  verify cursor == previous
  SetCursorPos(lerp(from,to,i/20))
  Sleep(8ms)
verify foreground and end point
LEFTUP with retry
```

20 步线性插值总移动阶段约 160ms。直接从起点瞬移终点通常不会给控件足够的 `WM_MOUSEMOVE` 样本来建立拖拽；多步移动则模拟持续轨迹。每一步先验证上一步位置，用户中途抢鼠标会让动作失败，而不是与用户争夺光标。

若路径中途失败，代码仍执行 `send_mouse_release(LEFTUP)`；若释放也失败，两个错误合并。这保证逻辑上优先恢复按钮状态。

### 10.2 滚轮

滚动先 `move_and_settle` 到目标点。这个定位对按指针位置选择滚动目标的应用仍有价值，也决定 `WM_MOUSEWHEEL` 携带的屏幕坐标；但 Win32 文档规定该消息发送给**焦点窗口**，再由 `DefWindowProc` 沿父链传播，因此不能笼统声称“滚轮一定投递给光标下窗口”。随后：

- `scrollY != 0` → `MOUSEEVENTF_WHEEL`, `mouseData=(-scrollY) as u32`；
- `scrollX != 0` → `MOUSEEVENTF_HWHEEL`, `mouseData=scrollX as u32`。

API 层约定：`scrollY` 负数=向上、正数=向下；Windows `MOUSEINPUT` 约定正 wheel delta=向前/向上，因此垂直值取反。标准滚轮一格为 `WHEEL_DELTA=120`；FastCUA 不做 120 量化，直接传调用方 delta，使应用自行累积高分辨率滚动。

## 11. 竞争检测与时序

### 11.1 `move_and_settle`

```text
SetCursorPos(P)
Sleep(MOVE_SETTLE_MS=50)
GetCursorPos == P ?
GetForegroundWindow == T ?
```

50ms 不是输入 API 的硬要求，而是经验性稳定时间，让窗口管理器、桌面合成和输入栈消化位置变化后再验证。检查太早可能观察瞬态；检查太晚则扩大用户竞争窗口。

### 11.2 检查放置位置

- 每次 multi-click 前复查前台窗口；
- click 的 down/up 前后复查光标位置；
- 每个文本批次前复查前台窗口；
- drag 的每一步复查前台和上一光标位置；
- scroll 发送前复查光标。

因此系统不长期假定仍拥有前台和光标，而是在关键转换附近反复采样验证。但每次验证只证明读取瞬间的状态，不能消除验证与下一次 API 调用之间的 TOCTOU 窗口；这是检测并中止式的乐观并发控制，不是排他锁。

### 11.3 仍存在的竞态窗口

以下竞态无法被现有检查完全关闭：

- 最后一次 `GetCursorPos` 与 `SendInput(DOWN)` 之间用户移动；
- 鼠标 DOWN 与 20ms 后 UP 之间用户输入；
- 一个 256 事件文本批次内部用户改变 caret，但窗口仍是同一个；
- `activate_window` 成功后、下一检查前目标窗口被销毁并复用 HWND（概率低但 HWND 不是永久身份）。

论文级结论应是“显著缩小并检测大多数竞争窗口”，而不是“实现了物理输入互斥”。

## 12. 权限边界

### 12.1 UIPI

`SendInput` 只能向完整性级别相等或更低的应用注入。普通权限 FastCUA 无法操控管理员窗口、UAC 安全桌面等。更关键的是：UIPI 阻止时，`SendInput` 返回/`GetLastError` 不揭示原因。因此当前 `SendInput inserted 0/N` 只能是一般注入失败，不能准确诊断为 UIPI。

建议在错误发生后只做辅助诊断：通过 `OpenProcessToken` + `GetTokenInformation(TokenIntegrityLevel)` 比较源/目标完整性，输出“likely UIPI”，同时注明不是 API 直接证明。

### 12.2 injected flag

USER 层注入会被低级 hook 标记为 injected（`LLKHF_INJECTED` / `LLMHF_INJECTED`）。反作弊、某些沙箱或安全应用可识别并拒绝。绕过需要驱动或虚拟 HID，不符合 FastCUA 当前“本地优先、无驱动、自包含”的边界。

### 12.3 安全桌面与输入桌面

`SetCursorPos` 要求调用进程对 window station 有 `WINSTA_WRITEATTRIBUTES`，且当前 desktop 必须是 input desktop。UAC 安全桌面并非普通 default desktop，因此项目明确不支持该路径。Skill 录制器也用 `OpenInputDesktop` 检测非 default 桌面并静默抑制捕获。

## 13. 证据：目前证明了什么

`tests/real-machine-validation.mjs` 的真机证据包括：

- 点击 Notepad 编辑区并输入文本，再经 UIA 读回（342-370）；
- 点击并替换测试夹具 Edit（389-399）；
- `click_view` 两个图像点相差 10px，夹具记录位移误差 ≤2px（554-579）；
- `click_in_cell` 格内局部坐标转换正确，越出格子拒绝（581-615）；
- 下采样截图的 scale 逆映射正确（619-653）；
- 输入后截图去重缓存失效，下一帧是新图（655-681）；
- UIA snap 把背景候选点吸附到按钮中心，误差 ±4px（687-704）。

`office-demo-e2e.mjs` 又提供应用级证据：真实 Excel 完成 23 步回放，另存路径与参数值被实际写入，最后用 openpyxl 校验工作簿单元格。

## 14. 尚未证明什么

现有测试尚未系统覆盖：

- 用户物理按住 Shift/Ctrl/Alt 时的注入污染；
- 左右修饰键身份；
- E0 扩展键；
- 和弦部分插入与释放补偿；
- UIPI 失败分类；
- surrogate pair 在 Win32 Edit/WPF/Office/浏览器控件的一致性；
- 鼠标交换键（`SM_SWAPBUTTON`）；
- `ClipCursor` 约束下的到位校验；
- 用户恰在 down/up 之间插入动作；
- 并发多个 Agent 对单一光标的串行性；
- 滚轮 delta 不为 120 倍数时各应用的行为。

这些是明确的测试需求，不能由现有成功案例推导为已正确。

## 15. 技术债与改进路线

### 15.1 物理按键状态污染

Microsoft 文档明确：`SendInput` 不重置当前键盘状态。若用户正按住 Shift，Agent 注入 `a` 可能变成 `A`；用户按住 Ctrl 时文字可能触发快捷键。当前代码没有在文本/和弦前调用 `GetAsyncKeyState` 或 `GetKeyboardState`。

推荐策略不是释放用户物理键（那会篡改用户状态），而是检查 Shift/Ctrl/Alt/Win 与鼠标按钮的最高位；任何非中立状态立即中止并提示“等待用户释放输入”。

### 15.2 和弦统一迁移到 `SendInput`

建立显式按键元数据表：

```text
{name, vk, scan, extended, side}
```

生成平衡数组，一次提交，检查返回值，按成功前缀计算未释放键。这样才能把 I3 从“文本路径成立”推广到“所有键盘路径成立”。

### 15.3 事件来源 cookie

在 `dwExtraInfo` 写固定随机进程 cookie，低级 hook/诊断工具可通过 `GetMessageExtraInfo` 区分本进程注入与其他 injector。它不会隐藏 Windows injected flag，也不应用于绕过安全检测，只用于可观测性与冲突分析。

### 15.4 参数化时序

当前常量：

| 参数 | 数值 | 作用 |
|---|---:|---|
| MOVE_SETTLE_MS | 50ms | 移动后等待稳定 |
| 点击 down/up dwell | 20ms | 让控件观察独立按下状态 |
| multi-click 间隔 | 35ms | 多击分隔 |
| chord down 间隔 | 8ms | 按键转换分隔 |
| chord up 间隔 | 4ms | 释放分隔 |
| drag step | 20 步 × 8ms | 轨迹采样 |

这些来自经验而非形式模型。可把它们集中配置，并按 Win32、WPF、UWP/DirectUI、Office、浏览器类控件做兼容矩阵测量。

### 15.5 同步 UIA 写的活性隔离

`replace:true` 在请求线程同步调用 `ValuePattern.SetValue`。这能防止 detached 超时 worker 在调用方已经放弃后仍迟到执行破坏性写，是正确的所有权选择；但 provider 若卡死，本次请求仍可能阻塞，直到 daemon 外层请求/进程隔离介入。更强方案不是简单把它放回 detached thread，而是把破坏性 provider 调用放入可终止、可丢弃的独立 helper 进程，使“超时后绝不再写”与“等待有界”同时成立。

### 15.6 故障注入测试

需要可控 seam 模拟 `SendInput` 返回 0、奇数、部分偶数，并验证短插入是否遵循成功前缀模型；夹具或低级 hook 记录每个 down/up 顺序与最终键状态。测试应证明：

\[
\forall k,\; count(D_k)-count(U_k)=0
\]

或在无法恢复时 daemon 明确停止后续输入，要求人工接管，而不是继续在污染状态下运行。

## 16. 结论

FastCUA 的输入注入是一个组合控制系统：

1. **输入层级选择**解决目标是否接受事件；
2. **坐标变换**把模型所见截图空间映射到物理桌面；
3. **状态机和不变量**约束每个动作的顺序；
4. **前台/光标复检**将共享桌面的竞争转化为可检测失败；
5. **平衡事件和释放补偿**限制部分插入后的状态污染；
6. **有界消息与超时 worker**防止挂起应用拖死 host。

这套设计已跨 Notepad、Win32 测试夹具和真实 Excel 工作流得到验证，尤其在截图坐标映射、视觉网格点击、UIA snap、Unicode 文本与输入后重新捕获方面有真机证据。但论文级评估也必须承认：这些证据不能推出硬件等价、排他光标所有权或所有应用兼容；当前和弦仍依赖 superseded 的 `keybd_event`，未检查物理修饰键状态，扩展键/左右键/UIPI 归因、短插入前缀前提与同步 UIA 写的活性边界仍未完备。下一阶段应优先把键盘路径统一为可检查、可补偿的一次性 `SendInput(INPUT[])` 事务，并补上输入状态、完整性级别诊断与故障注入证据。

## 参考资料

1. Microsoft Learn, **SendInput function (winuser.h)**：事件串行插入、返回值、UIPI、当前键盘状态不重置。
2. Microsoft Learn, **KEYBDINPUT structure**：`wVk`/`wScan`、`KEYEVENTF_UNICODE`、`VK_PACKET`→`WM_CHAR`、scan code 与 extended key。
3. Microsoft Learn, **MOUSEINPUT structure**：滚轮 delta、绝对坐标 0..65535、`VIRTUALDESK`、相对移动加速。
4. Microsoft Learn, **keybd_event function**：已由 `SendInput` 取代、VK/scan/KEYUP 语义。
5. Microsoft Learn, **SetCursorPos function**：屏幕坐标、共享光标、WINSTA/input desktop 条件。
6. Microsoft Learn, **GetAsyncKeyState function**：按键当前状态、UIPI/desktop 限制。
7. Microsoft Learn, **AttachThreadInput function**：输入队列共享、键盘状态重置与调用约束。
8. FastCUA `native-host/src/desktop.rs`：点击 1784-1908、文本 1910-2037、和弦 2039-2066、滚动 2068-2085、拖拽 2087-2127、坐标 2254-2335、鼠标 2337-2368、键映射 2370-2426。
9. FastCUA `native-host/src/win32.rs`：输入常量 80-91、`INPUT` ABI 177-210、FFI 296-297。
