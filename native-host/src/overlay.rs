// SPDX-License-Identifier: Apache-2.0

use crate::win32::*;
use std::{
    mem, ptr,
    sync::atomic::{AtomicU32, Ordering},
    thread,
};

const COLOR_KEY: DWORD = 0x00ff_00ff;
static PULSE_PHASE: AtomicU32 = AtomicU32::new(0);

pub fn start_cursor_overlay() {
    thread::Builder::new()
        .name("cua-cursor-overlay".into())
        .spawn(|| unsafe { overlay_thread() })
        .expect("start cursor overlay thread");
}

unsafe fn overlay_thread() {
    let class_name = wide("OpenCuaCursorOverlayWindow");
    let title = wide("FastCUA Cursor Overlay");
    let instance = unsafe { GetModuleHandleW(ptr::null()) };
    let window_class = WNDCLASSEXW {
        cbSize: mem::size_of::<WNDCLASSEXW>() as UINT,
        style: 0,
        lpfnWndProc: Some(window_proc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: ptr::null_mut(),
        hCursor: ptr::null_mut(),
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class_name.as_ptr(),
        hIconSm: ptr::null_mut(),
    };
    unsafe { RegisterClassExW(&window_class) };

    let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            x,
            y,
            width,
            height,
            ptr::null_mut(),
            ptr::null_mut(),
            instance,
            ptr::null_mut(),
        )
    };
    if hwnd.is_null() {
        return;
    }
    unsafe {
        SetLayeredWindowAttributes(hwnd, COLOR_KEY, 255, LWA_COLORKEY);
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(
            hwnd,
            hwnd_topmost(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
        SetTimer(hwnd, 1, 33, ptr::null());
    }

    let mut message: MSG = unsafe { mem::zeroed() };
    while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: UINT,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => HTTRANSPARENT,
        WM_TIMER => {
            PULSE_PHASE.fetch_add(1, Ordering::Relaxed);
            unsafe { InvalidateRect(hwnd, ptr::null(), FALSE) };
            0
        }
        WM_PAINT => {
            let mut paint: PAINTSTRUCT = unsafe { mem::zeroed() };
            let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
            let mut client = RECT::default();
            unsafe { GetClientRect(hwnd, &mut client) };
            let background = unsafe { CreateSolidBrush(COLOR_KEY) };
            unsafe {
                FillRect(hdc, &client, background);
                DeleteObject(background);
            }

            let mut point = POINT::default();
            if unsafe { GetCursorPos(&mut point) } != 0 {
                point.x -= unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
                point.y -= unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };

                // Visual inspiration: QwenLM/open-computer-use CursorMotion experiment.
                // This is an independent Windows/GDI implementation: a restrained
                // cyan-violet pulse keeps the real hardware cursor easy to follow.
                let phase = PULSE_PHASE.load(Ordering::Relaxed) % 30;
                let pulse = 17 + (phase.min(30 - phase) as i32 / 3);
                let halo = unsafe { CreatePen(PS_SOLID, 2, rgb(139, 92, 246)) };
                let old_halo = unsafe { SelectObject(hdc, halo) };
                let hollow = unsafe { SelectObject(hdc, GetStockObject(HOLLOW_BRUSH)) };
                unsafe {
                    Ellipse(
                        hdc,
                        point.x - pulse,
                        point.y - pulse,
                        point.x + pulse,
                        point.y + pulse,
                    );
                    SelectObject(hdc, old_halo);
                    DeleteObject(halo);
                }

                let pen = unsafe { CreatePen(PS_SOLID, 3, rgb(34, 211, 238)) };
                let old_pen = unsafe { SelectObject(hdc, pen) };
                unsafe {
                    Ellipse(hdc, point.x - 12, point.y - 12, point.x + 12, point.y + 12);
                    SelectObject(hdc, hollow);
                    SelectObject(hdc, old_pen);
                    DeleteObject(pen);
                }

                let dot = unsafe { CreateSolidBrush(rgb(255, 255, 255)) };
                let old_dot = unsafe { SelectObject(hdc, dot) };
                unsafe {
                    Ellipse(hdc, point.x - 4, point.y - 4, point.x + 4, point.y + 4);
                    SelectObject(hdc, old_dot);
                    DeleteObject(dot);
                }
            }
            unsafe { EndPaint(hwnd, &paint) };
            0
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}
