# 逆向工程分析记录

## 1. 结论

目标二进制是一个 x64 Rust release 程序，大小 1,691,648 字节，PE image base 为 `0x140000000`。它内部创建两个独立的顶层窗口：

| 职责 | Window title | 初始创建调用 |
|---|---|---|
| Cursor Overlay（保留） | `Codex Computer Use Cursor Overlay` | `0x140081234` |
| Display Overlay（隐藏） | `Codex Computer Use Display Overlay`，运行时辅助功能标题为 `Codex is using your computer. Esc to cancel` | `0x1400812BD` |

二者共用窗口类 `CodexComputerUseCursorOverlay`，因此不能按 class name 粗暴禁用。正确的区分依据是创建顺序、参数和后续 `ShowWindow` 调用。

最终补丁仅把显示 Display Overlay 的一条间接调用从 `FF D3`（`call rbx`，其中 `rbx = user32!ShowWindow`）改为 `90 90`。Cursor Overlay 的下一条 `ShowWindow` 调用保持不变。

## 2. 二进制指纹

| 项目 | 原始版 | 补丁版 |
|---|---|---|
| 文件 | `cua-native-host.exe` | `cua-native-host-no-display.exe` |
| 大小 | 1,691,648 | 1,691,648 |
| SHA-256 | `f2b2f56fcd1699b0fa32dec3214a56a1d36b937a2ecf58cc822ab4a904551e03` | `05a3c313a56679fcff79028856d7f20afc8256687d84bcf7aa45ed1a370e2bfd` |
| Authenticode | NotSigned | NotSigned |

逐字节比较只有两处差异：

```text
file+0x8AC1B: FF -> 90
file+0x8AC1C: D3 -> 90
```

## 3. Overlay 函数图

| 地址 | 作用 |
|---|---|
| `0x1400810B4` | overlay 初始化状态机；同时初始化 cursor/display 两套对象 |
| `0x14009479E` | `CreateWindowExW` 包装函数 |
| `0x140081234` | 创建 Cursor Overlay HWND；标题 UTF-16 VA `0x1401398B6` |
| `0x1400812BD` | 创建 Display Overlay HWND；标题 UTF-16 VA `0x140139910` |
| `0x14008B7FF` | 显示两个 overlay 窗口 |
| `0x14008B81B` | `ShowWindow(display, SW_SHOWNOACTIVATE)`；本次补丁点 |
| `0x14008B825` | `ShowWindow(cursor, SW_SHOWNOACTIVATE)`；保持原样 |
| `0x14008B781` | 依次 raise display/cursor；使用 `SetWindowPos` flags `0x213`，不包含 `SWP_SHOWWINDOW` |
| `0x140086666` | shutdown/hide 路径，对两个 HWND 调用 `ShowWindow(..., SW_HIDE)` |

`0x14008B7FF` 的关键逻辑可还原为：

```c
void show_overlay_windows(HWND cursor, HWND display) {
    ShowWindow(display, SW_SHOWNOACTIVATE); // NOP in patched build
    ShowWindow(cursor, SW_SHOWNOACTIVATE);  // retained
    raise_overlay_windows(cursor, display);
}
```

`raise_overlay_windows` 的 `SetWindowPos` 没有 show flag，所以 Display HWND 在跳过第一次 `ShowWindow` 后会一直保持 hidden；resize、capture exclusion、composition 对象和 shutdown 状态机仍然完整，避免破坏 Cursor Overlay 或其他 host 功能。

## 4. 为什么不直接跳过 Display HWND 创建

初始化函数在创建两个 HWND 后继续建立 Windows.UI.Composition desktop target、透明度动画、capture exclusion 和 resize/shutdown 状态。直接让第二次 `CreateWindowExW` 失败会把整个初始化结果置为错误，可能连带禁用 Cursor Overlay 或使输入请求失败。

当前补丁保留内部对象，仅移除可见 UI。它实现的是“Display Overlay 不出现”，不是从文件中删除全部 display overlay 机器码。

## 5. 协议还原

host 与 daemon 之间是 stdin/stdout 上的 newline-delimited JSON：

```json
{"id":1,"method":"list_windows","params":{},"meta":{"session_id":"...","turn_id":"1"}}
```

成功响应：

```json
{"id":1,"ok":true,"result":{}}
```

审批握手：

```json
{"id":1,"ok":false,"approvalRequest":{"app":"...","displayName":"...","riskLevel":"low"}}
```

daemon 用同一请求重试，并在 `meta` 中加入 `x-oai-cua-approved-app`。请求预算键为 `x-oai-cua-request-budget-ms`。

确认的方法包括：`list_apps`、`list_windows`、`get_window`、`launch_app`、`get_window_state`、`click`、`press_key`、`type_text`、`scroll`、`set_value`、`drag`、`perform_secondary_action`、`activate_window`。

`get_window_state` 返回：

- `window`: `{app,id,title}`
- `accessibility`: `tree`、`document_text`、`focused_element` 等可用字段
- `screenshots[]`: JPEG data URL、`id`、尺寸、屏幕原点、zIndex
- `cacheDiagnostics`: accessibility/capture cache 计数

`--parent-pid`、`CODEX_HOME` 和 `<CODEX_HOME>/cache/computer-use/interrupts/<session>/<turn>` 中断文件均已在回归测试中使用。

`\\.\pipe\fastcua` 属于 FastCUA `daemon.mjs` 的客户端协议边界；native host 不直接监听它。

## 6. 动态验证

在相同动作序列后枚举 host 自己的顶层窗口：

| 窗口 | 原始版 | 补丁版 |
|---|---:|---:|
| Cursor Overlay | visible | visible |
| Display Overlay | visible | hidden |

补丁版回归结果：

```text
PASS launch_app/list_windows
PASS list_apps
PASS get_window
PASS activate_window
PASS get_window_state
PASS set_value provider parity
PASS click
PASS press_key/type_text
PASS scroll
PASS drag
PASS perform_secondary_action
PASS action effects verified
PASS overlay visibility: cursor=true, display=false
PASS error response
PASS interrupt file

15 regression checks passed.
```

测试夹具上的 `set_value` 元素缓存错误也在未修改原版上复现为同一响应；因此它是原 host 对该自建 provider 的既有边界，不是本补丁造成的差异。补丁没有改动任何 UIA、截图或输入函数。

## 7. 复现静态分析

安装可选分析依赖：

```powershell
python -m pip install -r requirements-analysis.txt
```

示例：

```powershell
python scripts\find-xrefs.py cua-native-host.exe `
  "create display overlay root" `
  "show cursor overlay windows" `
  "raise display overlay"

python scripts\find-import-xrefs.py cua-native-host.exe `
  ShowWindow CreateWindowExW SetWindowPos

python scripts\dump-disasm.py cua-native-host.exe `
  0x140081234 0x1400812bd 0x14008b81b
```

这些脚本利用 PE exception directory 恢复 stripped Rust 函数边界，并用 RIP-relative 引用定位字符串和导入函数。
