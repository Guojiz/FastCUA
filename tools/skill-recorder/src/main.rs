// SPDX-License-Identifier: MIT
//
// skill-recorder — FastCUA issue #3, stages 2-4 (recorder v2).
//
// FastCUA's answer to "record a skill": capture a human demonstration as an
// inspectable, redacted, versioned JSONL session that a compiler can turn into
// an editable, NON-executable Skill draft. Stage-1 evidence lives in
// tools/record-feasibility (untouched); this binary evolves that code into the
// v2 recorder:
//
//   * SPARSE JPEG keyframes (focus change / significant action / note /
//     periodic, default 30s) instead of BMP-every-8s. Target: < 2 MB/min.
//   * Every input event is aligned to a UIA anchor: numeric control-type ID,
//     AutomationId, localized name (marked), role, bounds, value class, and a
//     bounded value snapshot for text-class controls. Clicks anchor via
//     ElementFromPoint; keystrokes anchor via the latest focus snapshot with an
//     age-based confidence.
//   * Typed narration channel: Ctrl+Alt+N opens the recorder's own always-on-top
//     note box; submitted notes become timestamped session records. The
//     recorder's own windows are excluded from the demo event stream.
//   * Session format "fastcua-recording/1": header + per-line flushed JSONL.
//   * Safety: explicit start, visible on-top REC indicator, Ctrl+Alt+R pause
//     toggle, Ctrl+Alt+X emergency stop, secure-desktop exclusion, password
//     redaction (UIA IsPassword OR ES_PASSWORD; vk dropped, values dropped,
//     keyframes suppressed), injected-vs-physical labeling.
//
// REDACTION POLICY (unchanged from stage 1, enforced in code):
//  1. Keyboard events NEVER resolve vk codes to characters.
//  2. In a password context key records carry "redacted": "password-field" and
//     drop even the vk; control values are never read; keyframes suppressed.
//  3. On the Secure Desktop hooks go silent by OS design; only a marker is logged.
//  4. Narration notes are TEXT the teacher types intentionally into the
//     recorder's own box — that is the only place free text enters the session.
//
// Usage: skill-recorder [--out DIR] [--duration-ms N] [--keyframe-interval SEC]
//                       [--uia-poll-ms N] [--no-indicator]
// Controls: Ctrl+Alt+R pause/resume, Ctrl+Alt+N add note, Ctrl+Alt+X stop now,
//           Ctrl+C stop.

#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::mem;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- win32 FFI

type BOOL = i32;
type DWORD = u32;
type UINT = u32;
type WPARAM = usize;
type LPARAM = isize;
type LRESULT = isize;
type HWND = *mut c_void;
type HHOOK = *mut c_void;
type HMODULE = *mut c_void;
type HANDLE = *mut c_void;
type HDC = *mut c_void;
type HGDIOBJ = *mut c_void;
type HBITMAP = *mut c_void;
type ATOM = u16;
type WORD = u16;
type ULONG_PTR = usize;

const TRUE: BOOL = 1;
const FALSE: BOOL = 0;

const WH_KEYBOARD_LL: i32 = 13;
const WH_MOUSE_LL: i32 = 14;

const LLKHF_EXTENDED: DWORD = 0x01;
const LLKHF_INJECTED: DWORD = 0x10;
const LLKHF_LOWER_IL_INJECTED: DWORD = 0x20;
const LLKHF_UP: DWORD = 0x80;

const LLMHF_INJECTED: DWORD = 0x01;
const LLMHF_LOWER_IL_INJECTED: DWORD = 0x02;

const WM_KEYDOWN: UINT = 0x0100;
const WM_KEYUP: UINT = 0x0101;
const WM_SYSKEYDOWN: UINT = 0x0104;
const WM_SYSKEYUP: UINT = 0x0105;
const WM_MOUSEMOVE: UINT = 0x0200;
const WM_LBUTTONDOWN: UINT = 0x0201;
const WM_LBUTTONUP: UINT = 0x0202;
const WM_RBUTTONDOWN: UINT = 0x0204;
const WM_RBUTTONUP: UINT = 0x0205;
const WM_MBUTTONDOWN: UINT = 0x0207;
const WM_MBUTTONUP: UINT = 0x0208;
const WM_MOUSEWHEEL: UINT = 0x020a;
const WM_MOUSEHWHEEL: UINT = 0x020e;
const WM_HOTKEY: UINT = 0x0312;
const WM_QUIT: UINT = 0x0012;
const WM_CLOSE: UINT = 0x0010;
const WM_COMMAND: UINT = 0x0111;
const WM_CTLCOLORSTATIC: UINT = 0x0138;
const WM_GETTEXT: UINT = 0x000d;
const WM_GETTEXTLENGTH: UINT = 0x000e;

const MOD_ALT: UINT = 0x0001;
const MOD_CONTROL: UINT = 0x0002;
const MOD_NOREPEAT: UINT = 0x4000;

const VK_RETURN: u32 = 0x0d;
const VK_ESCAPE: u32 = 0x1b;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_SHIFT: u32 = 0x10;
const VK_LWIN: u32 = 0x5b;
const VK_RWIN: u32 = 0x5c;
const VK_PROCESSKEY: u32 = 0xe5;
const VK_PACKET: u32 = 0xe7;

const EVENT_OBJECT_FOCUS: DWORD = 0x8005;
const WINEVENT_OUTOFCONTEXT: DWORD = 0x0000;
const WINEVENT_SKIPOWNPROCESS: DWORD = 0x0002;

const GWL_STYLE: i32 = -16;
const GWLP_WNDPROC: i32 = -4;
const ES_PASSWORD: u32 = 0x0020;

const SM_CXSCREEN: i32 = 0;
const SM_CYSCREEN: i32 = 1;
const SM_CMONITORS: i32 = 80;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

const SRCCOPY: DWORD = 0x00cc0020;
const CAPTUREBLT: DWORD = 0x40000000;
const DIB_RGB_COLORS: UINT = 0;
const BI_RGB: DWORD = 0;

const SMTO_ABORTIFHUNG: UINT = 0x0002;
const SMTO_BLOCK: UINT = 0x0001;

const WS_OVERLAPPED: DWORD = 0x0000_0000;
const WS_CAPTION: DWORD = 0x00c0_0000;
const WS_SYSMENU: DWORD = 0x0008_0000;
const WS_VISIBLE: DWORD = 0x1000_0000;
const WS_CHILD: DWORD = 0x4000_0000;
const WS_POPUP: DWORD = 0x8000_0000;
const WS_EX_TOPMOST: DWORD = 0x0000_0008;
const WS_EX_TOOLWINDOW: DWORD = 0x0000_0080;
const WS_EX_NOACTIVATE: DWORD = 0x0800_0000;
const WS_EX_CLIENTEDGE: DWORD = 0x0000_0200;
const ES_AUTOHSCROLL: DWORD = 0x0080;
const SS_CENTER: DWORD = 0x0001;
const SW_SHOW: DWORD = 5;
const SW_HIDE: DWORD = 0;
const TRANSPARENT: i32 = 1;

const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

const COINIT_MULTITHREADED: u32 = 0x0;
const CLSCTX_INPROC_SERVER: u32 = 0x1;
const RPC_E_CHANGED_MODE: i32 = -2147417850;

const SESSION_FORMAT: &str = "fastcua-recording/1";

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct POINT {
    x: i32,
    y: i32,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct KBDLLHOOKSTRUCT {
    vkCode: DWORD,
    scanCode: DWORD,
    flags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MSLLHOOKSTRUCT {
    pt: POINT,
    mouseData: DWORD,
    flags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
}
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct MSG {
    hwnd: HWND,
    message: UINT,
    wParam: WPARAM,
    lParam: LPARAM,
    time: DWORD,
    pt: POINT,
    lPrivate: DWORD,
}
#[repr(C)]
#[derive(Default)]
struct BITMAPINFOHEADER {
    biSize: DWORD,
    biWidth: i32,
    biHeight: i32,
    biPlanes: WORD,
    biBitCount: WORD,
    biCompression: DWORD,
    biSizeImage: DWORD,
    biXPelsPerMeter: i32,
    biYPelsPerMeter: i32,
    biClrUsed: DWORD,
    biClrImportant: DWORD,
}
#[repr(C)]
#[derive(Default)]
struct BITMAPINFO {
    bmiHeader: BITMAPINFOHEADER,
    bmiColors: [u32; 1],
}
#[repr(C)]
#[derive(Default)]
struct PROCESS_MEMORY_COUNTERS {
    cb: DWORD,
    PageFaultCount: DWORD,
    PeakWorkingSetSize: usize,
    WorkingSetSize: usize,
    QuotaPeakPagedPoolUsage: usize,
    QuotaPagedPoolUsage: usize,
    QuotaPeakNonPagedPoolUsage: usize,
    QuotaNonPagedPoolUsage: usize,
    PagefileUsage: usize,
    PeakPagefileUsage: usize,
}
#[repr(C)]
#[derive(Default)]
struct FILETIME {
    lo: DWORD,
    hi: DWORD,
}
impl FILETIME {
    fn as_u64(&self) -> u64 {
        ((self.hi as u64) << 32) | self.lo as u64
    }
}
#[repr(C)]
struct Guid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}
#[repr(C)]
struct WNDCLASSW {
    style: UINT,
    lpfnWndProc: *const c_void,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: HMODULE,
    hIcon: HANDLE,
    hCursor: HANDLE,
    hbrBackground: HANDLE,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
}

const CLSID_CUI_AUTOMATION: Guid = Guid {
    data1: 0xff48dba4,
    data2: 0x60ef,
    data3: 0x4201,
    data4: [0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e],
};
const IID_IUI_AUTOMATION: Guid = Guid {
    data1: 0x30cbe57d,
    data2: 0xd9d0,
    data3: 0x452a,
    data4: [0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee],
};

type ComPtr = *mut c_void;
type WinEventProc = unsafe extern "system" fn(HANDLE, DWORD, HWND, i32, i32, DWORD, DWORD);
type HookProc = unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT;

#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowsHookExW(id_hook: i32, proc_: HookProc, module: HMODULE, thread_id: DWORD)
        -> HHOOK;
    fn UnhookWindowsHookEx(hook: HHOOK) -> BOOL;
    fn CallNextHookEx(hook: HHOOK, code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    fn SetWinEventHook(
        event_min: DWORD,
        event_max: DWORD,
        module: HMODULE,
        proc_: WinEventProc,
        process: DWORD,
        thread: DWORD,
        flags: DWORD,
    ) -> HANDLE;
    fn UnhookWinEvent(hook: HANDLE) -> BOOL;
    fn RegisterHotKey(hwnd: HWND, id: i32, modifiers: UINT, vk: UINT) -> BOOL;
    fn UnregisterHotKey(hwnd: HWND, id: i32) -> BOOL;
    fn GetMessageW(msg: *mut MSG, hwnd: HWND, min: UINT, max: UINT) -> BOOL;
    fn TranslateMessage(msg: *const MSG) -> BOOL;
    fn DispatchMessageW(msg: *const MSG) -> LRESULT;
    fn PostThreadMessageW(thread: DWORD, msg: UINT, wparam: WPARAM, lparam: LPARAM) -> BOOL;
    fn GetCurrentThreadId() -> DWORD;
    fn GetForegroundWindow() -> HWND;
    fn GetWindowThreadProcessId(hwnd: HWND, pid: *mut DWORD) -> DWORD;
    fn GetWindowTextW(hwnd: HWND, text: *mut u16, max: i32) -> i32;
    fn SetWindowTextW(hwnd: HWND, text: *const u16) -> BOOL;
    fn IsHungAppWindow(hwnd: HWND) -> BOOL;
    fn SendMessageTimeoutW(
        hwnd: HWND,
        msg: UINT,
        wparam: WPARAM,
        lparam: LPARAM,
        flags: UINT,
        timeout_ms: UINT,
        result: *mut usize,
    ) -> LRESULT;
    fn GetWindowRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    fn GetWindowLongW(hwnd: HWND, index: i32) -> i32;
    fn SetWindowLongPtrW(hwnd: HWND, index: i32, value: isize) -> isize;
    fn CallWindowProcW(
        proc_: *const c_void,
        hwnd: HWND,
        msg: UINT,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT;
    fn IsWindow(hwnd: HWND) -> BOOL;
    fn GetKeyState(vk: i32) -> i16;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetWindowDC(hwnd: HWND) -> HDC;
    fn GetDC(hwnd: HWND) -> HDC;
    fn ReleaseDC(hwnd: HWND, dc: HDC) -> i32;
    fn PrintWindow(hwnd: HWND, dc: HDC, flags: UINT) -> BOOL;
    fn GetDpiForSystem() -> UINT;
    fn SetProcessDpiAwarenessContext(value: usize) -> BOOL;
    fn GetKeyboardLayout(thread: DWORD) -> HANDLE;
    fn OpenInputDesktop(flags: DWORD, inherit: BOOL, access: DWORD) -> HANDLE;
    fn CloseDesktop(desk: HANDLE) -> BOOL;
    fn GetUserObjectInformationW(
        obj: HANDLE,
        index: i32,
        info: *mut c_void,
        len: DWORD,
        needed: *mut DWORD,
    ) -> BOOL;
    fn SetConsoleCtrlHandler(handler: unsafe extern "system" fn(DWORD) -> BOOL, add: BOOL) -> BOOL;
    fn GetModuleHandleW(name: *const u16) -> HMODULE;
    fn RegisterClassW(class: *const WNDCLASSW) -> ATOM;
    fn CreateWindowExW(
        ex_style: DWORD,
        class: *const u16,
        name: *const u16,
        style: DWORD,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: HWND,
        menu: HANDLE,
        instance: HMODULE,
        param: *mut c_void,
    ) -> HWND;
    fn DefWindowProcW(hwnd: HWND, msg: UINT, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    fn ShowWindow(hwnd: HWND, cmd: i32) -> BOOL;
    fn SetForegroundWindow(hwnd: HWND) -> BOOL;
    fn BringWindowToTop(hwnd: HWND) -> BOOL;
    fn SetFocus(hwnd: HWND) -> HWND;
    fn GetSysColorBrush(index: i32) -> HANDLE;
    fn LoadCursorW(instance: HMODULE, name: *const u16) -> HANDLE;
}
#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(dc: HDC) -> HDC;
    fn CreateCompatibleBitmap(dc: HDC, w: i32, h: i32) -> HBITMAP;
    fn SelectObject(dc: HDC, obj: HGDIOBJ) -> HGDIOBJ;
    fn BitBlt(
        dst: HDC,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        src: HDC,
        sx: i32,
        sy: i32,
        rop: DWORD,
    ) -> BOOL;
    fn GetDIBits(
        dc: HDC,
        bmp: HBITMAP,
        start: UINT,
        lines: UINT,
        bits: *mut c_void,
        info: *mut BITMAPINFO,
        usage: UINT,
    ) -> i32;
    fn DeleteObject(obj: HGDIOBJ) -> BOOL;
    fn DeleteDC(dc: HDC) -> BOOL;
    fn CreateSolidBrush(color: DWORD) -> HANDLE;
    fn SetTextColor(dc: HDC, color: DWORD) -> DWORD;
    fn SetBkMode(dc: HDC, mode: i32) -> i32;
    fn StretchBlt(
        dst: HDC,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        src: HDC,
        sx: i32,
        sy: i32,
        sw: i32,
        sh: i32,
        rop: DWORD,
    ) -> BOOL;
    fn SetStretchBltMode(dc: HDC, mode: i32) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> HANDLE;
    fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn QueryFullProcessImageNameW(
        proc_: HANDLE,
        flags: DWORD,
        name: *mut u16,
        size: *mut DWORD,
    ) -> BOOL;
    fn QueryPerformanceCounter(counter: *mut i64) -> BOOL;
    fn QueryPerformanceFrequency(freq: *mut i64) -> BOOL;
    fn GetProcessTimes(
        proc_: HANDLE,
        create: *mut FILETIME,
        exit: *mut FILETIME,
        kernel: *mut FILETIME,
        user: *mut FILETIME,
    ) -> BOOL;
    fn GetSystemTimeAsFileTime(out: *mut FILETIME);
    fn Sleep(ms: DWORD);
}
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(
        proc_: HANDLE,
        counters: *mut PROCESS_MEMORY_COUNTERS,
        cb: DWORD,
    ) -> BOOL;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> i32;
    fn CoUninitialize();
    fn CoCreateInstance(
        clsid: *const Guid,
        outer: ComPtr,
        clsctx: u32,
        iid: *const Guid,
        out: *mut ComPtr,
    ) -> i32;
}
#[link(name = "oleaut32")]
unsafe extern "system" {
    fn SysStringLen(value: *const u16) -> u32;
    fn SysFreeString(value: *mut u16);
}

// ---------------------------------------------------------------- events

enum Record {
    Hook {
        kind: &'static str,
        unix_ms: u64,
        event_time: DWORD,
        injected: bool,
        lower_il: bool,
        vk_or_button: u32,
        key_class: Option<&'static str>,
        scan: u32,
        extended: bool,
        ctrl: bool,
        shift: bool,
        alt: bool,
        win: bool,
        x: i32,
        y: i32,
        wheel: i32,
        fg: usize,
    },
    Focus {
        unix_ms: u64,
        trigger: &'static str,
        hwnd: usize,
        uia: Option<UiaFocus>,
        secure_desktop: bool,
    },
    Keyframe {
        unix_ms: u64,
        hwnd: usize,
        path: String,
        width: i32,
        height: i32,
        bytes: u64,
        suppressed: bool,
        reason: &'static str,
    },
    Note {
        unix_ms: u64,
        text: String,
    },
    Stats {
        unix_ms: u64,
    },
    Marker {
        unix_ms: u64,
        text: String,
    },
    /// Media availability report (audio best-effort, video directory layout).
    Media {
        unix_ms: u64,
        kind: &'static str,
        status: &'static str,
        detail: String,
    },
}

/// A semantic anchor: the UIA control an input event (or focus) landed on.
/// Numeric control-type IDs are the durable key; names are localized hints.
#[derive(Clone, Default)]
struct UiaFocus {
    name: String,
    automation_id: String,
    control_type: i32,
    role: &'static str,
    is_password: bool,
    hwnd: usize,
    bounds: Option<RECT>,
    value_class: &'static str,
    value: Option<String>,
    error: Option<String>,
}

static SENDER: OnceLock<mpsc::Sender<Record>> = OnceLock::new();
static RECORDING: AtomicBool = AtomicBool::new(true);
static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static CB_COUNT: AtomicU64 = AtomicU64::new(0);
static CB_TOTAL_NS: AtomicU64 = AtomicU64::new(0);
static CB_MAX_NS: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static COALESCED: AtomicU64 = AtomicU64::new(0);
static LAST_MOVE_MS: AtomicU64 = AtomicU64::new(0);
static KEYFRAME_COUNT: AtomicU64 = AtomicU64::new(0);
static KEYFRAME_BYTES: AtomicU64 = AtomicU64::new(0);
static VIDEO_FRAMES: AtomicU64 = AtomicU64::new(0);
static VIDEO_BYTES: AtomicU64 = AtomicU64::new(0);
static VIDEO_GAPS: AtomicU64 = AtomicU64::new(0);
static AUDIO_BYTES: AtomicU64 = AtomicU64::new(0);
static ACTION_KEYFRAME: AtomicBool = AtomicBool::new(false);
static NOTE_KEYFRAME: AtomicBool = AtomicBool::new(false);
static QPC_FREQ: OnceLock<i64> = OnceLock::new();
static FOCUS_WAKE: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static LATEST_FOCUS: Mutex<Option<(u64, UiaFocus)>> = Mutex::new(None);
static MAIN_THREAD: AtomicU64 = AtomicU64::new(0);
static NOTE_HWND: AtomicUsize = AtomicUsize::new(0);
static NOTE_EDIT: AtomicUsize = AtomicUsize::new(0);
static NOTE_EDIT_ORIG: AtomicUsize = AtomicUsize::new(0);
static IND_HWND: AtomicUsize = AtomicUsize::new(0);

fn unix_ms() -> u64 {
    let mut ft = FILETIME::default();
    unsafe { GetSystemTimeAsFileTime(&mut ft) };
    ft.as_u64() / 10_000 - 11_644_473_600_000
}

fn qpc_ns() -> u64 {
    let mut counter = 0i64;
    unsafe { QueryPerformanceCounter(&mut counter) };
    let freq = *QPC_FREQ.get_or_init(|| {
        let mut f = 0i64;
        unsafe { QueryPerformanceFrequency(&mut f) };
        f.max(1)
    });
    (counter as u128 * 1_000_000_000 / freq as u128) as u64
}

fn enqueue(record: Record) {
    if let Some(sender) = SENDER.get() {
        // Hook callbacks must never block: count a drop instead of stalling.
        if sender.send(record).is_err() {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn is_our_hwnd(hwnd: usize) -> bool {
    hwnd != 0
        && (hwnd == NOTE_HWND.load(Ordering::Relaxed) || hwnd == IND_HWND.load(Ordering::Relaxed))
}

fn mods() -> (bool, bool, bool, bool) {
    unsafe {
        (
            GetKeyState(VK_CONTROL as i32) < 0,
            GetKeyState(VK_SHIFT as i32) < 0,
            GetKeyState(VK_MENU as i32) < 0,
            GetKeyState(VK_LWIN as i32) < 0 || GetKeyState(VK_RWIN as i32) < 0,
        )
    }
}

/// Coarse key class only — never the character. This is the redaction boundary.
fn key_class(vk: u32) -> &'static str {
    match vk {
        0x30..=0x39 | 0x41..=0x5a | 0x60..=0x6f | 0xba..=0xc0 | 0xdb..=0xde | 0xe1..=0xe4 => {
            "printable"
        }
        0x70..=0x87 => "function",
        0x21..=0x28 | 0x2d | 0x2e => "navigation",
        0x08 | 0x09 | 0x0d | 0x1b | 0x20 => "editing",
        0x10..=0x12 | 0xa0..=0xa5 | 0x5b | 0x5c => "modifier",
        0xe5 | 0xe7 => "ime",
        0x90 | 0x91 | 0x14 => "lock",
        _ => "other",
    }
}

/// The recorder's own hotkey chords (note / toggle / stop) are control input
/// for the recorder, not part of the demonstration. Registered hotkeys preempt
/// delivery to the target app too, so skipping them here loses nothing.
fn is_recorder_chord(vk: u32, ctrl: bool, shift: bool, alt: bool, win: bool) -> bool {
    ctrl && alt && !shift && !win && (vk == 0x4e || vk == 0x52 || vk == 0x58) // N / R / X
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let start = qpc_ns();
    if code >= 0 && RECORDING.load(Ordering::Relaxed) {
        let kb = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let down = wparam as UINT == WM_KEYDOWN || wparam as UINT == WM_SYSKEYDOWN;
        let (ctrl, shift, alt, win) = mods();
        let fg = unsafe { GetForegroundWindow() } as usize;
        if !is_our_hwnd(fg) && !is_recorder_chord(kb.vkCode, ctrl, shift, alt, win) {
            enqueue(Record::Hook {
                kind: if down { "key_down" } else { "key_up" },
                unix_ms: unix_ms(),
                event_time: kb.time,
                injected: kb.flags & LLKHF_INJECTED != 0,
                lower_il: kb.flags & LLKHF_LOWER_IL_INJECTED != 0,
                vk_or_button: kb.vkCode,
                key_class: Some(key_class(kb.vkCode)),
                scan: kb.scanCode,
                extended: kb.flags & LLKHF_EXTENDED != 0,
                ctrl,
                shift,
                alt,
                win,
                x: 0,
                y: 0,
                wheel: 0,
                fg,
            });
            if down && kb.vkCode == VK_RETURN {
                ACTION_KEYFRAME.store(true, Ordering::Relaxed);
            }
            if let Some(wake) = FOCUS_WAKE.get() {
                let _ = wake.send(());
            }
        }
    }
    note_callback(start);
    unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let start = qpc_ns();
    if code >= 0 && RECORDING.load(Ordering::Relaxed) {
        let ms = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
        let msg = wparam as UINT;
        let now = unix_ms();
        if msg == WM_MOUSEMOVE {
            // Coalesce pure moves to one per ~40ms (counted, not logged).
            let last = LAST_MOVE_MS.load(Ordering::Relaxed);
            if now.saturating_sub(last) < 40 {
                COALESCED.fetch_add(1, Ordering::Relaxed);
                note_callback(start);
                return unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) };
            }
            LAST_MOVE_MS.store(now, Ordering::Relaxed);
        }
        let fg = unsafe { GetForegroundWindow() } as usize;
        if !is_our_hwnd(fg) {
            let (button, wheel) = match msg {
                WM_LBUTTONDOWN | WM_LBUTTONUP => (1, 0),
                WM_RBUTTONDOWN | WM_RBUTTONUP => (2, 0),
                WM_MBUTTONDOWN | WM_MBUTTONUP => (3, 0),
                WM_MOUSEWHEEL | WM_MOUSEHWHEEL => (0, (ms.mouseData >> 16) as i16 as i32),
                _ => (0, 0),
            };
            let kind: &'static str = match msg {
                WM_MOUSEMOVE => "mouse_move",
                WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN => "mouse_down",
                WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP => "mouse_up",
                WM_MOUSEWHEEL => "wheel_v",
                WM_MOUSEHWHEEL => "wheel_h",
                _ => "mouse_other",
            };
            if matches!(msg, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN) {
                ACTION_KEYFRAME.store(true, Ordering::Relaxed);
            }
            enqueue(Record::Hook {
                kind,
                unix_ms: now,
                event_time: ms.time,
                injected: ms.flags & LLMHF_INJECTED != 0,
                lower_il: ms.flags & LLMHF_LOWER_IL_INJECTED != 0,
                vk_or_button: button,
                key_class: None,
                scan: 0,
                extended: false,
                ctrl: false,
                shift: false,
                alt: false,
                win: false,
                x: ms.pt.x,
                y: ms.pt.y,
                wheel,
                fg,
            });
        }
    }
    note_callback(start);
    unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) }
}

fn note_callback(start_ns: u64) {
    let elapsed = qpc_ns().saturating_sub(start_ns);
    CB_COUNT.fetch_add(1, Ordering::Relaxed);
    CB_TOTAL_NS.fetch_add(elapsed, Ordering::Relaxed);
    CB_MAX_NS.fetch_max(elapsed, Ordering::Relaxed);
}

unsafe extern "system" fn focus_event_proc(
    _hook: HANDLE,
    event: DWORD,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: DWORD,
    _time: DWORD,
) {
    if event == EVENT_OBJECT_FOCUS && id_object == 0 && RECORDING.load(Ordering::Relaxed) {
        if !hwnd.is_null() {
            if let Some(wake) = FOCUS_WAKE.get() {
                let _ = wake.send(());
            }
        }
    }
}

// ---------------------------------------------------------------- UIA anchors

unsafe fn com_method(object: ComPtr, slot: usize) -> *const c_void {
    let vtable = unsafe { *(object as *const *const *const c_void) };
    unsafe { *vtable.add(slot) }
}

unsafe fn release(object: ComPtr) {
    if !object.is_null() {
        let rel: unsafe extern "system" fn(ComPtr) -> u32 =
            unsafe { mem::transmute(com_method(object, 2)) };
        unsafe { rel(object) };
    }
}

fn role_name(control_type: i32) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        _ => "Element",
    }
}

/// What kind of value a control holds. "secret" is never read or logged.
fn value_class(control_type: i32, is_password: bool) -> &'static str {
    if is_password {
        return "secret";
    }
    match control_type {
        50004 | 50030 | 50003 | 50015 | 50016 => "text", // Edit, Document, ComboBox, Slider, Spinner
        50029 => "text", // DataItem — e.g. an Excel cell; its ValuePattern carries the cell content
        50000 | 50011 | 50002 | 50013 | 50019 | 50007 | 50024 | 50005 => "action",
        _ => "none",
    }
}

/// Read an element's value through UIA ValuePattern (bounded string). This is
/// the ONLY value channel for virtual elements (hwnd == 0) like Excel cells;
/// skipped for Document controls whose values can be arbitrarily large.
unsafe fn element_value_pattern(element: ComPtr, control_type: i32) -> Option<String> {
    if element.is_null() || control_type == 50030 {
        return None;
    }
    let get_pattern: unsafe extern "system" fn(ComPtr, i32, *mut ComPtr) -> i32 =
        unsafe { mem::transmute(com_method(element, 16)) };
    let mut pattern = ptr::null_mut();
    if unsafe { get_pattern(element, UIA_VALUE_PATTERN_ID, &mut pattern) } < 0 || pattern.is_null()
    {
        return None;
    }
    let qi: unsafe extern "system" fn(ComPtr, *const Guid, *mut ComPtr) -> i32 =
        unsafe { mem::transmute(com_method(pattern, 0)) };
    let mut value_pattern = ptr::null_mut();
    let ok = unsafe {
        qi(
            pattern,
            &IID_IUIAUTOMATION_VALUE_PATTERN,
            &mut value_pattern,
        )
    } >= 0
        && !value_pattern.is_null();
    unsafe { release(pattern) };
    if !ok {
        return None;
    }
    let get_value: unsafe extern "system" fn(ComPtr, *mut *mut u16) -> i32 =
        unsafe { mem::transmute(com_method(value_pattern, 4)) };
    let mut bstr = ptr::null_mut();
    let hr = unsafe { get_value(value_pattern, &mut bstr) };
    unsafe { release(value_pattern) };
    if hr < 0 || bstr.is_null() {
        return None;
    }
    let len = (unsafe { SysStringLen(bstr) } as usize).min(1024);
    let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(bstr, len) });
    unsafe { SysFreeString(bstr) };
    Some(s)
}

/// Bounded cross-process value read for text-class controls (same defense as
/// the native host: SendMessageTimeout with SMTO_ABORTIFHUNG). UWP Document
/// controls answer nothing here; the compiler treats value as a hint anyway.
fn control_value(hwnd: HWND) -> Option<String> {
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 || unsafe { IsHungAppWindow(hwnd) } != 0 {
        return None;
    }
    let mut length: usize = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXTLENGTH,
            0,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            300,
            &mut length,
        )
    } == 0
    {
        return None;
    }
    if length == 0 {
        return Some(String::new());
    }
    let mut buf = vec![0u16; (length + 1).min(1025)];
    let mut copied: usize = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            buf.len(),
            buf.as_mut_ptr() as LPARAM,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            300,
            &mut copied,
        )
    } == 0
    {
        return None;
    }
    Some(String::from_utf16_lossy(
        &buf[..copied.min(buf.len().saturating_sub(1))],
    ))
}

unsafe fn element_bstr(element: ComPtr, slot: usize) -> String {
    let getter: unsafe extern "system" fn(ComPtr, *mut *mut u16) -> i32 =
        unsafe { mem::transmute(com_method(element, slot)) };
    let mut bstr = ptr::null_mut();
    if unsafe { getter(element, &mut bstr) } >= 0 && !bstr.is_null() {
        let len = unsafe { SysStringLen(bstr) } as usize;
        let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(bstr, len) });
        unsafe { SysFreeString(bstr) };
        s
    } else {
        String::new()
    }
}

/// Fill a UiaFocus from a live IUIAutomationElement (slot map verified against
/// stage-1: 21 ControlType, 23 Name, 29 AutomationId, 35 IsPassword,
/// 36 NativeWindowHandle, 43 BoundingRectangle).
unsafe fn element_to_anchor(automation: ComPtr, element: ComPtr) -> UiaFocus {
    let _ = automation;
    let get_i32 = |slot: usize| -> Option<i32> {
        let getter: unsafe extern "system" fn(ComPtr, *mut i32) -> i32 =
            unsafe { mem::transmute(com_method(element, slot)) };
        let mut v = 0;
        if unsafe { getter(element, &mut v) } < 0 {
            None
        } else {
            Some(v)
        }
    };
    let name = unsafe { element_bstr(element, 23) };
    let automation_id = unsafe { element_bstr(element, 29) };
    let control_type = get_i32(21).unwrap_or(0);
    let is_password_uia = get_i32(35).map(|v| v != 0);
    let hwnd = {
        let getter: unsafe extern "system" fn(ComPtr, *mut HWND) -> i32 =
            unsafe { mem::transmute(com_method(element, 36)) };
        let mut h: HWND = ptr::null_mut();
        if unsafe { getter(element, &mut h) } < 0 {
            ptr::null_mut()
        } else {
            h
        }
    };
    let bounds = {
        let getter: unsafe extern "system" fn(ComPtr, *mut RECT) -> i32 =
            unsafe { mem::transmute(com_method(element, 43)) };
        let mut r = RECT::default();
        if unsafe { getter(element, &mut r) } < 0 {
            None
        } else {
            Some(r)
        }
    };
    // Belt-and-braces password detection: UIA IsPassword OR classic ES_PASSWORD.
    let style_password =
        !hwnd.is_null() && (unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32 & ES_PASSWORD) != 0;
    let is_password = is_password_uia.unwrap_or(false) || style_password;
    let class = value_class(control_type, is_password);
    let value = if class == "text" {
        control_value(hwnd).or_else(|| unsafe { element_value_pattern(element, control_type) })
    } else {
        None
    };
    UiaFocus {
        name,
        automation_id,
        control_type,
        role: role_name(control_type),
        is_password,
        hwnd: hwnd as usize,
        bounds,
        value_class: class,
        value,
        error: None,
    }
}
/// Snapshot the focused element and re-read the values of any PENDING
/// elements (recently-departed text controls). Commit-on-blur controls —
/// Excel cells above all — only settle their value AFTER focus leaves, and
/// the cell element persists, so its ValuePattern becomes readable a tick
/// later. Pending pointers stay owned by the caller (the worker only reads,
/// never releases); on timeout the caller leaks them rather than risk a
/// use-after-free from a still-hung worker. All pointers travel between MTA
/// threads of one apartment, which is legal COM for UIA proxies.
fn uia_focus_snapshot(
    pending: &[(ComPtr, i32, i32, i32, String)],
) -> Option<(Option<UiaFocus>, ComPtr, Vec<Option<String>>)> {
    let (tx, rx) = mpsc::channel::<(Option<UiaFocus>, usize, Vec<Option<String>>)>();
    let pending_flat: Vec<(usize, i32, i32, i32, String)> = pending
        .iter()
        .map(|(p, x, y, ct, aid)| (*p as usize, *x, *y, *ct, aid.clone()))
        .collect();
    thread::Builder::new()
        .name("rec-uia".into())
        .spawn(move || {
            let (snap, elem, values) = unsafe { uia_focus_inner(&pending_flat) };
            let _ = tx.send((snap, elem as usize, values));
        })
        .ok()?;
    let (snap, elem, values) = rx.recv_timeout(Duration::from_millis(800)).ok()?;
    Some((snap, elem as ComPtr, values))
}

unsafe fn uia_focus_inner(
    pending: &[(usize, i32, i32, i32, String)],
) -> (Option<UiaFocus>, ComPtr, Vec<Option<String>>) {
    let init = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_MULTITHREADED) };
    let should_uninit = init == 0 || init == 1;
    if init < 0 && init != RPC_E_CHANGED_MODE {
        return (
            Some(UiaFocus {
                error: Some(format!("CoInitializeEx 0x{:08x}", init as u32)),
                ..Default::default()
            }),
            ptr::null_mut(),
            pending.iter().map(|_| None).collect(),
        );
    }
    let mut automation = ptr::null_mut();
    let created = unsafe {
        CoCreateInstance(
            &CLSID_CUI_AUTOMATION,
            ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_IUI_AUTOMATION,
            &mut automation,
        )
    };
    let automation_ok = created >= 0 && !automation.is_null();
    // Pending departed elements: values settle once the commit lands. Virtual
    // elements (hwnd == 0, e.g. Excel cells) are re-located FRESH via
    // ElementFromPoint at their last bounds — Office recycles element
    // objects around an edit, so the stale pointer reads "" forever.
    // The re-located element must keep the SAME identity (control-type +
    // AutomationId): Excel's in-cell editor sits exactly over its cell, so
    // the editor's point re-read lands on the cell and would otherwise
    // duplicate the cell's value (or read a title-bar neighbour).
    let pending_values: Vec<Option<String>> = if automation_ok {
        pending
            .iter()
            .map(|(p, cx, cy, want_ct, want_aid)| {
                let element = *p as ComPtr;
                let hwnd = {
                    let getter: unsafe extern "system" fn(ComPtr, *mut HWND) -> i32 =
                        unsafe { mem::transmute(com_method(element, 36)) };
                    let mut h: HWND = ptr::null_mut();
                    if unsafe { getter(element, &mut h) } < 0 {
                        ptr::null_mut()
                    } else {
                        h
                    }
                };
                if !hwnd.is_null() {
                    let ct = {
                        let getter: unsafe extern "system" fn(ComPtr, *mut i32) -> i32 =
                            unsafe { mem::transmute(com_method(element, 21)) };
                        let mut v = 0;
                        if unsafe { getter(element, &mut v) } < 0 {
                            0
                        } else {
                            v
                        }
                    };
                    control_value(hwnd).or_else(|| unsafe { element_value_pattern(element, ct) })
                } else {
                    let from_point: unsafe extern "system" fn(ComPtr, POINT, *mut ComPtr) -> i32 =
                        unsafe { mem::transmute(com_method(automation, 7)) };
                    let mut fresh = ptr::null_mut();
                    let hr =
                        unsafe { from_point(automation, POINT { x: *cx, y: *cy }, &mut fresh) };
                    if hr < 0 || fresh.is_null() {
                        None
                    } else {
                        let ct = {
                            let getter: unsafe extern "system" fn(ComPtr, *mut i32) -> i32 =
                                unsafe { mem::transmute(com_method(fresh, 21)) };
                            let mut v = 0;
                            if unsafe { getter(fresh, &mut v) } < 0 {
                                0
                            } else {
                                v
                            }
                        };
                        let aid = unsafe { element_bstr(fresh, 29) };
                        if ct != *want_ct || aid != *want_aid {
                            // Re-located to a different element (e.g. the cell
                            // under the just-closed editor) — not ours.
                            unsafe { release(fresh) };
                            None
                        } else {
                            let v = unsafe { element_value_pattern(fresh, ct) };
                            unsafe { release(fresh) };
                            v
                        }
                    }
                }
            })
            .collect()
    } else {
        pending.iter().map(|_| None).collect()
    };
    let (snapshot, new_element) = if !automation_ok {
        (
            Some(UiaFocus {
                error: Some(format!("CoCreateInstance 0x{:08x}", created as u32)),
                ..Default::default()
            }),
            ptr::null_mut(),
        )
    } else {
        let get_focused: unsafe extern "system" fn(ComPtr, *mut ComPtr) -> i32 =
            unsafe { mem::transmute(com_method(automation, 8)) };
        let mut focused = ptr::null_mut();
        let hr = unsafe { get_focused(automation, &mut focused) };
        if hr < 0 || focused.is_null() {
            unsafe { release(automation) };
            (
                Some(UiaFocus {
                    error: Some("no focused element".into()),
                    ..Default::default()
                }),
                ptr::null_mut(),
            )
        } else {
            let anchor = unsafe { element_to_anchor(automation, focused) };
            // Ownership of `focused` transfers to the caller (do NOT release).
            unsafe { release(automation) };
            (Some(anchor), focused)
        }
    };
    if should_uninit {
        unsafe { CoUninitialize() };
    }
    (snapshot, new_element, pending_values)
}

/// Point anchor for clicks: bounded ElementFromPoint at screen coords.
/// Returns None on timeout/failure — the event keeps "alignment":"none".
fn uia_point_anchor(x: i32, y: i32) -> Option<UiaFocus> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("rec-uia-point".into())
        .spawn(move || {
            let _ = tx.send(unsafe { uia_point_inner(x, y) });
        })
        .ok()?;
    rx.recv_timeout(Duration::from_millis(300)).ok()?
}

unsafe fn uia_point_inner(x: i32, y: i32) -> Option<UiaFocus> {
    let init = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_MULTITHREADED) };
    let should_uninit = init == 0 || init == 1;
    if init < 0 && init != RPC_E_CHANGED_MODE {
        return None;
    }
    let result = (|| {
        let mut automation = ptr::null_mut();
        let created = unsafe {
            CoCreateInstance(
                &CLSID_CUI_AUTOMATION,
                ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_IUI_AUTOMATION,
                &mut automation,
            )
        };
        if created < 0 || automation.is_null() {
            return None;
        }
        let element_from_point: unsafe extern "system" fn(ComPtr, POINT, *mut ComPtr) -> i32 =
            unsafe { mem::transmute(com_method(automation, 7)) };
        let mut element = ptr::null_mut();
        let hr = unsafe { element_from_point(automation, POINT { x, y }, &mut element) };
        if hr < 0 || element.is_null() {
            unsafe { release(automation) };
            return None;
        }
        let anchor = unsafe { element_to_anchor(automation, element) };
        unsafe { release(element) };
        unsafe { release(automation) };
        Some(anchor)
    })();
    if should_uninit {
        unsafe { CoUninitialize() };
    }
    result
}

fn input_desktop_is_secure() -> bool {
    unsafe {
        let desk = OpenInputDesktop(0, FALSE, 0x0001);
        if desk.is_null() {
            return true;
        }
        let mut buf = [0u16; 64];
        let mut needed = 0;
        let ok = GetUserObjectInformationW(desk, 2, buf.as_mut_ptr().cast(), 128, &mut needed);
        CloseDesktop(desk);
        if ok == 0 {
            return true;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(64);
        let name = String::from_utf16_lossy(&buf[..len]);
        !name.eq_ignore_ascii_case("default")
    }
}

// ---------------------------------------------------------------- capture (JPEG)

/// Foreground-window keyframe as JPEG (quality 75). Never PrintWindow on a
/// hung app (it parks on the pump); BitBlt fallback always.
fn capture_keyframe(hwnd: HWND, dir: &Path, seq: u64) -> Option<(String, i32, i32, u64)> {
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return None;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 || w > 16_000 || h > 16_000 {
            return None;
        }
        let source = GetWindowDC(hwnd);
        if source.is_null() {
            return None;
        }
        let memory = CreateCompatibleDC(source);
        let bitmap = CreateCompatibleBitmap(source, w, h);
        if memory.is_null() || bitmap.is_null() {
            ReleaseDC(hwnd, source);
            return None;
        }
        let previous = SelectObject(memory, bitmap);
        if IsHungAppWindow(hwnd) == 0 {
            if PrintWindow(hwnd, memory, 0) == 0 {
                BitBlt(memory, 0, 0, w, h, source, 0, 0, SRCCOPY | CAPTUREBLT);
            }
        } else {
            BitBlt(memory, 0, 0, w, h, source, 0, 0, SRCCOPY | CAPTUREBLT);
        }
        let mut info: BITMAPINFO = mem::zeroed();
        info.bmiHeader.biSize = mem::size_of::<BITMAPINFOHEADER>() as DWORD;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h; // top-down
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bgra = vec![0u8; w as usize * h as usize * 4];
        let copied = GetDIBits(
            memory,
            bitmap,
            0,
            h as UINT,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(hwnd, source);
        if copied == 0 {
            return None;
        }
        let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
        for px in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        let mut jpeg = Vec::new();
        if jpeg_encoder::Encoder::new(&mut jpeg, 75)
            .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
            .is_err()
        {
            return None;
        }
        let name = format!("keyframe-{seq:05}.jpg");
        let path = dir.join(&name);
        let bytes = jpeg.len() as u64;
        fs::write(&path, &jpeg).ok()?;
        Some((name, w, h, bytes))
    }
}

// ---------------------------------------------------------------- helpers

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn window_title(hwnd: HWND) -> String {
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 || unsafe { IsHungAppWindow(hwnd) } != 0 {
        return String::new();
    }
    let mut length: usize = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXTLENGTH,
            0,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            300,
            &mut length,
        )
    } == 0
    {
        return String::new();
    }
    let mut buf = vec![0u16; (length + 1).min(1024)];
    let mut copied: usize = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            buf.len(),
            buf.as_mut_ptr() as LPARAM,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            300,
            &mut copied,
        )
    } == 0
    {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..copied.min(buf.len().saturating_sub(1))])
}

fn process_path(pid: DWORD) -> String {
    unsafe {
        let proc_ = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if proc_.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as DWORD;
        let ok = QueryFullProcessImageNameW(proc_, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(proc_);
        if ok == 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buf[..size as usize])
        }
    }
}

fn describe_window(hwnd: usize, cache: &mut HashMap<usize, (String, String)>) -> (String, String) {
    if let Some(hit) = cache.get(&hwnd) {
        return hit.clone();
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd as HWND, &mut pid) };
    let entry = (
        if pid != 0 {
            process_path(pid)
        } else {
            String::new()
        },
        window_title(hwnd as HWND),
    );
    if cache.len() < 512 {
        cache.insert(hwnd, entry.clone());
    }
    entry
}

/// Serialize an anchor with its alignment provenance. `value` only ever
/// appears for text-class, non-password controls.
fn anchor_json(u: &UiaFocus, alignment: &str, confidence: &str) -> String {
    let bounds = u
        .bounds
        .map(|r| format!("[{},{},{},{}]", r.left, r.top, r.right, r.bottom))
        .unwrap_or_else(|| "null".into());
    let value = match (&u.value, u.value_class) {
        (Some(v), "text") => format!(",\"value\":\"{}\"", json_escape(truncate(v, 400))),
        _ => String::new(),
    };
    format!(
        "\"anchor\":{{\"role\":\"{}\",\"control_type\":{},\"automation_id\":\"{}\",\"name\":\"{}\",\"name_localized\":true,\"is_password\":{},\"hwnd\":{},\"bounds\":{},\"value_class\":\"{}\"{},\"alignment\":\"{}\",\"confidence\":\"{}\"}}",
        u.role,
        u.control_type,
        json_escape(truncate(&u.automation_id, 120)),
        json_escape(truncate(&u.name, 120)),
        u.is_password,
        u.hwnd,
        bounds,
        u.value_class,
        value,
        alignment,
        confidence,
    )
}

fn stats_json(unix_ms_: u64) -> String {
    let count = CB_COUNT.load(Ordering::Relaxed);
    let total = CB_TOTAL_NS.load(Ordering::Relaxed);
    let max = CB_MAX_NS.load(Ordering::Relaxed);
    let (mut ws, mut peak, mut kernel, mut user) = (0usize, 0usize, 0u64, 0u64);
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = mem::zeroed();
        counters.cb = mem::size_of::<PROCESS_MEMORY_COUNTERS>() as DWORD;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0 {
            ws = counters.WorkingSetSize;
            peak = counters.PeakWorkingSetSize;
        }
        let (mut c, mut e, mut k, mut u) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) != 0 {
            kernel = k.as_u64() / 10_000;
            user = u.as_u64() / 10_000;
        }
    }
    format!(
        "{{\"t\":\"stats\",\"ts\":{unix_ms_},\"callbacks\":{count},\"cb_avg_us\":{},\"cb_max_us\":{},\"dropped\":{},\"coalesced_moves\":{},\"keyframes\":{},\"keyframe_bytes\":{},\"video_frames\":{},\"video_bytes\":{},\"video_gaps\":{},\"audio_bytes\":{},\"working_set_mb\":{:.1},\"peak_working_set_mb\":{:.1},\"cpu_kernel_ms\":{kernel},\"cpu_user_ms\":{user}}}",
        if count > 0 { total / count / 1000 } else { 0 },
        max / 1000,
        DROPPED.load(Ordering::Relaxed),
        COALESCED.load(Ordering::Relaxed),
        KEYFRAME_COUNT.load(Ordering::Relaxed),
        KEYFRAME_BYTES.load(Ordering::Relaxed),
        VIDEO_FRAMES.load(Ordering::Relaxed),
        VIDEO_BYTES.load(Ordering::Relaxed),
        VIDEO_GAPS.load(Ordering::Relaxed),
        AUDIO_BYTES.load(Ordering::Relaxed),
        ws as f64 / 1_048_576.0,
        peak as f64 / 1_048_576.0,
    )
}

fn is_password_context() -> bool {
    LATEST_FOCUS
        .lock()
        .ok()
        .and_then(|f| f.clone())
        .map(|(_, f)| f.is_password)
        .unwrap_or(false)
}

// ---------------------------------------------------------------- writer

fn writer_main(rx: mpsc::Receiver<Record>, path: &Path) {
    let mut file = match OpenOptions::new().create(true).append(true).open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[rec] cannot open {}: {e}", path.display());
            return;
        }
    };
    let mut cache: HashMap<usize, (String, String)> = HashMap::new();
    let mut password_window: usize = 0;
    // Latest usable focus anchor (for keystroke alignment): (focus_ts, anchor).
    let mut last_focus: Option<(u64, UiaFocus)> = None;
    while let Ok(record) = rx.recv() {
        let line = match record {
            Record::Hook {
                kind,
                unix_ms,
                event_time,
                injected,
                lower_il,
                vk_or_button,
                key_class,
                scan,
                extended,
                ctrl,
                shift,
                alt,
                win,
                x,
                y,
                wheel,
                fg,
            } => {
                if is_our_hwnd(fg) {
                    continue; // recorder's own UI is never demo content
                }
                let (app, title) = describe_window(fg, &mut cache);
                let base = format!(
                    "\"ts\":{unix_ms},\"event_time\":{event_time},\"injected\":{injected},\"lower_il\":{lower_il},\"fg\":{{\"hwnd\":{},\"app\":\"{}\",\"title\":\"{}\"}}",
                    fg,
                    json_escape(&app),
                    json_escape(truncate(&title, 120)),
                );
                if kind.starts_with("key") {
                    let pw = is_password_context();
                    if pw {
                        password_window = fg;
                    }
                    if pw || password_window == fg {
                        format!("{{\"t\":\"{kind}\",{base},\"redacted\":\"password-field\"}}")
                    } else {
                        // Keystroke anchor: latest focus snapshot, age-scored.
                        let anchor = match &last_focus {
                            Some((fts, u)) if unix_ms.saturating_sub(*fts) <= 2_000 => {
                                let confidence = if unix_ms.saturating_sub(*fts) <= 800 {
                                    "high"
                                } else {
                                    "low"
                                };
                                anchor_json(u, "focus", confidence)
                            }
                            _ => "\"anchor\":null,\"alignment\":\"none\"".to_string(),
                        };
                        format!(
                            "{{\"t\":\"{kind}\",{base},\"vk\":{vk_or_button},\"class\":\"{}\",\"scan\":{scan},\"extended\":{extended},\"mods\":{{\"ctrl\":{ctrl},\"shift\":{shift},\"alt\":{alt},\"win\":{win}}},{anchor}}}",
                            key_class.unwrap_or("other")
                        )
                    }
                } else {
                    // Click anchor: live ElementFromPoint (bounded 300ms). Moves
                    // and wheels skip the anchor to keep the writer fast.
                    let anchor = if kind == "mouse_down" || kind == "mouse_up" {
                        match uia_point_anchor(x, y) {
                            Some(u) => anchor_json(&u, "point", "high"),
                            None => "\"anchor\":null,\"alignment\":\"none\"".to_string(),
                        }
                    } else {
                        "\"anchor\":null,\"alignment\":\"none\"".to_string()
                    };
                    format!("{{\"t\":\"{kind}\",{base},\"button\":{vk_or_button},\"x\":{x},\"y\":{y},\"wheel\":{wheel},{anchor}}}")
                }
            }
            Record::Focus {
                unix_ms,
                trigger,
                hwnd,
                uia,
                secure_desktop,
            } => {
                if is_our_hwnd(hwnd) {
                    continue;
                }
                let (app, title) = describe_window(hwnd, &mut cache);
                let uia_json = match &uia {
                    Some(u) if u.error.is_none() => {
                        if u.is_password {
                            password_window = u.hwnd;
                            if password_window == 0 {
                                password_window = hwnd;
                            }
                        } else if trigger != "departed" {
                            // Key/click anchors track the CURRENT focus. A
                            // "departed" record re-reads an element focus has
                            // already LEFT (its value settles late); letting
                            // it refresh last_focus mis-anchors the next keys
                            // onto the previous control (Excel cells -> the
                            // dead in-cell editor).
                            last_focus = Some((unix_ms, u.clone()));
                        }
                        let bounds = u
                            .bounds
                            .map(|r| format!("[{},{},{},{}]", r.left, r.top, r.right, r.bottom))
                            .unwrap_or_else(|| "null".into());
                        let value = match (&u.value, u.value_class) {
                            (Some(v), "text") => {
                                format!(",\"value\":\"{}\"", json_escape(truncate(v, 400)))
                            }
                            _ => String::new(),
                        };
                        format!(
                            ",\"uia\":{{\"role\":\"{}\",\"control_type\":{},\"automation_id\":\"{}\",\"name\":\"{}\",\"name_localized\":true,\"is_password\":{},\"hwnd\":{},\"bounds\":{},\"value_class\":\"{}\"{}}}",
                            u.role,
                            u.control_type,
                            json_escape(truncate(&u.automation_id, 120)),
                            json_escape(truncate(&u.name, 120)),
                            u.is_password,
                            u.hwnd,
                            bounds,
                            u.value_class,
                            value,
                        )
                    }
                    Some(u) => format!(
                        ",\"uia\":{{\"error\":\"{}\"}}",
                        json_escape(u.error.as_deref().unwrap_or("unknown"))
                    ),
                    None => String::new(),
                };
                format!(
                    "{{\"t\":\"focus\",\"ts\":{unix_ms},\"trigger\":\"{trigger}\",\"secure_desktop\":{secure_desktop},\"hwnd\":{},\"app\":\"{}\",\"title\":\"{}\"{uia_json}}}",
                    hwnd,
                    json_escape(&app),
                    json_escape(truncate(&title, 120)),
                )
            }
            Record::Keyframe {
                unix_ms,
                hwnd,
                path,
                width,
                height,
                bytes,
                suppressed,
                reason,
            } => {
                format!(
                    "{{\"t\":\"keyframe\",\"ts\":{unix_ms},\"hwnd\":{},\"path\":\"{}\",\"width\":{width},\"height\":{height},\"bytes\":{bytes},\"suppressed\":{suppressed},\"reason\":\"{reason}\"}}",
                    hwnd,
                    json_escape(&path),
                )
            }
            Record::Note { unix_ms, text } => {
                format!(
                    "{{\"t\":\"note\",\"ts\":{unix_ms},\"source\":\"dialog\",\"text\":\"{}\"}}",
                    json_escape(&text)
                )
            }
            Record::Stats { unix_ms } => stats_json(unix_ms),
            Record::Marker { unix_ms, text } => {
                format!(
                    "{{\"t\":\"marker\",\"ts\":{unix_ms},\"text\":\"{}\"}}",
                    json_escape(&text)
                )
            }
            Record::Media {
                unix_ms,
                kind,
                status,
                detail,
            } => {
                format!(
                    "{{\"t\":\"media\",\"ts\":{unix_ms},\"kind\":\"{kind}\",\"status\":\"{status}\",\"detail\":\"{}\"}}",
                    json_escape(&detail)
                )
            }
        };
        if writeln!(file, "{line}").is_err() {
            break;
        }
        // Flush every line: a killed process must leave a readable partial file.
        let _ = file.flush();
    }
    let _ = file.flush();
}

// ---------------------------------------------------------------- note dialog + REC indicator

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read the note edit, submit a note record, clear and hide. Called from the
/// note window's own thread (the main message loop).
fn submit_note() {
    let edit = NOTE_EDIT.load(Ordering::Relaxed) as HWND;
    if edit.is_null() {
        return;
    }
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(edit, buf.as_mut_ptr(), buf.len() as i32) };
    let text = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
    let text = text.trim().to_string();
    let note_hwnd = NOTE_HWND.load(Ordering::Relaxed) as HWND;
    if text.is_empty() {
        unsafe { ShowWindow(note_hwnd, SW_HIDE as i32) };
        return;
    }
    enqueue(Record::Note {
        unix_ms: unix_ms(),
        text: text.clone(),
    });
    NOTE_KEYFRAME.store(true, Ordering::Relaxed);
    println!("[rec] note added: {}", truncate(&text, 80));
    unsafe {
        SetWindowTextW(edit, to_wide("").as_ptr());
        ShowWindow(note_hwnd, SW_HIDE as i32);
    }
}

unsafe extern "system" fn note_edit_proc(
    hwnd: HWND,
    msg: UINT,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_KEYDOWN {
        if wparam as u32 == VK_RETURN {
            submit_note();
            return 0;
        }
        if wparam as u32 == VK_ESCAPE {
            let note_hwnd = NOTE_HWND.load(Ordering::Relaxed) as HWND;
            unsafe { ShowWindow(note_hwnd, SW_HIDE as i32) };
            return 0;
        }
    }
    let orig = NOTE_EDIT_ORIG.load(Ordering::Relaxed) as *const c_void;
    unsafe { CallWindowProcW(orig, hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn note_wnd_proc(
    hwnd: HWND,
    msg: UINT,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_COMMAND {
        let id = (wparam & 0xffff) as u32;
        if id == 102 {
            submit_note();
            return 0;
        }
    }
    if msg == WM_CLOSE {
        unsafe { ShowWindow(hwnd, SW_HIDE as i32) };
        return 0;
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn register_window_classes() {
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let cursor = unsafe { LoadCursorW(ptr::null_mut(), 32512 as usize as *const u16) };
    let note_class = to_wide("FastCuaSkillNoteWnd");
    let note_wnd = WNDCLASSW {
        style: 0,
        lpfnWndProc: note_wnd_proc as *const c_void,
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: ptr::null_mut(),
        hCursor: cursor,
        hbrBackground: unsafe { GetSysColorBrush(15) }, // COLOR_BTNFACE
        lpszMenuName: ptr::null(),
        lpszClassName: note_class.as_ptr(),
    };
    unsafe { RegisterClassW(&note_wnd) };
}

/// Create (once) and show the narration note box; focus its edit control.
fn show_note_window() {
    let existing = NOTE_HWND.load(Ordering::Relaxed) as HWND;
    if !existing.is_null() && unsafe { IsWindow(existing) } != 0 {
        unsafe {
            ShowWindow(existing, SW_SHOW as i32);
            BringWindowToTop(existing);
            SetForegroundWindow(existing);
            SetFocus(NOTE_EDIT.load(Ordering::Relaxed) as HWND);
        }
        return;
    }
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let class = to_wide("FastCuaSkillNoteWnd");
    let title = to_wide("FastCUA Skill Recorder Note");
    let x = (unsafe { GetSystemMetrics(SM_CXSCREEN) } - 460) / 2;
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class.as_ptr(),
            title.as_ptr(),
            WS_CAPTION | WS_SYSMENU | WS_OVERLAPPED,
            x.max(0),
            120,
            460,
            120,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null_mut(),
        )
    };
    if hwnd.is_null() {
        eprintln!("[rec] note window creation failed");
        return;
    }
    let edit_class = to_wide("EDIT");
    let edit = unsafe {
        CreateWindowExW(
            WS_EX_CLIENTEDGE,
            edit_class.as_ptr(),
            ptr::null(),
            WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
            10,
            10,
            330,
            24,
            hwnd,
            101 as HANDLE,
            instance,
            ptr::null_mut(),
        )
    };
    let button_class = to_wide("BUTTON");
    let button_text = to_wide("Add note");
    unsafe {
        CreateWindowExW(
            0,
            button_class.as_ptr(),
            button_text.as_ptr(),
            WS_CHILD | WS_VISIBLE,
            348,
            10,
            92,
            24,
            hwnd,
            102 as HANDLE,
            instance,
            ptr::null_mut(),
        )
    };
    let orig =
        unsafe { SetWindowLongPtrW(edit, GWLP_WNDPROC, note_edit_proc as *const c_void as isize) };
    NOTE_EDIT_ORIG.store(orig as usize, Ordering::Relaxed);
    NOTE_EDIT.store(edit as usize, Ordering::Relaxed);
    NOTE_HWND.store(hwnd as usize, Ordering::Relaxed);
    println!("[rec] note box open — type intent/exception, Enter to attach, Esc to cancel");
    unsafe {
        ShowWindow(hwnd, SW_SHOW as i32);
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        SetFocus(edit);
    }
}

/// Persistent on-top indicator: the visible "you are being recorded" signal.
fn create_indicator() -> HWND {
    let class = to_wide("STATIC");
    let text = to_wide(
        "REC ● FastCUA Skill Recorder — Ctrl+Alt+N note · Ctrl+Alt+R pause · Ctrl+Alt+X stop",
    );
    let w = 560;
    let x = (unsafe { GetSystemMetrics(SM_CXSCREEN) } - w) / 2;
    unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class.as_ptr(),
            text.as_ptr(),
            WS_POPUP | WS_VISIBLE | SS_CENTER,
            x.max(0),
            0,
            w,
            22,
            ptr::null_mut(),
            ptr::null_mut(),
            GetModuleHandleW(ptr::null()),
            ptr::null_mut(),
        )
    }
}

// ---------------------------------------------------------------- poller

fn poller_main(
    wake_rx: mpsc::Receiver<()>,
    keyframe_dir: PathBuf,
    poll_ms: u64,
    keyframe_interval_s: u64,
) {
    let mut last_poll = Instant::now() - Duration::from_secs(1);
    // Per-class keyframe throttles. User-intent frames (note/action) are
    // throttled against their own class only, so an incidental focus frame
    // can never starve a click or narration marker (fast demos click within
    // seconds of focus changes).
    let mut last_kf_auto = Instant::now() - Duration::from_secs(3600);
    let mut last_kf_note = Instant::now() - Duration::from_secs(3600);
    let mut last_kf_action = Instant::now() - Duration::from_secs(3600);
    let mut keyframe_seq = 0u64;
    let mut last_focus_hwnd: HWND = ptr::null_mut();
    // Previous tick's focused element (owned) + recently-departed text
    // controls whose committed value we keep re-reading until it settles or
    // the deadline passes. This is how Excel cell text is captured: the cell
    // element persists after the in-cell editor closes, and its ValuePattern
    // starts returning the committed content a tick later.
    struct PendingValue {
        element: ComPtr,
        uia: UiaFocus,
        deadline: Instant,
    }
    let mut previous: Option<(ComPtr, UiaFocus)> = None;
    let mut pendings: Vec<PendingValue> = Vec::new();
    loop {
        let _ = wake_rx.recv_timeout(Duration::from_millis(poll_ms));
        while wake_rx.try_recv().is_ok() {}
        let secure = input_desktop_is_secure();
        let (snapshot, departed): (Option<UiaFocus>, Vec<UiaFocus>) = if secure {
            (None, Vec::new())
        } else {
            let pending_ptrs: Vec<(ComPtr, i32, i32, i32, String)> = pendings
                .iter()
                .map(|p| {
                    let (cx, cy) = p
                        .uia
                        .bounds
                        .map(|r| ((r.left + r.right) / 2, (r.top + r.bottom) / 2))
                        .unwrap_or((0, 0));
                    (
                        p.element,
                        cx,
                        cy,
                        p.uia.control_type,
                        p.uia.automation_id.clone(),
                    )
                })
                .collect();
            match uia_focus_snapshot(&pending_ptrs) {
                Some((snap, new_element, values)) => {
                    let now = Instant::now();
                    let mut departed: Vec<UiaFocus> = Vec::new();
                    let mut keep: Vec<PendingValue> = Vec::new();
                    for (mut p, value) in pendings.into_iter().zip(values) {
                        let settled = match (&value, &p.uia.value) {
                            (Some(v), initial) => initial.as_ref() != Some(v),
                            (None, _) => false,
                        };
                        if settled {
                            p.uia.value = value;
                            departed.push(p.uia);
                            unsafe { release(p.element) };
                        } else if now >= p.deadline {
                            // Value never settled (dead editor, unchanged
                            // empty cell) — emit whatever we last read so the
                            // compiler sees a terminal snapshot.
                            if let Some(v) = value.or(p.uia.value.clone()) {
                                p.uia.value = Some(v);
                                departed.push(p.uia);
                            }
                            unsafe { release(p.element) };
                        } else {
                            keep.push(p);
                        }
                    }
                    pendings = keep;
                    // Focus moved? The departed text control becomes pending
                    // (its value settles on a later tick).
                    let prev_identity = previous
                        .as_ref()
                        .map(|(_, u)| (u.control_type, u.automation_id.clone(), u.name.clone()));
                    let new_identity = snap
                        .as_ref()
                        .filter(|s| s.error.is_none())
                        .map(|s| (s.control_type, s.automation_id.clone(), s.name.clone()));
                    let moved = prev_identity != new_identity;
                    if moved {
                        if let Some((prev_ptr, prev_uia)) = previous.take() {
                            if prev_uia.value_class == "text" && !prev_uia.is_password {
                                // Replace any older pending entry for the same
                                // element identity (dedup).
                                pendings.retain(|p| {
                                    let same = p.uia.control_type == prev_uia.control_type
                                        && p.uia.automation_id == prev_uia.automation_id
                                        && p.uia.name == prev_uia.name;
                                    if same {
                                        unsafe { release(p.element) };
                                    }
                                    !same
                                });
                                if pendings.len() >= 4 {
                                    let evicted = pendings.remove(0);
                                    unsafe { release(evicted.element) };
                                }
                                pendings.push(PendingValue {
                                    element: prev_ptr,
                                    uia: prev_uia,
                                    deadline: now + Duration::from_millis(2500),
                                });
                            } else {
                                unsafe { release(prev_ptr) };
                            }
                        }
                    } else if let Some((prev_ptr, _)) = previous.take() {
                        // Same element still focused: keep the NEWER pointer,
                        // release the older one.
                        unsafe { release(prev_ptr) };
                    }
                    previous = match (new_element.is_null(), &snap) {
                        (false, Some(u)) if u.error.is_none() => Some((new_element, u.clone())),
                        _ => {
                            if !new_element.is_null() {
                                unsafe { release(new_element) };
                            }
                            None
                        }
                    };
                    (snap, departed)
                }
                None => {
                    // Timed out: the hung worker may still be reading the
                    // pending pointers — leak them, never reuse.
                    pendings = Vec::new();
                    if let Some((p, _)) = previous.take() {
                        unsafe { release(p) };
                    }
                    (None, Vec::new())
                }
            }
        };
        let focus_hwnd: HWND = snapshot
            .as_ref()
            .filter(|s| s.error.is_none() && s.hwnd != 0)
            .map(|s| s.hwnd as HWND)
            .unwrap_or(unsafe { GetForegroundWindow() });
        let ours = is_our_hwnd(focus_hwnd as usize);
        let changed = focus_hwnd != last_focus_hwnd;
        last_focus_hwnd = focus_hwnd;
        if let Ok(mut latest) = LATEST_FOCUS.lock() {
            *latest = snapshot.clone().map(|s| (unix_ms(), s));
        }
        if !ours && !secure {
            for old in departed {
                enqueue(Record::Focus {
                    unix_ms: unix_ms(),
                    trigger: "departed",
                    hwnd: focus_hwnd as usize,
                    uia: Some(old),
                    secure_desktop: false,
                });
            }
        }
        if !ours && (changed || last_poll.elapsed() >= Duration::from_millis(1000)) {
            last_poll = Instant::now();
            enqueue(Record::Focus {
                unix_ms: unix_ms(),
                trigger: if secure {
                    "secure_desktop"
                } else if changed {
                    "focus_change"
                } else {
                    "heartbeat"
                },
                hwnd: focus_hwnd as usize,
                uia: snapshot.clone(),
                secure_desktop: secure,
            });
        }
        // Sparse keyframes: note > action > focus change > periodic. JPEG keeps
        // the cost target (< 2 MB/min) reachable; password context suppresses.
        // Intent frames (note/action) stay pending while capture is blocked
        // (our own window focused, secure desktop, no focus) and are retried
        // on the next loop instead of being dropped.
        let blocked = secure || ours || focus_hwnd.is_null();
        let note_pending = NOTE_KEYFRAME.load(Ordering::Relaxed);
        let action_pending = ACTION_KEYFRAME.load(Ordering::Relaxed);
        let periodic_due = last_kf_auto.elapsed() >= Duration::from_secs(keyframe_interval_s);
        let (due, reason): (bool, &'static str) = if blocked {
            (false, "periodic")
        } else if note_pending && last_kf_note.elapsed() >= Duration::from_millis(1_000) {
            (true, "note")
        } else if action_pending && last_kf_action.elapsed() >= Duration::from_millis(1_500) {
            (true, "action")
        } else if changed && last_kf_auto.elapsed() >= Duration::from_millis(3_000) {
            (true, "focus")
        } else if periodic_due {
            (true, "periodic")
        } else {
            (false, "periodic")
        };
        if due {
            match reason {
                "note" => {
                    NOTE_KEYFRAME.store(false, Ordering::Relaxed);
                    last_kf_note = Instant::now();
                }
                "action" => {
                    ACTION_KEYFRAME.store(false, Ordering::Relaxed);
                    last_kf_action = Instant::now();
                }
                _ => last_kf_auto = Instant::now(),
            }
            if is_password_context() {
                enqueue(Record::Keyframe {
                    unix_ms: unix_ms(),
                    hwnd: focus_hwnd as usize,
                    path: String::new(),
                    width: 0,
                    height: 0,
                    bytes: 0,
                    suppressed: true,
                    reason,
                });
            } else {
                keyframe_seq += 1;
                let result = capture_keyframe(focus_hwnd, &keyframe_dir, keyframe_seq);
                if let Some((_, _, _, bytes)) = &result {
                    KEYFRAME_COUNT.fetch_add(1, Ordering::Relaxed);
                    KEYFRAME_BYTES.fetch_add(*bytes, Ordering::Relaxed);
                }
                enqueue(Record::Keyframe {
                    unix_ms: unix_ms(),
                    hwnd: focus_hwnd as usize,
                    path: result
                        .as_ref()
                        .map(|(n, _, _, _)| n.clone())
                        .unwrap_or_default(),
                    width: result.as_ref().map(|(_, w, _, _)| *w).unwrap_or(0),
                    height: result.as_ref().map(|(_, _, h, _)| *h).unwrap_or(0),
                    bytes: result.as_ref().map(|(_, _, _, b)| *b).unwrap_or(0),
                    suppressed: false,
                    reason,
                });
            }
        }
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }
    }
}

unsafe extern "system" fn ctrl_handler(_event: DWORD) -> BOOL {
    SHUTDOWN.store(true, Ordering::Relaxed);
    unsafe {
        PostThreadMessageW(MAIN_THREAD.load(Ordering::Relaxed) as DWORD, WM_QUIT, 0, 0);
    }
    TRUE
}

// ---------------------------------------------------------------- main

// ---------------------------------------------------------------- video (MJPEG-in-AVI)

const HALFTONE: i32 = 4;

/// Hand-rolled RIFF AVI writer for MJPEG (zero-dependency). Frames are JPEG
/// chunks ('00dc'); sizes and the idx1 table are patched/written at finalize.
struct AviWriter {
    file: fs::File,
    frames: u32,
    max_frame: u32,
    movi_fourcc_pos: u64,
    riff_size_pos: u64,
    total_frames_pos: u64,
    avih_suggested_pos: u64,
    strh_length_pos: u64,
    strh_suggested_pos: u64,
    movi_size_pos: u64,
    index: Vec<(u32, u32)>,
}

impl AviWriter {
    fn pos(&mut self) -> std::io::Result<u64> {
        self.file.stream_position()
    }
    fn raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.file.write_all(bytes)
    }
    fn w32(&mut self, value: u32) -> std::io::Result<()> {
        self.file.write_all(&value.to_le_bytes())
    }
    fn w16(&mut self, value: u16) -> std::io::Result<()> {
        self.file.write_all(&value.to_le_bytes())
    }
    fn patch_at(&mut self, pos: u64, value: u32) -> std::io::Result<()> {
        let end = self.file.stream_position()?;
        self.file.seek(SeekFrom::Start(pos))?;
        self.file.write_all(&value.to_le_bytes())?;
        self.file.seek(SeekFrom::Start(end))?;
        Ok(())
    }

    fn create(path: &Path, w: i32, h: i32, fps: u32) -> std::io::Result<Self> {
        let file = fs::File::create(path)?;
        let mut aw = AviWriter {
            file,
            frames: 0,
            max_frame: 0,
            movi_fourcc_pos: 0,
            riff_size_pos: 0,
            total_frames_pos: 0,
            avih_suggested_pos: 0,
            strh_length_pos: 0,
            strh_suggested_pos: 0,
            movi_size_pos: 0,
            index: Vec::new(),
        };
        aw.raw(b"RIFF")?;
        aw.riff_size_pos = aw.pos()?;
        aw.w32(0)?;
        aw.raw(b"AVI ")?;
        // hdrl
        aw.raw(b"LIST")?;
        let hdrl_size_pos = aw.pos()?;
        aw.w32(0)?;
        let hdrl_start = aw.pos()?;
        aw.raw(b"hdrl")?;
        aw.raw(b"avih")?;
        aw.w32(56)?;
        aw.w32(1_000_000 / fps)?; // µs per frame
        aw.w32(0)?; // max bytes/sec (unknown)
        aw.w32(0)?; // padding granularity
        aw.w32(0x10)?; // AVIF_HASINDEX
        aw.total_frames_pos = aw.pos()?;
        aw.w32(0)?;
        aw.w32(0)?; // initial frames
        aw.w32(1)?; // streams
        aw.avih_suggested_pos = aw.pos()?;
        aw.w32(0)?;
        aw.w32(w as u32)?;
        aw.w32(h as u32)?;
        for _ in 0..4 {
            aw.w32(0)?;
        }
        // strl
        aw.raw(b"LIST")?;
        let strl_size_pos = aw.pos()?;
        aw.w32(0)?;
        let strl_start = aw.pos()?;
        aw.raw(b"strl")?;
        aw.raw(b"strh")?;
        aw.w32(56)?;
        aw.raw(b"vids")?;
        aw.raw(b"MJPG")?;
        aw.w32(0)?; // flags
        aw.w16(0)?; // priority
        aw.w16(0)?; // language
        aw.w32(0)?; // initial frames
        aw.w32(1)?; // scale
        aw.w32(fps)?; // rate
        aw.w32(0)?; // start
        aw.strh_length_pos = aw.pos()?;
        aw.w32(0)?;
        aw.strh_suggested_pos = aw.pos()?;
        aw.w32(0)?;
        aw.w32(0xFFFF_FFFF)?; // quality = default
        aw.w32(0)?; // sample size
        aw.w16(0)?;
        aw.w16(0)?;
        aw.w16(w as u16)?;
        aw.w16(h as u16)?; // rcFrame
                           // strf (BITMAPINFOHEADER)
        aw.raw(b"strf")?;
        aw.w32(40)?;
        aw.w32(40)?;
        aw.w32(w as u32)?;
        aw.w32(h as u32)?;
        aw.w16(1)?; // planes
        aw.w16(24)?; // bit count
        aw.raw(b"MJPG")?; // compression fourcc
        aw.w32((w * h * 3) as u32)?; // size image
        aw.w32(0)?;
        aw.w32(0)?;
        aw.w32(0)?;
        aw.w32(0)?;
        let strl_end = aw.pos()?;
        aw.patch_at(strl_size_pos, (strl_end - strl_start) as u32)?;
        let hdrl_end = aw.pos()?;
        aw.patch_at(hdrl_size_pos, (hdrl_end - hdrl_start) as u32)?;
        // movi
        aw.raw(b"LIST")?;
        aw.movi_size_pos = aw.pos()?;
        aw.w32(0)?;
        aw.movi_fourcc_pos = aw.pos()?;
        aw.raw(b"movi")?;
        Ok(aw)
    }

    /// Append one JPEG frame. Returns (absolute file offset of the JPEG bytes,
    /// byte length) for the sidecar extraction index.
    fn write_frame(&mut self, jpeg: &[u8]) -> std::io::Result<(u64, u32)> {
        let chunk_pos = self.pos()?;
        let idx_off = (chunk_pos - self.movi_fourcc_pos) as u32; // first chunk = 4
        self.raw(b"00dc")?;
        self.w32(jpeg.len() as u32)?;
        let data_pos = self.pos()?;
        self.file.write_all(jpeg)?;
        if jpeg.len() % 2 == 1 {
            self.file.write_all(&[0])?;
        }
        self.frames += 1;
        self.max_frame = self.max_frame.max(jpeg.len() as u32);
        self.index.push((idx_off, jpeg.len() as u32));
        Ok((data_pos, jpeg.len() as u32))
    }

    fn finalize(mut self) -> std::io::Result<()> {
        let chunks_end = self.pos()?;
        self.raw(b"idx1")?;
        self.w32((self.index.len() * 16) as u32)?;
        for (off, len) in self.index.clone() {
            self.raw(b"00dc")?;
            self.w32(0x10)?; // AVIIF_KEYFRAME
            self.w32(off)?;
            self.w32(len)?;
        }
        let end = self.pos()?;
        self.patch_at(
            self.movi_size_pos,
            (chunks_end - self.movi_fourcc_pos) as u32,
        )?;
        self.patch_at(self.riff_size_pos, (end - 8) as u32)?;
        self.patch_at(self.total_frames_pos, self.frames)?;
        self.patch_at(self.strh_length_pos, self.frames)?;
        self.patch_at(self.avih_suggested_pos, self.max_frame)?;
        self.patch_at(self.strh_suggested_pos, self.max_frame)?;
        self.file.flush()
    }
}

fn scaled_canvas(w: i32, h: i32, max_edge: i32) -> (i32, i32) {
    let long = w.max(h) as f64;
    let scale = if long > max_edge as f64 {
        max_edge as f64 / long
    } else {
        1.0
    };
    let cw = ((w as f64 * scale) as i32) & !1;
    let ch = ((h as f64 * scale) as i32) & !1;
    (cw.max(2), ch.max(2))
}

fn encode_rgb_jpeg(rgb: &[u8], w: i32, h: i32, quality: u8) -> Option<Vec<u8>> {
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, quality)
        .encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .ok()?;
    Some(jpeg)
}

fn encode_black_jpeg(w: i32, h: i32, quality: u8) -> Vec<u8> {
    let rgb = vec![0u8; (w as usize) * (h as usize) * 3];
    encode_rgb_jpeg(&rgb, w, h, quality).unwrap_or_default()
}

/// Capture a window into a fixed cw x ch canvas (HALFTONE stretch) and encode
/// JPEG. MJPEG-in-AVI needs dimension-stable frames; the canvas is fixed by
/// the first captured window.
/// Capture the FULL PRIMARY SCREEN (physical pixels — the recorder declares
/// PMv2 awareness at startup) into the fixed canvas via HALFTONE StretchBlt,
/// then JPEG-encode. Screen-DC BitBlt composites every window type —
/// PrintWindow on a single window returns black for hardware-accelerated
/// apps (Chromium/Electron), which is exactly what a demo video cannot risk.
unsafe fn capture_screen_scaled_jpeg(cw: i32, ch: i32, quality: u8) -> Option<Vec<u8>> {
    let w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    if w <= 0 || h <= 0 {
        return None;
    }
    unsafe {
        let screen = GetDC(ptr::null_mut());
        if screen.is_null() {
            return None;
        }
        let src_dc = CreateCompatibleDC(screen);
        let src_bmp = CreateCompatibleBitmap(screen, w, h);
        let dst_dc = CreateCompatibleDC(screen);
        let dst_bmp = CreateCompatibleBitmap(screen, cw, ch);
        if src_dc.is_null() || src_bmp.is_null() || dst_dc.is_null() || dst_bmp.is_null() {
            if !src_bmp.is_null() {
                DeleteObject(src_bmp);
            }
            if !dst_bmp.is_null() {
                DeleteObject(dst_bmp);
            }
            if !src_dc.is_null() {
                DeleteDC(src_dc);
            }
            if !dst_dc.is_null() {
                DeleteDC(dst_dc);
            }
            ReleaseDC(ptr::null_mut(), screen);
            return None;
        }
        let prev_src = SelectObject(src_dc, src_bmp);
        BitBlt(src_dc, 0, 0, w, h, screen, 0, 0, SRCCOPY | CAPTUREBLT);
        let prev_dst = SelectObject(dst_dc, dst_bmp);
        SetStretchBltMode(dst_dc, HALFTONE);
        StretchBlt(dst_dc, 0, 0, cw, ch, src_dc, 0, 0, w, h, SRCCOPY);
        let mut info: BITMAPINFO = mem::zeroed();
        info.bmiHeader.biSize = mem::size_of::<BITMAPINFOHEADER>() as DWORD;
        info.bmiHeader.biWidth = cw;
        info.bmiHeader.biHeight = -ch; // top-down
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut bgra = vec![0u8; cw as usize * ch as usize * 4];
        let copied = GetDIBits(
            dst_dc,
            dst_bmp,
            0,
            ch as UINT,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(src_dc, prev_src);
        SelectObject(dst_dc, prev_dst);
        DeleteObject(src_bmp);
        DeleteObject(dst_bmp);
        DeleteDC(src_dc);
        DeleteDC(dst_dc);
        ReleaseDC(ptr::null_mut(), screen);
        if copied == 0 {
            return None;
        }
        let mut rgb = Vec::with_capacity(cw as usize * ch as usize * 3);
        for px in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        encode_rgb_jpeg(&rgb, cw, ch, quality)
    }
}

fn video_index_line(
    file: &mut Option<fs::File>,
    i: u64,
    kind: &str,
    reason: Option<&str>,
    off: u64,
    len: u32,
) {
    if let Some(f) = file.as_mut() {
        let reason_json = reason
            .map(|r| format!(",\"reason\":\"{r}\""))
            .unwrap_or_default();
        let _ = writeln!(
            f,
            "{{\"i\":{i},\"ts\":{},\"kind\":\"{kind}\"{reason_json},\"off\":{off},\"len\":{len}}}",
            unix_ms()
        );
        let _ = f.flush();
    }
}

/// Video thread: ~fps frames of the PRIMARY SCREEN into a single MJPEG-AVI +
/// a JSONL extraction/redaction index. Ticks where the foreground window is
/// one of OUR OWN windows (note dialog) are skipped, so the recorder never
/// records itself. Password focus and the secure desktop get marked black
/// gap frames — pixels are NEVER captured in a secret context (same policy
/// as keyframes, equal force). The topmost REC indicator stays visible in
/// frames on purpose: it is the on-tape proof that recording was active.
fn video_main(video_dir: PathBuf, fps: u32, max_edge: i32, quality: u8) {
    let frame_dur = Duration::from_millis((1000 / fps.max(1)) as u64);
    let avi_path = video_dir.join("video.avi");
    let index_path = video_dir.join("index.jsonl");
    let mut index_file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&index_path)
    {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("[rec] video index unavailable: {e}");
            None
        }
    };
    let mut writer: Option<AviWriter> = None;
    let mut canvas: Option<(i32, i32)> = None;
    let mut black: Option<Vec<u8>> = None;
    let mut frame_no: u64 = 0;
    let mut indexed_header = false;
    loop {
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }
        let tick = Instant::now();
        if RECORDING.load(Ordering::Relaxed) {
            let secure = input_desktop_is_secure();
            let password = !secure && is_password_context();
            let fg = unsafe { GetForegroundWindow() };
            let ours = is_our_hwnd(fg as usize);
            // Canvas follows the primary screen, not a window: the demo video
            // is a SCREEN recording (taskbar, dialogs and all), and screen-DC
            // capture is the only path that composites hardware-accelerated
            // windows correctly.
            let (sw, sh) =
                unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
            if secure || password {
                let reason = if secure {
                    "secure-desktop"
                } else {
                    "password-focus"
                };
                if canvas.is_none() && sw > 0 && sh > 0 {
                    canvas = Some(scaled_canvas(sw, sh, max_edge));
                }
                if let Some((cw, ch)) = canvas {
                    if writer.is_none() {
                        writer = AviWriter::create(&avi_path, cw, ch, fps).ok();
                    }
                    if let Some(avi) = writer.as_mut() {
                        let jpg = black
                            .get_or_insert_with(|| encode_black_jpeg(cw, ch, quality))
                            .clone();
                        if !jpg.is_empty() {
                            if let Ok((off, len)) = avi.write_frame(&jpg) {
                                VIDEO_FRAMES.fetch_add(1, Ordering::Relaxed);
                                VIDEO_GAPS.fetch_add(1, Ordering::Relaxed);
                                VIDEO_BYTES.fetch_add(len as u64, Ordering::Relaxed);
                                video_index_line(
                                    &mut index_file,
                                    frame_no,
                                    "redacted-gap",
                                    Some(reason),
                                    off,
                                    len,
                                );
                                frame_no += 1;
                            }
                        }
                    }
                } else {
                    VIDEO_GAPS.fetch_add(1, Ordering::Relaxed);
                    video_index_line(
                        &mut index_file,
                        frame_no,
                        "redacted-gap-no-canvas",
                        Some(reason),
                        0,
                        0,
                    );
                    frame_no += 1;
                }
            } else if !ours && sw > 0 && sh > 0 {
                let (cw, ch) = *canvas.get_or_insert_with(|| scaled_canvas(sw, sh, max_edge));
                if writer.is_none() {
                    writer = AviWriter::create(&avi_path, cw, ch, fps).ok();
                }
                if let Some(avi) = writer.as_mut() {
                    if !indexed_header {
                        if let Some(f) = index_file.as_mut() {
                            let _ = writeln!(
                                f,
                                "{{\"t\":\"video-index\",\"format\":\"fastcua-video-index/1\",\"avi\":\"video.avi\",\"fps\":{fps},\"width\":{cw},\"height\":{ch}}}"
                            );
                            let _ = f.flush();
                        }
                        indexed_header = true;
                    }
                    if let Some(jpg) = unsafe { capture_screen_scaled_jpeg(cw, ch, quality) } {
                        if let Ok((off, len)) = avi.write_frame(&jpg) {
                            VIDEO_FRAMES.fetch_add(1, Ordering::Relaxed);
                            VIDEO_BYTES.fetch_add(len as u64, Ordering::Relaxed);
                            video_index_line(&mut index_file, frame_no, "frame", None, off, len);
                            frame_no += 1;
                        }
                    }
                }
            }
            // our own foreground windows (note dialog): tick skipped
        }
        let elapsed = tick.elapsed();
        if elapsed < frame_dur {
            thread::sleep(frame_dur - elapsed);
        }
    }
    if let Some(avi) = writer {
        let _ = avi.finalize();
    }
    if let Some(f) = index_file.as_mut() {
        let _ = writeln!(f, "{{\"t\":\"video-footer\",\"frames\":{frame_no}}}");
        let _ = f.flush();
    }
}

// ---------------------------------------------------------------- audio (WASAPI)

const CLSID_MM_DEVICE_ENUMERATOR: Guid = Guid {
    data1: 0xbcde0395,
    data2: 0xe52f,
    data3: 0x467c,
    data4: [0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e],
};
const IID_IMM_DEVICE_ENUMERATOR: Guid = Guid {
    data1: 0xa95664d2,
    data2: 0x9614,
    data3: 0x4f35,
    data4: [0xa7, 0x46, 0xde, 0x8d, 0xb6, 0x36, 0x17, 0xe6],
};
const IID_IAUDIO_CLIENT: Guid = Guid {
    data1: 0x1cb9ad4c,
    data2: 0xdbfa,
    data3: 0x4c32,
    data4: [0xb1, 0x78, 0xc2, 0xf5, 0x68, 0xa7, 0x03, 0xb2],
};
const IID_IAUDIO_CAPTURE_CLIENT: Guid = Guid {
    data1: 0xc8adbd64,
    data2: 0xe71e,
    data3: 0x48a0,
    data4: [0xa4, 0xde, 0x18, 0x5c, 0x39, 0x5c, 0xd3, 0x17],
};

const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM: u32 = 0x8000_0000;
const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY: u32 = 0x0800_0000;
const AUDCLNT_BUFFERFLAGS_SILENT: u32 = 0x2;

// UIA ValuePattern: lets the recorder read committed values from VIRTUAL
// elements (hwnd == 0) such as Excel cells (DataItem #A1) where WM_GETTEXT
// has no window to talk to. Same vtable map as the native host (verified
// there): IUIAutomationElement::GetCurrentPattern slot 16,
// IUIAutomationValuePattern::get_CurrentValue slot 4.
const UIA_VALUE_PATTERN_ID: i32 = 10002;
const IID_IUIAUTOMATION_VALUE_PATTERN: Guid = Guid {
    data1: 0xa94cd8b1,
    data2: 0x0844,
    data3: 0x4cd6,
    data4: [0x9d, 0x2d, 0x64, 0x05, 0x37, 0xab, 0x39, 0xe9],
};

#[repr(C)]
struct WaveFormatEx {
    tag: u16,
    channels: u16,
    samples_per_sec: u32,
    avg_bytes_per_sec: u32,
    block_align: u16,
    bits_per_sample: u16,
    cb_size: u16,
}

fn audio_main(path: PathBuf) {
    match unsafe { audio_capture(&path) } {
        Ok(bytes) => {
            AUDIO_BYTES.store(bytes, Ordering::Relaxed);
            println!("[rec] audio: {bytes} bytes -> {}", path.display());
        }
        Err(reason) => {
            // Graceful degradation: audio is additive; the session must never
            // fail because a microphone is missing, busy, or denied.
            println!("[rec] audio unavailable (recording continues without it): {reason}");
            enqueue(Record::Media {
                unix_ms: unix_ms(),
                kind: "audio",
                status: "unavailable",
                detail: reason,
            });
        }
    }
}

unsafe fn audio_capture(path: &Path) -> Result<u64, String> {
    let init = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_MULTITHREADED) };
    if init < 0 && init != RPC_E_CHANGED_MODE {
        return Err(format!("CoInitializeEx 0x{:08x}", init as u32));
    }
    let result = unsafe { audio_capture_inner(path) };
    if init == 0 || init == 1 {
        unsafe { CoUninitialize() };
    }
    if result.is_err() {
        // Contract: no WAV file means the track was unavailable. Drop the
        // header-only stub so reviewers never see a 44-byte decoy.
        let _ = fs::remove_file(path);
    }
    result
}

unsafe fn audio_capture_inner(path: &Path) -> Result<u64, String> {
    let mut file = fs::File::create(path).map_err(|e| format!("create wav: {e}"))?;
    // Canonical PCM header; sizes patched at finalize.
    let mut fmt = Vec::with_capacity(16);
    fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
    fmt.extend_from_slice(&1u16.to_le_bytes()); // mono
    fmt.extend_from_slice(&16_000u32.to_le_bytes());
    fmt.extend_from_slice(&32_000u32.to_le_bytes());
    fmt.extend_from_slice(&2u16.to_le_bytes()); // block align
    fmt.extend_from_slice(&16u16.to_le_bytes()); // bits
    file.write_all(b"RIFF\0\0\0\0WAVEfmt \x10\0\0\0")
        .map_err(|e| format!("wav header: {e}"))?;
    file.write_all(&fmt).map_err(|e| format!("wav fmt: {e}"))?;
    file.write_all(b"data\0\0\0\0")
        .map_err(|e| format!("wav data tag: {e}"))?;
    let mut data_bytes: u64 = 0;

    let wfx = WaveFormatEx {
        tag: 1,
        channels: 1,
        samples_per_sec: 16_000,
        avg_bytes_per_sec: 32_000,
        block_align: 2,
        bits_per_sample: 16,
        cb_size: 0,
    };
    let mut enumerator: ComPtr = ptr::null_mut();
    let hr = unsafe {
        CoCreateInstance(
            &CLSID_MM_DEVICE_ENUMERATOR,
            ptr::null_mut(),
            CLSCTX_INPROC_SERVER,
            &IID_IMM_DEVICE_ENUMERATOR,
            &mut enumerator,
        )
    };
    if hr < 0 || enumerator.is_null() {
        return Err(format!("MMDeviceEnumerator 0x{:08x}", hr as u32));
    }
    let result = (|| {
        let get_default: unsafe extern "system" fn(ComPtr, u32, u32, *mut ComPtr) -> i32 =
            unsafe { mem::transmute(com_method(enumerator, 4)) };
        let mut device: ComPtr = ptr::null_mut();
        let hr = unsafe { get_default(enumerator, 0, 0, &mut device) }; // eCapture, eConsole
        if hr < 0 || device.is_null() {
            return Err(format!(
                "no default capture endpoint 0x{:08x} (no microphone?)",
                hr as u32
            ));
        }
        let activate: unsafe extern "system" fn(
            ComPtr,
            *const Guid,
            u32,
            *const c_void,
            *mut ComPtr,
        ) -> i32 = unsafe { mem::transmute(com_method(device, 3)) };
        let mut client: ComPtr = ptr::null_mut();
        let hr = unsafe {
            activate(
                device,
                &IID_IAUDIO_CLIENT,
                CLSCTX_INPROC_SERVER,
                ptr::null(),
                &mut client,
            )
        };
        unsafe { release(device) };
        if hr < 0 || client.is_null() {
            return Err(format!("activate IAudioClient 0x{:08x}", hr as u32));
        }
        let stream_result = unsafe { audio_stream(client, &wfx, &mut file, &mut data_bytes) };
        unsafe { release(client) };
        stream_result
    })();
    unsafe { release(enumerator) };
    // Patch RIFF/WAVE sizes so even a failed capture leaves a valid file.
    if let Ok(end) = file.stream_position() {
        let _ = file.seek(SeekFrom::Start(4));
        let _ = file.write_all(&((end - 8) as u32).to_le_bytes());
        let _ = file.seek(SeekFrom::Start(40));
        let _ = file.write_all(&(data_bytes as u32).to_le_bytes());
        let _ = file.seek(SeekFrom::Start(end));
    }
    let _ = file.flush();
    result?;
    Ok(data_bytes)
}

unsafe fn audio_stream(
    client: ComPtr,
    wfx: &WaveFormatEx,
    file: &mut fs::File,
    data_bytes: &mut u64,
) -> Result<(), String> {
    let initialize: unsafe extern "system" fn(
        ComPtr,
        u32,
        u32,
        i64,
        i64,
        *const WaveFormatEx,
        *const Guid,
    ) -> i32 = unsafe { mem::transmute(com_method(client, 3)) };
    let hr = unsafe {
        initialize(
            client,
            0, // shared
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            2_000_000, // 200 ms buffer, 100-ns units
            0,
            wfx,
            ptr::null(),
        )
    };
    if hr < 0 {
        return Err(format!(
            "IAudioClient::Initialize 0x{:08x} (device busy or denied)",
            hr as u32
        ));
    }
    // IAudioClient vtable: 3 Initialize, 4 GetBufferSize, 5 GetStreamLatency,
    // 6 GetCurrentPadding, 7 IsFormatSupported, 8 GetMixFormat, 9 GetDevicePeriod,
    // 10 Start, 11 Stop, 12 Reset, 13 SetEventHandle, 14 GetService.
    let get_service: unsafe extern "system" fn(ComPtr, *const Guid, *mut ComPtr) -> i32 =
        unsafe { mem::transmute(com_method(client, 14)) };
    let mut capture: ComPtr = ptr::null_mut();
    let hr = unsafe { get_service(client, &IID_IAUDIO_CAPTURE_CLIENT, &mut capture) };
    if hr < 0 || capture.is_null() {
        return Err(format!(
            "GetService(IAudioCaptureClient) 0x{:08x}",
            hr as u32
        ));
    }
    let start: unsafe extern "system" fn(ComPtr) -> i32 =
        unsafe { mem::transmute(com_method(client, 10)) };
    let hr = unsafe { start(client) };
    if hr < 0 {
        unsafe { release(capture) };
        return Err(format!("IAudioClient::Start 0x{:08x}", hr as u32));
    }
    enqueue(Record::Media {
        unix_ms: unix_ms(),
        kind: "audio",
        status: "ok",
        detail: "PCM 16kHz mono 16-bit via WASAPI shared capture".into(),
    });
    let get_packet: unsafe extern "system" fn(ComPtr, *mut u32) -> i32 =
        unsafe { mem::transmute(com_method(capture, 5)) };
    let get_buffer: unsafe extern "system" fn(
        ComPtr,
        *mut *mut u8,
        *mut u32,
        *mut u32,
        *mut u64,
        *mut u64,
    ) -> i32 = unsafe { mem::transmute(com_method(capture, 3)) };
    let release_buffer: unsafe extern "system" fn(ComPtr, u32) -> i32 =
        unsafe { mem::transmute(com_method(capture, 4)) };
    while !SHUTDOWN.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(10));
        let mut packet: u32 = 0;
        if unsafe { get_packet(capture, &mut packet) } < 0 {
            break;
        }
        while packet > 0 {
            let mut data: *mut u8 = ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            let hr = unsafe {
                get_buffer(
                    capture,
                    &mut data,
                    &mut frames,
                    &mut flags,
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if hr < 0 {
                break;
            }
            let bytes = frames as usize * 2;
            if flags & AUDCLNT_BUFFERFLAGS_SILENT != 0 || data.is_null() {
                let zeros = vec![0u8; bytes];
                let _ = file.write_all(&zeros);
            } else {
                let slice = unsafe { std::slice::from_raw_parts(data, bytes) };
                let _ = file.write_all(slice);
            }
            *data_bytes += bytes as u64;
            AUDIO_BYTES.store(*data_bytes, Ordering::Relaxed);
            let _ = unsafe { release_buffer(capture, frames) };
            if unsafe { get_packet(capture, &mut packet) } < 0 {
                break;
            }
        }
    }
    let stop: unsafe extern "system" fn(ComPtr) -> i32 =
        unsafe { mem::transmute(com_method(client, 11)) };
    unsafe {
        stop(client);
        release(capture);
    }
    let _ = file.flush();
    Ok(())
}

fn print_help() {
    println!(
        "skill-recorder — FastCUA issue #3 stages 2-5: demonstration recorder v2 + media\n\
         \n\
         Options:\n\
         \x20 --out DIR               recording directory (default ./recordings/<timestamp>)\n\
         \x20 --duration-ms N         auto-stop after N ms\n\
         \x20 --keyframe-interval SEC periodic JPEG keyframe cadence (default 30)\n\
         \x20 --uia-poll-ms N         UIA focus poll cadence (default 200)\n\
         \x20 --no-indicator          hide the on-top REC indicator window\n\
         \x20 --no-video              disable the demo video track\n\
         \x20 --no-audio              disable microphone narration capture\n\
         \x20 --video-fps N           demo video frame rate (default 4)\n\
         \x20 --video-max-edge N      demo video longest edge in px (default 1568)\n\
         \x20 --video-quality N       demo video JPEG quality 1-100 (default 70)\n\
         \x20 --help\n\
         \n\
         Controls: Ctrl+Alt+N narration note, Ctrl+Alt+R pause/resume, Ctrl+Alt+X stop now.\n\
         Output: session.jsonl (fastcua-recording/1), keyframes/*.jpg,\n\
         \x20 video/video.avi (MJPEG, ~4fps) + video/index.jsonl (frame offsets for\n\
         \x20 frame-extract.mjs), audio/narration.wav (PCM 16kHz mono) — all local.\n\
         Redaction: key characters never logged; password fields drop vk/value and\n\
         suppress keyframes; during password focus or the secure desktop the video\n\
         track stores a marker black frame and an index gap entry, never pixels;\n\
         secure desktop input logs only a marker. No mic / busy mic degrades to\n\
         a media note in session.jsonl, never a recording failure."
    );
}

fn main() {
    // Become Per-Monitor-V2 DPI aware BEFORE any UIA/window call. Low-level
    // hooks always deliver physical screen points; a DPI-unaware process gets
    // virtualized (logical) UIA coordinates for ElementFromPoint/Bounds, so
    // on a scaled display point anchors resolve to the wrong element (or to
    // whatever window sits at the logical point). Declaring awareness up
    // front keeps hook points, UIA lookups, and keyframe capture in one
    // physical-pixel coordinate space. No-op on pre-1607 Windows loaders is
    // not a concern: the tool already requires GetDpiForSystem (1607+).
    const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: usize = -4i64 as usize;
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }
    let opt = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let stamp = format!("{}", unix_ms());
    let out_dir = opt("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("recordings").join(stamp));
    let keyframe_dir = out_dir.join("keyframes");
    let duration_ms = opt("--duration-ms").and_then(|v| v.parse::<u64>().ok());
    let keyframe_interval_s = opt("--keyframe-interval")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30)
        .max(5);
    let uia_poll_ms = opt("--uia-poll-ms")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(200)
        .max(50);
    let no_indicator = args.iter().any(|a| a == "--no-indicator");
    let no_video = args.iter().any(|a| a == "--no-video");
    let no_audio = args.iter().any(|a| a == "--no-audio");
    let video_fps = opt("--video-fps")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(4)
        .clamp(1, 15);
    let video_max_edge = opt("--video-max-edge")
        .and_then(|v| v.parse::<i32>().ok())
        .unwrap_or(1568)
        .max(64);
    let video_quality = opt("--video-quality")
        .and_then(|v| v.parse::<u8>().ok())
        .unwrap_or(70)
        .clamp(30, 95);
    let video_dir = out_dir.join("video");
    let audio_dir = out_dir.join("audio");

    fs::create_dir_all(&keyframe_dir).expect("create recording dir");
    if !no_video {
        fs::create_dir_all(&video_dir).expect("create video dir");
    }
    if !no_audio {
        fs::create_dir_all(&audio_dir).expect("create audio dir");
    }
    let session_path = out_dir.join("session.jsonl");

    // Header line: versioned format declaration, machine context, policy.
    let media_video = if no_video {
        "null".to_string()
    } else {
        "\"video/video.avi\"".to_string()
    };
    let media_video_index = if no_video {
        "null".to_string()
    } else {
        "\"video/index.jsonl\"".to_string()
    };
    let media_audio = if no_audio {
        "null".to_string()
    } else {
        "\"audio/narration.wav\"".to_string()
    };
    let header = format!(
        "{{\"t\":\"header\",\"format\":\"{SESSION_FORMAT}\",\"tool\":\"skill-recorder\",\"version\":\"{}\",\"started_ts\":{},\"machine\":{{\"monitors\":{},\"virtual_screen\":[{},{}],\"system_dpi\":{},\"keyboard_layout\":\"0x{:x}\"}},\"media\":{{\"video\":{},\"video_index\":{},\"audio\":{},\"audio_note\":\"audio is best-effort; a t=media record declares availability early in the session\"}},\"redaction\":\"vk codes never resolved to characters; password fields drop vk+value and suppress keyframes AND video frames (marked gaps); secure desktop logs marker only\",\"controls\":{{\"pause\":\"Ctrl+Alt+R\",\"note\":\"Ctrl+Alt+N\",\"stop\":\"Ctrl+Alt+X\"}}}}",
        env!("CARGO_PKG_VERSION"),
        unix_ms(),
        unsafe { GetSystemMetrics(SM_CMONITORS) },
        unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) },
        unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) },
        unsafe { GetDpiForSystem() },
        unsafe { GetKeyboardLayout(0) } as usize & 0xffff,
        media_video,
        media_video_index,
        media_audio,
    );
    fs::write(&session_path, header + "\n").expect("write session header");

    let (tx, rx) = mpsc::channel::<Record>();
    SENDER.set(tx).expect("sender once");
    let (wake_tx, wake_rx) = mpsc::channel::<()>();
    FOCUS_WAKE.set(wake_tx).expect("wake once");
    MAIN_THREAD.store(unsafe { GetCurrentThreadId() } as u64, Ordering::Relaxed);

    let writer_path = session_path.clone();
    let writer = thread::Builder::new()
        .name("rec-writer".into())
        .spawn(move || writer_main(rx, &writer_path))
        .expect("writer thread");

    let poll_dir = keyframe_dir.clone();
    let _poller = thread::Builder::new()
        .name("rec-poller".into())
        .spawn(move || poller_main(wake_rx, poll_dir, uia_poll_ms, keyframe_interval_s))
        .expect("poller thread");

    let video_handle = if no_video {
        None
    } else {
        let dir = video_dir.clone();
        Some(
            thread::Builder::new()
                .name("rec-video".into())
                .spawn(move || video_main(dir, video_fps, video_max_edge, video_quality))
                .expect("video thread"),
        )
    };
    let audio_handle = if no_audio {
        None
    } else {
        let path = audio_dir.join("narration.wav");
        Some(
            thread::Builder::new()
                .name("rec-audio".into())
                .spawn(move || audio_main(path))
                .expect("audio thread"),
        )
    };

    {
        let tx = SENDER.get().unwrap().clone();
        thread::Builder::new()
            .name("rec-stats".into())
            .spawn(move || loop {
                thread::sleep(Duration::from_secs(10));
                if SHUTDOWN.load(Ordering::Relaxed) {
                    break;
                }
                let _ = tx.send(Record::Stats { unix_ms: unix_ms() });
            })
            .expect("stats thread");
    }

    if let Some(ms) = duration_ms {
        thread::Builder::new()
            .name("rec-timer".into())
            .spawn(move || {
                thread::sleep(Duration::from_millis(ms));
                SHUTDOWN.store(true, Ordering::Relaxed);
                unsafe {
                    PostThreadMessageW(MAIN_THREAD.load(Ordering::Relaxed) as DWORD, WM_QUIT, 0, 0)
                };
            })
            .expect("timer thread");
    }

    unsafe { SetConsoleCtrlHandler(ctrl_handler, TRUE) };
    register_window_classes();

    let indicator = if no_indicator {
        ptr::null_mut()
    } else {
        create_indicator()
    };
    IND_HWND.store(indicator as usize, Ordering::Relaxed);

    let module = unsafe { GetModuleHandleW(ptr::null()) };
    let kb_hook = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, keyboard_proc, module, 0) };
    let ms_hook = unsafe { SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, module, 0) };
    let focus_hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_FOCUS,
            ptr::null_mut(),
            focus_event_proc,
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        )
    };
    let hot_r = unsafe {
        RegisterHotKey(
            ptr::null_mut(),
            1,
            MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
            b'R' as UINT,
        )
    };
    let hot_n = unsafe {
        RegisterHotKey(
            ptr::null_mut(),
            2,
            MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
            b'N' as UINT,
        )
    };
    let hot_x = unsafe {
        RegisterHotKey(
            ptr::null_mut(),
            3,
            MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
            b'X' as UINT,
        )
    };

    println!("[rec] recording -> {}", session_path.display());
    println!("[rec] hooks kb={} mouse={} focus={} | hotkeys note(Ctrl+Alt+N)={} pause(Ctrl+Alt+R)={} stop(Ctrl+Alt+X)={}",
        !kb_hook.is_null(), !ms_hook.is_null(), !focus_hook.is_null(), hot_n != 0, hot_r != 0, hot_x != 0);
    println!(
        "[rec] keyframes: JPEG, sparse (note/action/focus/{}s), dir {}",
        keyframe_interval_s,
        keyframe_dir.display()
    );
    println!(
        "[rec] video: {}",
        if no_video {
            "disabled".to_string()
        } else {
            format!(
                "MJPEG-AVI {}fps long-edge≤{} q{} -> {}",
                video_fps,
                video_max_edge,
                video_quality,
                video_dir.display()
            )
        }
    );
    println!(
        "[rec] audio: {}",
        if no_audio {
            "disabled".to_string()
        } else {
            "WASAPI PCM 16kHz mono (best-effort)".to_string()
        }
    );
    println!(
        "[rec] indicator: {}",
        if no_indicator {
            "disabled"
        } else {
            "on-top REC window"
        }
    );

    enqueue(Record::Marker {
        unix_ms: unix_ms(),
        text: "recording started".into(),
    });
    enqueue(Record::Stats { unix_ms: unix_ms() });

    let mut msg: MSG = unsafe { mem::zeroed() };
    loop {
        let got = unsafe { GetMessageW(&mut msg, ptr::null_mut(), 0, 0) };
        if got <= 0 {
            break;
        }
        if msg.message == WM_HOTKEY {
            match msg.wParam {
                1 => {
                    let on = !RECORDING.load(Ordering::Relaxed);
                    RECORDING.store(on, Ordering::Relaxed);
                    if !indicator.is_null() {
                        unsafe { ShowWindow(indicator, if on { SW_SHOW } else { SW_HIDE } as i32) };
                    }
                    enqueue(Record::Marker {
                        unix_ms: unix_ms(),
                        text: format!("recording toggled {on} via Ctrl+Alt+R"),
                    });
                    println!("[rec] recording {}", if on { "ON" } else { "PAUSED" });
                }
                2 => {
                    enqueue(Record::Marker {
                        unix_ms: unix_ms(),
                        text: "note requested via Ctrl+Alt+N".into(),
                    });
                    show_note_window();
                }
                3 => {
                    enqueue(Record::Marker {
                        unix_ms: unix_ms(),
                        text: "emergency stop via Ctrl+Alt+X".into(),
                    });
                    println!("[rec] emergency stop");
                    SHUTDOWN.store(true, Ordering::Relaxed);
                    break;
                }
                _ => {}
            }
        }
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }
    }

    println!("[rec] stopping: unhooking and flushing...");
    RECORDING.store(false, Ordering::Relaxed);
    unsafe {
        if !kb_hook.is_null() {
            UnhookWindowsHookEx(kb_hook);
        }
        if !ms_hook.is_null() {
            UnhookWindowsHookEx(ms_hook);
        }
        if !focus_hook.is_null() {
            UnhookWinEvent(focus_hook);
        }
        if hot_r != 0 {
            UnregisterHotKey(ptr::null_mut(), 1);
        }
        if hot_n != 0 {
            UnregisterHotKey(ptr::null_mut(), 2);
        }
        if hot_x != 0 {
            UnregisterHotKey(ptr::null_mut(), 3);
        }
    }
    // Finalize media before the last stats record so byte counts are complete.
    if let Some(handle) = video_handle {
        let _ = handle.join();
    }
    if let Some(handle) = audio_handle {
        let _ = handle.join();
    }
    enqueue(Record::Stats { unix_ms: unix_ms() });
    enqueue(Record::Marker {
        unix_ms: unix_ms(),
        text: "recording stopped cleanly".into(),
    });
    thread::sleep(Duration::from_millis(400));
    println!("[rec] done. Inspect: {}", session_path.display());
    let _ = writer;
}
