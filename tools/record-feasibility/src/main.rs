// SPDX-License-Identifier: MIT
//
// record-feasibility — stage-1 diagnostic for FastCUA issue #3.
//
// Proves (or disproves) on a real Windows desktop that a local tool can record
// a human demonstration: physical mouse/keyboard via low-level hooks, UIA
// focus snapshots, sparse screenshot keyframes — with timestamps, injected-vs-
// physical labeling, and by-design redaction. Output: one local JSONL file
// (+ optional BMP keyframes) that is inspectable and deletable.
//
// REDACTION POLICY (by design, enforced in code):
//  1. Keyboard events NEVER resolve vk codes to characters. Only the numeric
//     vk, a coarse key class, and modifier booleans are logged.
//  2. While the focused control is a password field (UIA IsPassword or the
//     ES_PASSWORD window style), keyboard records carry "redacted":
//     "password-field" and drop even the vk; screenshot keyframes are
//     suppressed for the same window.
//  3. On the Secure Desktop (lock screen / UAC) low-level hooks do not fire at
//     all; the poller logs only a "secure_desktop" marker, no content.
//  4. Window titles are truncated (120 chars). Everything stays in one local
//     directory chosen by the user; deleting it deletes the recording.
//
// Usage: record-feasibility [--out DIR] [--duration-ms N] [--screenshots [SEC]]
//                             [--uia-poll-ms N]
// Stop: Ctrl+C, --duration-ms, or toggle recording with Ctrl+Alt+R.

#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::mem;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

const MOD_ALT: UINT = 0x0001;
const MOD_CONTROL: UINT = 0x0002;
const MOD_NOREPEAT: UINT = 0x4000;

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
const ES_PASSWORD: u32 = 0x0020;

const SM_CMONITORS: i32 = 80;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

const SRCCOPY: DWORD = 0x00cc0020;
const CAPTUREBLT: DWORD = 0x40000000;
const DIB_RGB_COLORS: UINT = 0;
const BI_RGB: DWORD = 0;

const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

const COINIT_MULTITHREADED: u32 = 0x0;
const CLSCTX_INPROC_SERVER: u32 = 0x1;
const RPC_E_CHANGED_MODE: i32 = -2147417850;

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
struct KBDLLHOOKSTRUCT {
    vkCode: DWORD,
    scanCode: DWORD,
    flags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
}
#[repr(C)]
struct MSLLHOOKSTRUCT {
    pt: POINT,
    mouseData: DWORD,
    flags: DWORD,
    time: DWORD,
    dwExtraInfo: ULONG_PTR,
}
#[repr(C)]
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
struct BITMAPINFO {
    bmiHeader: BITMAPINFOHEADER,
    bmiColors: [u32; 1],
}
#[repr(C)]
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
type WinEventProc = unsafe extern "system" fn(
    HANDLE,
    DWORD,
    HWND,
    i32,
    i32,
    DWORD,
    DWORD,
);
type HookProc = unsafe extern "system" fn(i32, WPARAM, LPARAM) -> LRESULT;

#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowsHookExW(id_hook: i32, proc_: HookProc, module: HMODULE, thread_id: DWORD) -> HHOOK;
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
    fn IsWindow(hwnd: HWND) -> BOOL;
    fn GetKeyState(vk: i32) -> i16;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetWindowDC(hwnd: HWND) -> HDC;
    fn ReleaseDC(hwnd: HWND, dc: HDC) -> i32;
    fn PrintWindow(hwnd: HWND, dc: HDC, flags: UINT) -> BOOL;
    fn GetDpiForSystem() -> UINT;
    fn GetKeyboardLayout(thread: DWORD) -> HANDLE;
    fn OpenInputDesktop(flags: DWORD, inherit: BOOL, access: DWORD) -> HANDLE;
    fn CloseDesktop(desk: HANDLE) -> BOOL;
    fn GetUserObjectInformationW(obj: HANDLE, index: i32, info: *mut c_void, len: DWORD, needed: *mut DWORD) -> BOOL;
    fn SetConsoleCtrlHandler(handler: unsafe extern "system" fn(DWORD) -> BOOL, add: BOOL) -> BOOL;
    fn GetModuleHandleW(name: *const u16) -> HMODULE;
}
#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(dc: HDC) -> HDC;
    fn CreateCompatibleBitmap(dc: HDC, w: i32, h: i32) -> HBITMAP;
    fn SelectObject(dc: HDC, obj: HGDIOBJ) -> HGDIOBJ;
    fn BitBlt(dst: HDC, x: i32, y: i32, w: i32, h: i32, src: HDC, sx: i32, sy: i32, rop: DWORD) -> BOOL;
    fn GetDIBits(dc: HDC, bmp: HBITMAP, start: UINT, lines: UINT, bits: *mut c_void, info: *mut BITMAPINFO, usage: UINT) -> i32;
    fn DeleteObject(obj: HGDIOBJ) -> BOOL;
    fn DeleteDC(dc: HDC) -> BOOL;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> HANDLE;
    fn OpenProcess(access: DWORD, inherit: BOOL, pid: DWORD) -> HANDLE;
    fn CloseHandle(h: HANDLE) -> BOOL;
    fn QueryFullProcessImageNameW(proc_: HANDLE, flags: DWORD, name: *mut u16, size: *mut DWORD) -> BOOL;
    fn QueryPerformanceCounter(counter: *mut i64) -> BOOL;
    fn QueryPerformanceFrequency(freq: *mut i64) -> BOOL;
    fn GetProcessTimes(proc_: HANDLE, create: *mut FILETIME, exit: *mut FILETIME, kernel: *mut FILETIME, user: *mut FILETIME) -> BOOL;
    fn GetSystemTimeAsFileTime(out: *mut FILETIME);
    fn Sleep(ms: DWORD);
    fn GetCurrentProcessId() -> DWORD;
}
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(proc_: HANDLE, counters: *mut PROCESS_MEMORY_COUNTERS, cb: DWORD) -> BOOL;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> i32;
    fn CoUninitialize();
    fn CoCreateInstance(clsid: *const Guid, outer: ComPtr, clsctx: u32, iid: *const Guid, out: *mut ComPtr) -> i32;
}
#[link(name = "oleaut32")]
unsafe extern "system" {
    fn SysStringLen(value: *const u16) -> u32;
    fn SysFreeString(value: *mut u16);
}

// ---------------------------------------------------------------- events

enum Record {
    /// Raw hook observation. `kind` distinguishes keyboard/mouse variants.
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
        suppressed: bool,
    },
    Stats {
        unix_ms: u64,
    },
    Marker {
        unix_ms: u64,
        text: String,
    },
}

#[derive(Clone, Default)]
struct UiaFocus {
    name: String,
    control_type: i32,
    role: &'static str,
    is_password: bool,
    hwnd: usize,
    bounds: Option<RECT>,
    error: Option<String>,
}

// Shared, tiny global state (hook procs must be plain fns).
static SENDER: OnceLock<mpsc::Sender<Record>> = OnceLock::new();
static RECORDING: AtomicBool = AtomicBool::new(true);
static CB_COUNT: AtomicU64 = AtomicU64::new(0);
static CB_TOTAL_NS: AtomicU64 = AtomicU64::new(0);
static CB_MAX_NS: AtomicU64 = AtomicU64::new(0);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static COALESCED: AtomicU64 = AtomicU64::new(0);
static LAST_MOVE_MS: AtomicU64 = AtomicU64::new(0);
static QPC_FREQ: OnceLock<i64> = OnceLock::new();
static FOCUS_WAKE: OnceLock<mpsc::Sender<()>> = OnceLock::new();
static LATEST_FOCUS: Mutex<Option<UiaFocus>> = Mutex::new(None);

fn unix_ms() -> u64 {
    let mut ft = FILETIME::default();
    unsafe { GetSystemTimeAsFileTime(&mut ft) };
    // 100ns ticks since 1601 -> ms since 1970
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
        // Bounded latency matters more than completeness: hook callbacks must
        // never block. The writer is fast (one line + flush), but if the queue
        // ever grows absurdly we count a drop instead of stalling the hook.
        if sender.send(record).is_err() {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
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
        0x30..=0x39 | 0x41..=0x5a | 0x60..=0x6f | 0xba..=0xc0 | 0xdb..=0xde | 0xe1..=0xe4 => "printable",
        0x70..=0x87 => "function",
        0x21..=0x28 | 0x2d | 0x2e => "navigation",
        0x08 | 0x09 | 0x0d | 0x1b | 0x20 => "editing",
        0x10..=0x12 | 0xa0..=0xa5 | 0x5b | 0x5c => "modifier",
        0xe5 | 0xe7 => "ime",
        0x90 | 0x91 | 0x14 => "lock",
        _ => "other",
    }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let start = qpc_ns();
    if code >= 0 && RECORDING.load(Ordering::Relaxed) {
        let kb = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let down = wparam as UINT == WM_KEYDOWN || wparam as UINT == WM_SYSKEYDOWN;
        let (ctrl, shift, alt, win) = mods();
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
            fg: unsafe { GetForegroundWindow() } as usize,
        });
        if let Some(wake) = FOCUS_WAKE.get() {
            // Key activity often precedes a focus/value change; nudge the poller.
            let _ = wake.send(());
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
            // Coalesce pure moves to one per ~40ms; counted in stats so the
            // trade-off stays measurable.
            let last = LAST_MOVE_MS.load(Ordering::Relaxed);
            if now.saturating_sub(last) < 40 {
                COALESCED.fetch_add(1, Ordering::Relaxed);
                note_callback(start);
                return unsafe { CallNextHookEx(ptr::null_mut(), code, wparam, lparam) };
            }
            LAST_MOVE_MS.store(now, Ordering::Relaxed);
        }
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
            fg: unsafe { GetForegroundWindow() } as usize,
        });
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

// ---------------------------------------------------------------- UIA poller

unsafe fn com_method(object: ComPtr, slot: usize) -> *const c_void {
    let vtable = unsafe { *(object as *const *const *const c_void) };
    unsafe { *vtable.add(slot) }
}

unsafe fn release(object: ComPtr) {
    if !object.is_null() {
        let rel: unsafe extern "system" fn(ComPtr) -> u32 = unsafe { mem::transmute(com_method(object, 2)) };
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

/// Snapshot the UIA focused element. Bounded: the query runs on a worker and
/// times out, mirroring the native-host defense against hung providers.
fn uia_focus_snapshot() -> Option<UiaFocus> {
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("rec-uia".into())
        .spawn(move || {
            let _ = tx.send(unsafe { uia_focus_inner() });
        })
        .ok()?;
    rx.recv_timeout(Duration::from_millis(800)).ok()?
}

unsafe fn uia_focus_inner() -> Option<UiaFocus> {
    let init = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_MULTITHREADED) };
    let should_uninit = init == 0 || init == 1;
    if init < 0 && init != RPC_E_CHANGED_MODE {
        return Some(UiaFocus { error: Some(format!("CoInitializeEx 0x{:08x}", init as u32)), ..Default::default() });
    }
    let result = (|| {
        let mut automation = ptr::null_mut();
        let created = unsafe {
            CoCreateInstance(&CLSID_CUI_AUTOMATION, ptr::null_mut(), CLSCTX_INPROC_SERVER, &IID_IUI_AUTOMATION, &mut automation)
        };
        if created < 0 || automation.is_null() {
            return UiaFocus { error: Some(format!("CoCreateInstance 0x{:08x}", created as u32)), ..Default::default() };
        }
        let get_focused: unsafe extern "system" fn(ComPtr, *mut ComPtr) -> i32 =
            unsafe { mem::transmute(com_method(automation, 8)) };
        let mut focused = ptr::null_mut();
        let hr = unsafe { get_focused(automation, &mut focused) };
        unsafe { release(automation) };
        if hr < 0 || focused.is_null() {
            return UiaFocus { error: Some("no focused element".into()), ..Default::default() };
        }
        let get_i32 = |slot: usize| -> Option<i32> {
            let getter: unsafe extern "system" fn(ComPtr, *mut i32) -> i32 =
                unsafe { mem::transmute(com_method(focused, slot)) };
            let mut v = 0;
            if unsafe { getter(focused, &mut v) } < 0 { None } else { Some(v) }
        };
        let name = {
            let getter: unsafe extern "system" fn(ComPtr, *mut *mut u16) -> i32 =
                unsafe { mem::transmute(com_method(focused, 23)) };
            let mut bstr = ptr::null_mut();
            if unsafe { getter(focused, &mut bstr) } >= 0 && !bstr.is_null() {
                let len = unsafe { SysStringLen(bstr) } as usize;
                let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(bstr, len) });
                unsafe { SysFreeString(bstr) };
                s
            } else {
                String::new()
            }
        };
        let control_type = get_i32(21).unwrap_or(0);
        let is_password_uia = get_i32(35).map(|v| v != 0);
        let hwnd = {
            let getter: unsafe extern "system" fn(ComPtr, *mut HWND) -> i32 =
                unsafe { mem::transmute(com_method(focused, 36)) };
            let mut h: HWND = ptr::null_mut();
            if unsafe { getter(focused, &mut h) } < 0 { ptr::null_mut() } else { h }
        };
        let bounds = {
            let getter: unsafe extern "system" fn(ComPtr, *mut RECT) -> i32 =
                unsafe { mem::transmute(com_method(focused, 43)) };
            let mut r = RECT::default();
            if unsafe { getter(focused, &mut r) } < 0 { None } else { Some(r) }
        };
        unsafe { release(focused) };
        // Belt-and-braces password detection: UIA IsPassword OR the classic
        // ES_PASSWORD style on the focused HWND (deterministic for Win32 edits).
        let style_password = !hwnd.is_null()
            && (unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32 & ES_PASSWORD) != 0;
        UiaFocus {
            name,
            control_type,
            role: role_name(control_type),
            is_password: is_password_uia.unwrap_or(false) || style_password,
            hwnd: hwnd as usize,
            bounds,
            error: None,
        }
    })();
    if should_uninit {
        unsafe { CoUninitialize() };
    }
    Some(result)
}

fn input_desktop_is_secure() -> bool {
    unsafe {
        let desk = OpenInputDesktop(0, FALSE, 0x0001);
        if desk.is_null() {
            return true; // cannot open input desktop: treat as secure/unknown
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

// ---------------------------------------------------------------- capture

/// Foreground-window BitBlt keyframe (never PrintWindow: it parks on hung apps).
/// Returns BMP path on success.
fn capture_keyframe(hwnd: HWND, dir: &Path, seq: u64) -> Option<(String, i32, i32)> {
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
        // Hung windows: BitBlt only (PrintWindow would block on the pump).
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
        let copied = GetDIBits(memory, bitmap, 0, h as UINT, bgra.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS);
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(hwnd, source);
        if copied == 0 {
            return None;
        }
        let name = format!("keyframe-{seq:05}.bmp");
        let path = dir.join(&name);
        write_bmp_24(&path, w, h, &bgra).ok()?;
        Some((name, w, h))
    }
}

fn write_bmp_24(path: &Path, w: i32, h: i32, bgra: &[u8]) -> std::io::Result<()> {
    let row_bytes = (w as usize * 3 + 3) & !3;
    let pixel_bytes = row_bytes * h as usize;
    let file_bytes = 54 + pixel_bytes;
    let mut file = File::create(path)?;
    let mut header = [0u8; 54];
    header[0] = b'B';
    header[1] = b'M';
    header[2..6].copy_from_slice(&(file_bytes as u32).to_le_bytes());
    header[10..14].copy_from_slice(&54u32.to_le_bytes());
    header[14..18].copy_from_slice(&40u32.to_le_bytes());
    header[18..22].copy_from_slice(&w.to_le_bytes());
    header[22..26].copy_from_slice(&h.to_le_bytes());
    header[26..28].copy_from_slice(&1u16.to_le_bytes());
    header[28..30].copy_from_slice(&24u16.to_le_bytes());
    header[34..38].copy_from_slice(&(pixel_bytes as u32).to_le_bytes());
    file.write_all(&header)?;
    let mut row = vec![0u8; row_bytes];
    for y in (0..h as usize).rev() {
        for x in 0..w as usize {
            let src = (y * w as usize + x) * 4;
            row[x * 3..x * 3 + 3].copy_from_slice(&bgra[src..src + 3]);
        }
        file.write_all(&row)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- writer

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
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return String::new();
    }
    if unsafe { IsHungAppWindow(hwnd) } != 0 {
        return String::new();
    }
    // Bounded cross-process title read (same defense as the native host).
    let mut length: usize = 0;
    const WM_GETTEXTLENGTH: UINT = 0x000e;
    const WM_GETTEXT: UINT = 0x000d;
    const SMTO_ABORTIFHUNG: UINT = 0x0002;
    const SMTO_BLOCK: UINT = 0x0001;
    if unsafe {
        SendMessageTimeoutW(hwnd, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 300, &mut length)
    } == 0
    {
        return String::new();
    }
    let mut buf = vec![0u16; (length + 1).min(1024)];
    let mut copied: usize = 0;
    if unsafe {
        SendMessageTimeoutW(hwnd, WM_GETTEXT, buf.len(), buf.as_mut_ptr() as LPARAM, SMTO_ABORTIFHUNG | SMTO_BLOCK, 300, &mut copied)
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
    let key = hwnd;
    if let Some(hit) = cache.get(&key) {
        return hit.clone();
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd as HWND, &mut pid) };
    let entry = (
        if pid != 0 { process_path(pid) } else { String::new() },
        window_title(hwnd as HWND),
    );
    if cache.len() < 512 {
        cache.insert(key, entry.clone());
    }
    entry
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
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) != 0 {
            kernel = k.as_u64() / 10_000;
            user = u.as_u64() / 10_000;
        }
    }
    format!(
        "{{\"t\":\"stats\",\"ts\":{unix_ms_},\"callbacks\":{count},\"cb_avg_us\":{},\"cb_max_us\":{},\"dropped\":{},\"coalesced_moves\":{},\"working_set_mb\":{:.1},\"peak_working_set_mb\":{:.1},\"cpu_kernel_ms\":{kernel},\"cpu_user_ms\":{user}}}",
        if count > 0 { total / count / 1000 } else { 0 },
        max / 1000,
        DROPPED.load(Ordering::Relaxed),
        COALESCED.load(Ordering::Relaxed),
        ws as f64 / 1_048_576.0,
        peak as f64 / 1_048_576.0,
    )
}

fn is_password_context() -> bool {
    LATEST_FOCUS
        .lock()
        .ok()
        .and_then(|f| f.clone())
        .map(|f| f.is_password)
        .unwrap_or(false)
}

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
    while let Ok(record) = rx.recv() {
        let line = match record {
            Record::Hook {
                kind, unix_ms, event_time, injected, lower_il, vk_or_button,
                key_class, scan, extended, ctrl, shift, alt, win, x, y, wheel, fg,
            } => {
                let (app, title) = describe_window(fg, &mut cache);
                let base = format!(
                    "\"ts\":{unix_ms},\"event_time\":{event_time},\"injected\":{injected},\"lower_il\":{lower_il},\"fg\":{{\"hwnd\":{},\"app\":\"{}\",\"title\":\"{}\"}}",
                    fg,
                    json_escape(&app),
                    json_escape(truncate(&title, 120)),
                );
                if kind.starts_with("key") {
                    // Redaction: in a password context drop even the vk code.
                    let pw = is_password_context();
                    // Track the window where password focus was seen so a focus
                    // poll lag cannot leak keystrokes typed into it.
                    if pw {
                        password_window = fg;
                    }
                    if pw || password_window == fg {
                        format!("{{\"t\":\"{kind}\",{base},\"redacted\":\"password-field\"}}")
                    } else {
                        format!(
                            "{{\"t\":\"{kind}\",{base},\"vk\":{vk_or_button},\"class\":\"{}\",\"scan\":{scan},\"extended\":{extended},\"mods\":{{\"ctrl\":{ctrl},\"shift\":{shift},\"alt\":{alt},\"win\":{win}}}}}",
                            key_class.unwrap_or("other")
                        )
                    }
                } else {
                    format!("{{\"t\":\"{kind}\",{base},\"button\":{vk_or_button},\"x\":{x},\"y\":{y},\"wheel\":{wheel}}}")
                }
            }
            Record::Focus { unix_ms, trigger, hwnd, uia, secure_desktop } => {
                let (app, title) = describe_window(hwnd, &mut cache);
                let uia_json = match &uia {
                    Some(u) if u.error.is_none() => {
                        if u.is_password {
                            password_window = u.hwnd;
                            if password_window == 0 {
                                password_window = hwnd;
                            }
                        }
                        let bounds = u.bounds.map(|r| format!("[{},{},{},{}]", r.left, r.top, r.right, r.bottom))
                            .unwrap_or_else(|| "null".into());
                        format!(
                            ",\"uia\":{{\"role\":\"{}\",\"control_type\":{},\"name\":\"{}\",\"is_password\":{},\"hwnd\":{},\"bounds\":{}}}",
                            u.role,
                            u.control_type,
                            json_escape(truncate(&u.name, 120)),
                            u.is_password,
                            u.hwnd,
                            bounds,
                        )
                    }
                    Some(u) => format!(",\"uia\":{{\"error\":\"{}\"}}", json_escape(u.error.as_deref().unwrap_or("unknown"))),
                    None => String::new(),
                };
                format!(
                    "{{\"t\":\"focus\",\"ts\":{unix_ms},\"trigger\":\"{trigger}\",\"secure_desktop\":{secure_desktop},\"hwnd\":{},\"app\":\"{}\",\"title\":\"{}\"{uia_json}}}",
                    hwnd,
                    json_escape(&app),
                    json_escape(truncate(&title, 120)),
                )
            }
            Record::Keyframe { unix_ms, hwnd, path, width, height, suppressed } => {
                format!(
                    "{{\"t\":\"keyframe\",\"ts\":{unix_ms},\"hwnd\":{},\"path\":\"{}\",\"width\":{width},\"height\":{height},\"suppressed\":{suppressed}}}",
                    hwnd,
                    json_escape(&path),
                )
            }
            Record::Stats { unix_ms } => stats_json(unix_ms),
            Record::Marker { unix_ms, text } => {
                format!("{{\"t\":\"marker\",\"ts\":{unix_ms},\"text\":\"{}\"}}", json_escape(&text))
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

// ---------------------------------------------------------------- poller

fn poller_main(wake_rx: mpsc::Receiver<()>, screenshots: Option<u64>, keyframe_dir: PathBuf, poll_ms: u64) {
    let mut last_poll = Instant::now() - Duration::from_secs(1);
    let mut last_keyframe = Instant::now() - Duration::from_secs(3600);
    let mut keyframe_seq = 0u64;
    let mut last_focus_hwnd: HWND = ptr::null_mut();
    loop {
        // Wake on focus/key nudges, otherwise poll every 200ms.
        let _ = wake_rx.recv_timeout(Duration::from_millis(poll_ms));
        while wake_rx.try_recv().is_ok() {}
        let secure = input_desktop_is_secure();
        let snapshot = if secure { None } else { uia_focus_snapshot() };
        let focus_hwnd: HWND = snapshot
            .as_ref()
            .filter(|s| s.error.is_none() && s.hwnd != 0)
            .map(|s| s.hwnd as HWND)
            .unwrap_or(unsafe { GetForegroundWindow() });
        let changed = focus_hwnd != last_focus_hwnd;
        last_focus_hwnd = focus_hwnd;
        if let Ok(mut latest) = LATEST_FOCUS.lock() {
            *latest = snapshot.clone();
        }
        if changed || last_poll.elapsed() >= Duration::from_millis(1000) {
            last_poll = Instant::now();
            enqueue(Record::Focus {
                unix_ms: unix_ms(),
                trigger: if secure { "secure_desktop" } else if changed { "focus_change" } else { "heartbeat" },
                hwnd: focus_hwnd as usize,
                uia: snapshot.clone(),
                secure_desktop: secure,
            });
        }
        if let Some(interval) = screenshots {
            let min_gap = Duration::from_secs(3);
            let due = last_keyframe.elapsed() >= Duration::from_secs(interval);
            if !secure && !focus_hwnd.is_null() && (due || (changed && last_keyframe.elapsed() >= min_gap)) {
                last_keyframe = Instant::now();
                let pw = is_password_context();
                if pw {
                    enqueue(Record::Keyframe {
                        unix_ms: unix_ms(),
                        hwnd: focus_hwnd as usize,
                        path: String::new(),
                        width: 0,
                        height: 0,
                        suppressed: true,
                    });
                } else {
                    keyframe_seq += 1;
                    let result = capture_keyframe(focus_hwnd, &keyframe_dir, keyframe_seq);
                    enqueue(Record::Keyframe {
                        unix_ms: unix_ms(),
                        hwnd: focus_hwnd as usize,
                        path: result.as_ref().map(|(n, _, _)| n.clone()).unwrap_or_default(),
                        width: result.as_ref().map(|(_, w, _)| *w).unwrap_or(0),
                        height: result.as_ref().map(|(_, _, h)| *h).unwrap_or(0),
                        suppressed: false,
                    });
                }
            }
        }
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }
    }
}

static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static MAIN_THREAD: AtomicU64 = AtomicU64::new(0);

unsafe extern "system" fn ctrl_handler(_event: DWORD) -> BOOL {
    SHUTDOWN.store(true, Ordering::Relaxed);
    unsafe {
        PostThreadMessageW(MAIN_THREAD.load(Ordering::Relaxed) as DWORD, WM_QUIT, 0, 0);
    }
    TRUE
}

// ---------------------------------------------------------------- main

fn print_help() {
    println!(
        "record-feasibility — FastCUA issue #3 stage-1 diagnostic\n\
         \n\
         Options:\n\
         \x20 --out DIR            recording directory (default ./recordings/<timestamp>)\n\
         \x20 --duration-ms N      auto-stop after N ms\n\
         \x20 --screenshots [SEC]  BMP keyframes on focus change / every SEC (default 8)\n\
         \x20 --uia-poll-ms N      UIA focus poll cadence (default 200)\n\
         \x20 --help\n\
         \n\
         Controls: Ctrl+Alt+R toggles recording; Ctrl+C stops.\n\
         Output: session.jsonl (+ keyframes/*.bmp) — local, inspectable, deletable.\n\
         Redaction: key characters are never logged; password fields redact vk entirely;\n\
         secure desktop logs only a marker."
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }
    let opt = |name: &str| -> Option<String> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
    };
    let stamp = {
        let ms = unix_ms();
        format!("{ms}")
    };
    let out_dir = opt("--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("recordings").join(stamp));
    let keyframe_dir = out_dir.join("keyframes");
    let duration_ms = opt("--duration-ms").and_then(|v| v.parse::<u64>().ok());
    let screenshots = if args.iter().any(|a| a == "--screenshots") {
        Some(opt("--screenshots").and_then(|v| v.parse::<u64>().ok()).unwrap_or(8))
    } else {
        None
    };
    let uia_poll_ms = opt("--uia-poll-ms").and_then(|v| v.parse::<u64>().ok()).unwrap_or(200).max(50);

    fs::create_dir_all(&keyframe_dir).expect("create recording dir");
    let session_path = out_dir.join("session.jsonl");

    let (tx, rx) = mpsc::channel::<Record>();
    SENDER.set(tx).expect("sender once");
    let (wake_tx, wake_rx) = mpsc::channel::<()>();
    FOCUS_WAKE.set(wake_tx).expect("wake once");
    MAIN_THREAD.store(unsafe { GetCurrentThreadId() } as u64, Ordering::Relaxed);

    let writer_path = session_path.clone();
    let writer = thread::Builder::new().name("rec-writer".into())
        .spawn(move || writer_main(rx, &writer_path)).expect("writer thread");

    let poll_dir = keyframe_dir.clone();
    let _poller = thread::Builder::new().name("rec-poller".into())
        .spawn(move || poller_main(wake_rx, screenshots, poll_dir, uia_poll_ms)).expect("poller thread");

    // Stats every 10s.
    let (stats_tx, stats_rx) = mpsc::channel::<Record>();
    {
        let tx = SENDER.get().unwrap().clone();
        thread::Builder::new().name("rec-stats".into()).spawn(move || {
            let mut rx = stats_rx;
            let _ = &mut rx;
            loop {
                thread::sleep(Duration::from_secs(10));
                if SHUTDOWN.load(Ordering::Relaxed) {
                    break;
                }
                let _ = tx.send(Record::Stats { unix_ms: unix_ms() });
            }
        }).expect("stats thread");
        drop(stats_tx);
    }

    if let Some(ms) = duration_ms {
        thread::Builder::new().name("rec-timer".into()).spawn(move || {
            thread::sleep(Duration::from_millis(ms));
            SHUTDOWN.store(true, Ordering::Relaxed);
            unsafe { PostThreadMessageW(MAIN_THREAD.load(Ordering::Relaxed) as DWORD, WM_QUIT, 0, 0) };
        }).expect("timer thread");
    }

    unsafe { SetConsoleCtrlHandler(ctrl_handler, TRUE) };

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
    let hotkey_ok = unsafe { RegisterHotKey(ptr::null_mut(), 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, b'R' as UINT) };

    println!("[rec] recording -> {}", session_path.display());
    println!("[rec] keyboard hook: {}, mouse hook: {}, focus hook: {}, hotkey Ctrl+Alt+R: {}",
        !kb_hook.is_null(), !ms_hook.is_null(), !focus_hook.is_null(), hotkey_ok != 0);
    println!("[rec] monitors: {}, virtual screen: {}x{}, system DPI: {}, keyboard layout: 0x{:x}",
        unsafe { GetSystemMetrics(SM_CMONITORS) },
        unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) },
        unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) },
        unsafe { GetDpiForSystem() },
        unsafe { GetKeyboardLayout(0) } as usize & 0xffff,
    );
    println!("[rec] stop with Ctrl+C{}; all output stays local", duration_ms.map(|ms| format!(" or after {ms}ms")).unwrap_or_default());

    enqueue(Record::Marker { unix_ms: unix_ms(), text: "recording started".into() });
    enqueue(Record::Stats { unix_ms: unix_ms() });

    // Message loop — required by LL hooks, WinEvent OUTOFCONTEXT, and hotkeys.
    let mut msg: MSG = unsafe { mem::zeroed() };
    loop {
        let got = unsafe { GetMessageW(&mut msg, ptr::null_mut(), 0, 0) };
        if got <= 0 {
            break;
        }
        if msg.message == WM_HOTKEY {
            let on = !RECORDING.load(Ordering::Relaxed);
            RECORDING.store(on, Ordering::Relaxed);
            enqueue(Record::Marker { unix_ms: unix_ms(), text: format!("recording toggled {on} via Ctrl+Alt+R") });
            println!("[rec] recording {}", if on { "ON" } else { "OFF" });
        }
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if SHUTDOWN.load(Ordering::Relaxed) {
            break;
        }
    }

    // ---- cleanup (normal path; on kill/crash Windows releases hooks with the process)
    println!("[rec] stopping: unhooking and flushing...");
    RECORDING.store(false, Ordering::Relaxed);
    unsafe {
        if !kb_hook.is_null() { UnhookWindowsHookEx(kb_hook); }
        if !ms_hook.is_null() { UnhookWindowsHookEx(ms_hook); }
        if !focus_hook.is_null() { UnhookWinEvent(focus_hook); }
        if hotkey_ok != 0 { UnregisterHotKey(ptr::null_mut(), 1); }
    }
    enqueue(Record::Stats { unix_ms: unix_ms() });
    enqueue(Record::Marker { unix_ms: unix_ms(), text: "recording stopped cleanly".into() });
    // The OnceLock sender never closes; the writer drains for a moment and the
    // process exit reaps it. Every line is already flushed individually.
    thread::sleep(Duration::from_millis(400));
    println!("[rec] done. Inspect: {}", session_path.display());
    let _ = writer;
}
