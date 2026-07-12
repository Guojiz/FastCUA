// SPDX-License-Identifier: Apache-2.0

#![allow(non_camel_case_types, non_snake_case, dead_code)]

use std::ffi::c_void;

pub type BOOL = i32;
pub type DWORD = u32;
pub type UINT = u32;
pub type WORD = u16;
pub type LONG = i32;
pub type ULONG_PTR = usize;
pub type LPARAM = isize;
pub type WPARAM = usize;
pub type LRESULT = isize;
pub type HANDLE = *mut c_void;
pub type HWND = *mut c_void;
pub type HDC = *mut c_void;
pub type HGDIOBJ = *mut c_void;
pub type HBITMAP = *mut c_void;
pub type HBRUSH = *mut c_void;
pub type HPEN = *mut c_void;
pub type HINSTANCE = *mut c_void;
pub type HICON = *mut c_void;
pub type HCURSOR = *mut c_void;
pub type HMENU = *mut c_void;

pub const TRUE: BOOL = 1;
pub const FALSE: BOOL = 0;
pub const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
pub const SYNCHRONIZE: DWORD = 0x0010_0000;
pub const INFINITE: DWORD = 0xffff_ffff;

pub const WS_POPUP: DWORD = 0x8000_0000;
pub const WS_EX_TOPMOST: DWORD = 0x0000_0008;
pub const WS_EX_TRANSPARENT: DWORD = 0x0000_0020;
pub const WS_EX_TOOLWINDOW: DWORD = 0x0000_0080;
pub const WS_EX_LAYERED: DWORD = 0x0008_0000;
pub const WS_EX_NOACTIVATE: DWORD = 0x0800_0000;
pub const LWA_COLORKEY: DWORD = 0x0000_0001;

pub const SW_HIDE: i32 = 0;
pub const SW_SHOWNOACTIVATE: i32 = 4;
pub const SW_SHOW: i32 = 5;
pub const SW_RESTORE: i32 = 9;
pub const SWP_NOSIZE: UINT = 0x0001;
pub const SWP_NOMOVE: UINT = 0x0002;
pub const SWP_NOACTIVATE: UINT = 0x0010;
pub const SWP_SHOWWINDOW: UINT = 0x0040;

pub const WM_DESTROY: UINT = 0x0002;
pub const WM_PAINT: UINT = 0x000f;
pub const WM_TIMER: UINT = 0x0113;
pub const WM_CHAR: UINT = 0x0102;
pub const WM_NCHITTEST: UINT = 0x0084;
pub const WM_SETTEXT: UINT = 0x000c;
pub const WM_LBUTTONDOWN: UINT = 0x0201;
pub const WM_LBUTTONUP: UINT = 0x0202;
pub const WM_RBUTTONDOWN: UINT = 0x0204;
pub const WM_RBUTTONUP: UINT = 0x0205;
pub const WM_MBUTTONDOWN: UINT = 0x0207;
pub const WM_MBUTTONUP: UINT = 0x0208;
pub const BM_CLICK: UINT = 0x00f5;
pub const MK_LBUTTON: WPARAM = 0x0001;
pub const MK_RBUTTON: WPARAM = 0x0002;
pub const MK_MBUTTON: WPARAM = 0x0010;
pub const HTTRANSPARENT: LRESULT = -1;
pub const CWP_SKIPINVISIBLE: UINT = 0x0001;
pub const CWP_SKIPDISABLED: UINT = 0x0002;
pub const CWP_SKIPTRANSPARENT: UINT = 0x0004;

pub const SM_XVIRTUALSCREEN: i32 = 76;
pub const SM_YVIRTUALSCREEN: i32 = 77;
pub const SM_CXVIRTUALSCREEN: i32 = 78;
pub const SM_CYVIRTUALSCREEN: i32 = 79;

pub const INPUT_MOUSE: DWORD = 0;
pub const INPUT_KEYBOARD: DWORD = 1;
pub const MOUSEEVENTF_LEFTDOWN: DWORD = 0x0002;
pub const MOUSEEVENTF_LEFTUP: DWORD = 0x0004;
pub const MOUSEEVENTF_RIGHTDOWN: DWORD = 0x0008;
pub const MOUSEEVENTF_RIGHTUP: DWORD = 0x0010;
pub const MOUSEEVENTF_MIDDLEDOWN: DWORD = 0x0020;
pub const MOUSEEVENTF_MIDDLEUP: DWORD = 0x0040;
pub const MOUSEEVENTF_WHEEL: DWORD = 0x0800;
pub const MOUSEEVENTF_HWHEEL: DWORD = 0x1000;
pub const KEYEVENTF_KEYUP: DWORD = 0x0002;
pub const KEYEVENTF_UNICODE: DWORD = 0x0004;
pub const MAPVK_VK_TO_VSC: UINT = 0;

pub const VK_BACK: WORD = 0x08;
pub const VK_TAB: WORD = 0x09;
pub const VK_RETURN: WORD = 0x0d;
pub const VK_SHIFT: WORD = 0x10;
pub const VK_CONTROL: WORD = 0x11;
pub const VK_MENU: WORD = 0x12;
pub const VK_ESCAPE: WORD = 0x1b;
pub const VK_SPACE: WORD = 0x20;
pub const VK_PRIOR: WORD = 0x21;
pub const VK_NEXT: WORD = 0x22;
pub const VK_END: WORD = 0x23;
pub const VK_HOME: WORD = 0x24;
pub const VK_LEFT: WORD = 0x25;
pub const VK_UP: WORD = 0x26;
pub const VK_RIGHT: WORD = 0x27;
pub const VK_DOWN: WORD = 0x28;
pub const VK_INSERT: WORD = 0x2d;
pub const VK_DELETE: WORD = 0x2e;
pub const VK_F1: WORD = 0x70;

pub const SRCCOPY: DWORD = 0x00cc_0020;
pub const CAPTUREBLT: DWORD = 0x4000_0000;
pub const DIB_RGB_COLORS: UINT = 0;
pub const BI_RGB: DWORD = 0;
pub const PW_RENDERFULLCONTENT: UINT = 0x0000_0002;
pub const PS_SOLID: i32 = 0;
pub const HOLLOW_BRUSH: i32 = 5;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct POINT {
    pub x: LONG,
    pub y: LONG,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct RECT {
    pub left: LONG,
    pub top: LONG,
    pub right: LONG,
    pub bottom: LONG,
}

#[repr(C)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: UINT,
    pub wParam: WPARAM,
    pub lParam: LPARAM,
    pub time: DWORD,
    pub pt: POINT,
    pub lPrivate: DWORD,
}

pub type WNDPROC = Option<unsafe extern "system" fn(HWND, UINT, WPARAM, LPARAM) -> LRESULT>;

#[repr(C)]
pub struct WNDCLASSEXW {
    pub cbSize: UINT,
    pub style: UINT,
    pub lpfnWndProc: WNDPROC,
    pub cbClsExtra: i32,
    pub cbWndExtra: i32,
    pub hInstance: HINSTANCE,
    pub hIcon: HICON,
    pub hCursor: HCURSOR,
    pub hbrBackground: HBRUSH,
    pub lpszMenuName: *const u16,
    pub lpszClassName: *const u16,
    pub hIconSm: HICON,
}

#[repr(C)]
pub struct PAINTSTRUCT {
    pub hdc: HDC,
    pub fErase: BOOL,
    pub rcPaint: RECT,
    pub fRestore: BOOL,
    pub fIncUpdate: BOOL,
    pub rgbReserved: [u8; 32],
}

#[repr(C)]
pub struct GUITHREADINFO {
    pub cbSize: DWORD,
    pub flags: DWORD,
    pub hwndActive: HWND,
    pub hwndFocus: HWND,
    pub hwndCapture: HWND,
    pub hwndMenuOwner: HWND,
    pub hwndMoveSize: HWND,
    pub hwndCaret: HWND,
    pub rcCaret: RECT,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MOUSEINPUT {
    pub dx: LONG,
    pub dy: LONG,
    pub mouseData: DWORD,
    pub dwFlags: DWORD,
    pub time: DWORD,
    pub dwExtraInfo: ULONG_PTR,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct KEYBDINPUT {
    pub wVk: WORD,
    pub wScan: WORD,
    pub dwFlags: DWORD,
    pub time: DWORD,
    pub dwExtraInfo: ULONG_PTR,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union INPUT_0 {
    pub mi: MOUSEINPUT,
    pub ki: KEYBDINPUT,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct INPUT {
    pub r#type: DWORD,
    pub Anonymous: INPUT_0,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BITMAPINFOHEADER {
    pub biSize: DWORD,
    pub biWidth: LONG,
    pub biHeight: LONG,
    pub biPlanes: WORD,
    pub biBitCount: WORD,
    pub biCompression: DWORD,
    pub biSizeImage: DWORD,
    pub biXPelsPerMeter: LONG,
    pub biYPelsPerMeter: LONG,
    pub biClrUsed: DWORD,
    pub biClrImportant: DWORD,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct RGBQUAD {
    pub rgbBlue: u8,
    pub rgbGreen: u8,
    pub rgbRed: u8,
    pub rgbReserved: u8,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct BITMAPINFO {
    pub bmiHeader: BITMAPINFOHEADER,
    pub bmiColors: [RGBQUAD; 1],
}

pub type WNDENUMPROC = Option<unsafe extern "system" fn(HWND, LPARAM) -> BOOL>;

#[link(name = "kernel32")]
unsafe extern "system" {
    pub fn GetCurrentProcessId() -> DWORD;
    pub fn GetCurrentThreadId() -> DWORD;
    pub fn GetLastError() -> DWORD;
    pub fn GetModuleHandleW(name: *const u16) -> HINSTANCE;
    pub fn OpenProcess(access: DWORD, inherit: BOOL, process_id: DWORD) -> HANDLE;
    pub fn CloseHandle(handle: HANDLE) -> BOOL;
    pub fn QueryFullProcessImageNameW(
        process: HANDLE,
        flags: DWORD,
        filename: *mut u16,
        size: *mut DWORD,
    ) -> BOOL;
    pub fn WaitForSingleObject(handle: HANDLE, milliseconds: DWORD) -> DWORD;
    pub fn Sleep(milliseconds: DWORD);
}

#[link(name = "user32")]
unsafe extern "system" {
    pub fn EnumWindows(callback: WNDENUMPROC, lparam: LPARAM) -> BOOL;
    pub fn EnumChildWindows(parent: HWND, callback: WNDENUMPROC, lparam: LPARAM) -> BOOL;
    pub fn IsWindow(hwnd: HWND) -> BOOL;
    pub fn IsWindowVisible(hwnd: HWND) -> BOOL;
    pub fn GetWindowTextLengthW(hwnd: HWND) -> i32;
    pub fn GetWindowTextW(hwnd: HWND, text: *mut u16, max_count: i32) -> i32;
    pub fn GetClassNameW(hwnd: HWND, class_name: *mut u16, max_count: i32) -> i32;
    pub fn GetWindowThreadProcessId(hwnd: HWND, process_id: *mut DWORD) -> DWORD;
    pub fn GetWindowRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    pub fn GetClientRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    pub fn SetProcessDpiAwarenessContext(value: HANDLE) -> BOOL;
    pub fn ShowWindow(hwnd: HWND, command: i32) -> BOOL;
    pub fn SetForegroundWindow(hwnd: HWND) -> BOOL;
    pub fn BringWindowToTop(hwnd: HWND) -> BOOL;
    pub fn SetActiveWindow(hwnd: HWND) -> HWND;
    pub fn GetForegroundWindow() -> HWND;
    pub fn AttachThreadInput(id_attach: DWORD, id_attach_to: DWORD, attach: BOOL) -> BOOL;
    pub fn SetCursorPos(x: i32, y: i32) -> BOOL;
    pub fn GetCursorPos(point: *mut POINT) -> BOOL;
    pub fn SendInput(count: UINT, inputs: *const INPUT, size: i32) -> UINT;
    pub fn mouse_event(flags: DWORD, dx: DWORD, dy: DWORD, data: DWORD, extra_info: ULONG_PTR);
    pub fn keybd_event(vk: u8, scan: u8, flags: DWORD, extra_info: ULONG_PTR);
    pub fn GetGUIThreadInfo(thread_id: DWORD, info: *mut GUITHREADINFO) -> BOOL;
    pub fn ScreenToClient(hwnd: HWND, point: *mut POINT) -> BOOL;
    pub fn ChildWindowFromPointEx(parent: HWND, point: POINT, flags: UINT) -> HWND;
    pub fn VkKeyScanW(character: u16) -> i16;
    pub fn MapVirtualKeyW(code: UINT, map_type: UINT) -> UINT;
    pub fn SendMessageW(hwnd: HWND, message: UINT, wparam: WPARAM, lparam: LPARAM) -> LRESULT;

    pub fn RegisterClassExW(window_class: *const WNDCLASSEXW) -> u16;
    pub fn CreateWindowExW(
        ex_style: DWORD,
        class_name: *const u16,
        window_name: *const u16,
        style: DWORD,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: HWND,
        menu: HMENU,
        instance: HINSTANCE,
        parameter: *mut c_void,
    ) -> HWND;
    pub fn DefWindowProcW(hwnd: HWND, message: UINT, wparam: WPARAM, lparam: LPARAM) -> LRESULT;
    pub fn ShowCursor(show: BOOL) -> i32;
    pub fn GetMessageW(message: *mut MSG, hwnd: HWND, min: UINT, max: UINT) -> BOOL;
    pub fn TranslateMessage(message: *const MSG) -> BOOL;
    pub fn DispatchMessageW(message: *const MSG) -> LRESULT;
    pub fn PostQuitMessage(exit_code: i32);
    pub fn SetTimer(hwnd: HWND, id: usize, interval: UINT, callback: *const c_void) -> usize;
    pub fn InvalidateRect(hwnd: HWND, rect: *const RECT, erase: BOOL) -> BOOL;
    pub fn BeginPaint(hwnd: HWND, paint: *mut PAINTSTRUCT) -> HDC;
    pub fn EndPaint(hwnd: HWND, paint: *const PAINTSTRUCT) -> BOOL;
    pub fn FillRect(hdc: HDC, rect: *const RECT, brush: HBRUSH) -> i32;
    pub fn SetLayeredWindowAttributes(hwnd: HWND, color_key: DWORD, alpha: u8, flags: DWORD) -> BOOL;
    pub fn SetWindowPos(
        hwnd: HWND,
        insert_after: HWND,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        flags: UINT,
    ) -> BOOL;
    pub fn GetSystemMetrics(index: i32) -> i32;
    pub fn PrintWindow(hwnd: HWND, hdc: HDC, flags: UINT) -> BOOL;
    pub fn GetWindowDC(hwnd: HWND) -> HDC;
    pub fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    pub fn CreateCompatibleDC(hdc: HDC) -> HDC;
    pub fn DeleteDC(hdc: HDC) -> BOOL;
    pub fn CreateCompatibleBitmap(hdc: HDC, width: i32, height: i32) -> HBITMAP;
    pub fn SelectObject(hdc: HDC, object: HGDIOBJ) -> HGDIOBJ;
    pub fn DeleteObject(object: HGDIOBJ) -> BOOL;
    pub fn GetDIBits(
        hdc: HDC,
        bitmap: HBITMAP,
        start: UINT,
        lines: UINT,
        bits: *mut c_void,
        info: *mut BITMAPINFO,
        usage: UINT,
    ) -> i32;
    pub fn BitBlt(
        destination: HDC,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        source: HDC,
        source_x: i32,
        source_y: i32,
        operation: DWORD,
    ) -> BOOL;
    pub fn CreateSolidBrush(color: DWORD) -> HBRUSH;
    pub fn CreatePen(style: i32, width: i32, color: DWORD) -> HPEN;
    pub fn GetStockObject(index: i32) -> HGDIOBJ;
    pub fn Ellipse(hdc: HDC, left: i32, top: i32, right: i32, bottom: i32) -> BOOL;
}

#[link(name = "shell32")]
unsafe extern "system" {
    pub fn ShellExecuteW(
        hwnd: HWND,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show_command: i32,
    ) -> HINSTANCE;
}

pub fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn rgb(red: u8, green: u8, blue: u8) -> DWORD {
    red as DWORD | ((green as DWORD) << 8) | ((blue as DWORD) << 16)
}

pub fn null_handle() -> HANDLE {
    std::ptr::null_mut()
}

pub fn hwnd_topmost() -> HWND {
    (-1isize) as HWND
}
