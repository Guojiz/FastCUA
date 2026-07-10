// SPDX-License-Identifier: Apache-2.0

use crate::{uia, win32::*};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use jpeg_encoder::{ColorType, Encoder};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    mem,
    path::Path,
    ptr,
    sync::{Mutex, OnceLock, atomic::{AtomicUsize, Ordering}},
};

static LAST_INPUT_HWND: AtomicUsize = AtomicUsize::new(0);
static UIA_TIMEOUT_APPS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
pub struct WindowRef {
    pub app: String,
    pub id: u64,
    pub title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRef {
    pub display_name: String,
    pub id: String,
    pub is_running: bool,
    pub windows: Vec<WindowRef>,
}

unsafe extern "system" fn enum_top_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if unsafe { IsWindowVisible(hwnd) } == 0 {
        return TRUE;
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == 0 || pid == unsafe { GetCurrentProcessId() } {
        return TRUE;
    }
    let title = window_text(hwnd);
    if title.trim().is_empty() {
        return TRUE;
    }
    if let Some(path) = process_path(pid) {
        let windows = unsafe { &mut *(lparam as *mut Vec<WindowRef>) };
        windows.push(WindowRef {
            app: format!("process:{path}"),
            id: hwnd as usize as u64,
            title,
        });
    }
    TRUE
}

pub fn list_windows() -> Vec<WindowRef> {
    let mut windows = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_top_window),
            &mut windows as *mut Vec<WindowRef> as LPARAM,
        );
    }
    windows
}

pub fn list_apps() -> Vec<AppRef> {
    let mut grouped: BTreeMap<String, Vec<WindowRef>> = BTreeMap::new();
    for window in list_windows() {
        grouped.entry(window.app.clone()).or_default().push(window);
    }
    grouped
        .into_iter()
        .map(|(id, windows)| {
            let raw = id.strip_prefix("process:").unwrap_or(&id);
            let display_name = Path::new(raw)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(raw)
                .to_string();
            AppRef {
                display_name,
                id,
                is_running: true,
                windows,
            }
        })
        .collect()
}

pub fn get_window(id: u64, requested_app: Option<&str>) -> Result<WindowRef, String> {
    let hwnd = id as usize as HWND;
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(format!("window {id} no longer exists"));
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    let app = process_path(pid)
        .map(|path| format!("process:{path}"))
        .or_else(|| requested_app.map(str::to_owned))
        .ok_or_else(|| "resolve window process path".to_string())?;
    Ok(WindowRef {
        app,
        id,
        title: window_text(hwnd),
    })
}

pub fn launch_app(app: &str) -> Result<(), String> {
    let executable = app.strip_prefix("process:").unwrap_or(app);
    let operation = wide("open");
    let file = wide(executable);
    let result = unsafe {
        ShellExecuteW(
            ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            ptr::null(),
            ptr::null(),
            SW_SHOW,
        )
    } as usize;
    if result <= 32 {
        Err(format!("launch app failed ({result}): {executable}"))
    } else {
        Ok(())
    }
}

pub fn activate_window(id: u64) -> Result<(), String> {
    let hwnd = id as usize as HWND;
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err(format!("window {id} no longer exists"));
    }
    unsafe {
        ShowWindow(hwnd, SW_RESTORE);
        let foreground = GetForegroundWindow();
        let foreground_thread = if foreground.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground, ptr::null_mut())
        };
        let current_thread = GetCurrentThreadId();
        if foreground_thread != 0 && foreground_thread != current_thread {
            AttachThreadInput(current_thread, foreground_thread, TRUE);
        }
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        SetActiveWindow(hwnd);
        if foreground_thread != 0 && foreground_thread != current_thread {
            AttachThreadInput(current_thread, foreground_thread, FALSE);
        }
    }
    Ok(())
}

unsafe extern "system" fn enum_child(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if unsafe { IsWindowVisible(hwnd) } != 0 {
        let children = unsafe { &mut *(lparam as *mut Vec<HWND>) };
        children.push(hwnd);
    }
    TRUE
}

fn accessibility_tree(window: &WindowRef) -> (String, String, Vec<HWND>) {
    let root = window.id as usize as HWND;
    let mut children = Vec::new();
    unsafe {
        EnumChildWindows(
            root,
            Some(enum_child),
            &mut children as *mut Vec<HWND> as LPARAM,
        );
    }
    let mut elements = Vec::with_capacity(children.len() + 1);
    elements.push(root);
    elements.extend(children.iter().copied());

    let mut tree = format!("Window: \"{}\", App: {}.\n", window.title, app_name(&window.app));
    tree.push_str(&format!("\t0 Window {} Secondary Actions: Raise\n", window.title));
    let mut document_parts = Vec::new();
    for (index, hwnd) in children.iter().enumerate() {
        let name = window_text(*hwnd);
        let class = class_name(*hwnd);
        let role = role_for_class(&class);
        if !name.is_empty() {
            document_parts.push(name.clone());
        }
        tree.push_str(&format!(
            "\t\t{} {}{}{}\n",
            index + 1,
            role,
            if name.is_empty() { "" } else { " " },
            name
        ));
    }
    (tree, document_parts.join("\n"), elements)
}

pub fn get_window_state(
    window: WindowRef,
    include_screenshot: bool,
    include_text: bool,
) -> Result<Value, String> {
    activate_window(window.id)?;
    let (tree, focused_element, document_text) = match uia_snapshot(&window) {
        Ok(snapshot) => (
            snapshot.tree,
            snapshot.focused_element,
            snapshot.document_text,
        ),
        Err(_) => {
            let (tree, document_text, _) = accessibility_tree(&window);
            (tree, String::new(), document_text)
        }
    };
    let accessibility = if include_text {
        json!({
            "tree": tree,
            "focused_element": focused_element,
            "selected_text": "",
            "document_text": document_text,
        })
    } else {
        json!({})
    };
    let screenshots = if include_screenshot {
        vec![capture_window(window.id)?]
    } else {
        Vec::new()
    };
    Ok(json!({
        "window": window,
        "accessibility": accessibility,
        "screenshots": screenshots,
        "cacheDiagnostics": {
            "accessibilityRevision": 1,
            "accessibilitySnapshotCount": 1,
            "captureCachedSessionCount": 0
        }
    }))
}

fn uia_snapshot(window: &WindowRef) -> Result<uia::Snapshot, String> {
    let timed_out = UIA_TIMEOUT_APPS.get_or_init(|| Mutex::new(HashSet::new()));
    if timed_out
        .lock()
        .map_err(|_| "UIA timeout cache poisoned".to_string())?
        .contains(&window.app)
    {
        return Err("UI Automation disabled after provider timeout".into());
    }
    let result = uia::snapshot(
        window.id as usize as HWND,
        &window.title,
        &app_name(&window.app),
    );
    if matches!(&result, Err(message) if message.contains("timed out")) {
        let _ = timed_out.lock().map(|mut apps| apps.insert(window.app.clone()));
    }
    result
}

fn capture_window(id: u64) -> Result<Value, String> {
    let hwnd = id as usize as HWND;
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err("GetWindowRect failed".into());
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 || width > u16::MAX as i32 || height > u16::MAX as i32 {
        return Err("window has invalid bounds or is not visible".into());
    }
    let source = unsafe { GetWindowDC(hwnd) };
    if source.is_null() {
        return Err("GetWindowDC failed".into());
    }
    let memory = unsafe { CreateCompatibleDC(source) };
    let bitmap = unsafe { CreateCompatibleBitmap(source, width, height) };
    if memory.is_null() || bitmap.is_null() {
        unsafe { ReleaseDC(hwnd, source) };
        return Err("create screenshot bitmap failed".into());
    }
    let previous = unsafe { SelectObject(memory, bitmap) };
    if unsafe { PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT) } == 0 {
        unsafe {
            BitBlt(
                memory,
                0,
                0,
                width,
                height,
                source,
                0,
                0,
                SRCCOPY | CAPTUREBLT,
            );
        }
    }

    let mut info = BITMAPINFO::default();
    info.bmiHeader.biSize = mem::size_of::<BITMAPINFOHEADER>() as DWORD;
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    let mut bgra = vec![0u8; width as usize * height as usize * 4];
    let copied = unsafe {
        GetDIBits(
            memory,
            bitmap,
            0,
            height as UINT,
            bgra.as_mut_ptr().cast(),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(hwnd, source);
    }
    if copied == 0 {
        return Err("GetDIBits failed".into());
    }

    let mut rgb_data = Vec::with_capacity(width as usize * height as usize * 3);
    for pixel in bgra.chunks_exact(4) {
        rgb_data.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    let mut jpeg = Vec::new();
    Encoder::new(&mut jpeg, 82)
        .encode(&rgb_data, width as u16, height as u16, ColorType::Rgb)
        .map_err(|error| format!("JPEG encode failed: {error}"))?;
    Ok(json!({
        "id": "screenshot-0",
        "url": format!("data:image/jpeg;base64,{}", BASE64.encode(jpeg)),
        "width": width,
        "height": height,
        "originX": rect.left,
        "originY": rect.top,
        "zIndex": 0
    }))
}

pub fn click(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    if params.get("x").is_none() || params.get("y").is_none() {
        return Err("parse click params: missing field `x`".into());
    }
    activate_window(window.id)?;
    let (x, y) = screen_point(&window, number(params, "x")?, number(params, "y")?)?;
    let parent = window.id as usize as HWND;
    let mut client_point = POINT { x, y };
    unsafe { ScreenToClient(parent, &mut client_point) };
    let child = unsafe {
        ChildWindowFromPointEx(
            parent,
            client_point,
            CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
        )
    };
    LAST_INPUT_HWND.store(
        if child.is_null() { parent } else { child } as usize,
        Ordering::SeqCst,
    );
    unsafe { SetCursorPos(x, y) };
    let button = params
        .get("mouse_button")
        .and_then(Value::as_str)
        .unwrap_or("left")
        .to_ascii_lowercase();
    let count = params
        .get("click_count")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 3);
    for _ in 0..count {
        dispatch_window_click(if child.is_null() { parent } else { child }, x, y, &button)?;
        unsafe { Sleep(35) };
    }
    Ok(())
}

fn dispatch_window_click(target: HWND, screen_x: i32, screen_y: i32, button: &str) -> Result<(), String> {
    if class_name(target).eq_ignore_ascii_case("button") && matches!(button, "left" | "l") {
        unsafe { SendMessageW(target, BM_CLICK, 0, 0) };
        return Ok(());
    }
    let mut point = POINT {
        x: screen_x,
        y: screen_y,
    };
    unsafe { ScreenToClient(target, &mut point) };
    let coordinates = ((point.y as u32 & 0xffff) << 16) | (point.x as u32 & 0xffff);
    let (down_message, up_message, mask) = match button {
        "right" | "r" => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
        "middle" | "m" => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
        _ => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
    };
    unsafe {
        SendMessageW(target, down_message, mask, coordinates as LPARAM);
        SendMessageW(target, up_message, 0, coordinates as LPARAM);
    }
    Ok(())
}

pub fn type_text(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing field `text`".to_string())?;
    for unit in text.encode_utf16() {
        send_unicode(unit)?;
    }
    Ok(())
}

pub fn press_key(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let chord = params
        .get("key")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing field `key`".to_string())?;
    let mut keys = Vec::new();
    for token in chord.split('+').filter(|token| !token.is_empty()) {
        keys.push(key_to_vk(token).ok_or_else(|| format!("unsupported key: {token}"))?);
    }
    if keys.is_empty() {
        return Err("empty key chord".into());
    }
    for key in &keys {
        send_vk(*key, false)?;
    }
    for key in keys.iter().rev() {
        send_vk(*key, true)?;
    }
    Ok(())
}

pub fn scroll(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let (x, y) = screen_point(&window, number(params, "x")?, number(params, "y")?)?;
    unsafe { SetCursorPos(x, y) };
    let vertical = params.get("scrollY").and_then(Value::as_i64).unwrap_or(0) as i32;
    let horizontal = params.get("scrollX").and_then(Value::as_i64).unwrap_or(0) as i32;
    if vertical != 0 {
        send_mouse(MOUSEEVENTF_WHEEL, (-vertical) as u32)?;
    }
    if horizontal != 0 {
        send_mouse(MOUSEEVENTF_HWHEEL, horizontal as u32)?;
    }
    Ok(())
}

pub fn drag(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let (from_x, from_y) = screen_point(
        &window,
        number(params, "from_x")?,
        number(params, "from_y")?,
    )?;
    let (to_x, to_y) = screen_point(
        &window,
        number(params, "to_x")?,
        number(params, "to_y")?,
    )?;
    unsafe { SetCursorPos(from_x, from_y) };
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
    for step in 1..=20 {
        let x = from_x + (to_x - from_x) * step / 20;
        let y = from_y + (to_y - from_y) * step / 20;
        unsafe {
            SetCursorPos(x, y);
            Sleep(8);
        }
    }
    send_mouse(MOUSEEVENTF_LEFTUP, 0)?;
    Ok(())
}

pub fn set_value(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    let index = params
        .get("element_index")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Err(format!(
        "element {index} no longer exists in {}",
        app_name(&window.app)
    ))
}

pub fn perform_secondary_action(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    let index = params
        .get("element_index")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("");
    if index == 0 && action.eq_ignore_ascii_case("raise") {
        activate_window(window.id)
    } else {
        Err(format!("unsupported secondary action: {action}"))
    }
}

pub fn params_window(params: &Value) -> Result<WindowRef, String> {
    let object = params
        .get("window")
        .ok_or_else(|| "missing field `window`".to_string())?;
    let id = object
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| "window missing field `id`".to_string())?;
    let app = object.get("app").and_then(Value::as_str);
    get_window(id, app)
}

fn screen_point(window: &WindowRef, x: i32, y: i32) -> Result<(i32, i32), String> {
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(window.id as usize as HWND, &mut rect) } == 0 {
        return Err("GetWindowRect failed".into());
    }
    Ok((rect.left + x, rect.top + y))
}

fn send_mouse(flags: DWORD, data: DWORD) -> Result<(), String> {
    unsafe { mouse_event(flags, 0, 0, data, 0) };
    Ok(())
}

fn send_vk(key: WORD, up: bool) -> Result<(), String> {
    let scan = unsafe { MapVirtualKeyW(key as UINT, MAPVK_VK_TO_VSC) } as u8;
    unsafe { keybd_event(key as u8, scan, if up { KEYEVENTF_KEYUP } else { 0 }, 0) };
    Ok(())
}

fn send_unicode(unit: WORD) -> Result<(), String> {
    let last = LAST_INPUT_HWND.load(Ordering::SeqCst) as HWND;
    let target = if !last.is_null() {
        last
    } else {
        let mut info: GUITHREADINFO = unsafe { mem::zeroed() };
        info.cbSize = mem::size_of::<GUITHREADINFO>() as DWORD;
        if unsafe { GetGUIThreadInfo(0, &mut info) } == 0 || info.hwndFocus.is_null() {
            return Err("resolve focused window for text input".into());
        }
        info.hwndFocus
    };
    unsafe { SendMessageW(target, WM_CHAR, unit as WPARAM, 1) };
    Ok(())
}

fn key_to_vk(token: &str) -> Option<WORD> {
    let normalized = token.trim().to_ascii_uppercase().replace('-', "_");
    let key = match normalized.as_str() {
        "CTRL" | "CONTROL" | "CONTROL_L" | "CONTROL_R" => VK_CONTROL,
        "SHIFT" | "SHIFT_L" | "SHIFT_R" => VK_SHIFT,
        "ALT" | "ALT_L" | "ALT_R" | "MENU" => VK_MENU,
        "RETURN" | "ENTER" | "KP_ENTER" | "NUMPAD_ENTER" => VK_RETURN,
        "ESC" | "ESCAPE" => VK_ESCAPE,
        "TAB" => VK_TAB,
        "BACKSPACE" => VK_BACK,
        "DELETE" | "DEL" => VK_DELETE,
        "INSERT" | "INS" => VK_INSERT,
        "HOME" | "BEGIN" => VK_HOME,
        "END" => VK_END,
        "PAGEUP" | "PAGE_UP" | "PRIOR" => VK_PRIOR,
        "PAGEDOWN" | "PAGE_DOWN" | "NEXT" => VK_NEXT,
        "UP" => VK_UP,
        "DOWN" => VK_DOWN,
        "LEFT" => VK_LEFT,
        "RIGHT" => VK_RIGHT,
        "SPACE" => VK_SPACE,
        _ if normalized.starts_with('F') => {
            let number = normalized[1..].parse::<u16>().ok()?;
            if (1..=20).contains(&number) {
                VK_F1 + number - 1
            } else {
                return None;
            }
        }
        _ if normalized.len() == 1 => {
            let character = normalized.encode_utf16().next()?;
            let scanned = unsafe { VkKeyScanW(character) };
            if scanned == -1 {
                return None;
            }
            scanned as WORD & 0xff
        }
        _ if normalized.starts_with("KP_") || normalized.starts_with("NUMPAD_") => {
            let suffix = normalized.rsplit('_').next()?;
            match suffix {
                value if value.len() == 1 && value.as_bytes()[0].is_ascii_digit() => {
                    0x60 + value.parse::<u16>().ok()?
                }
                "MULTIPLY" => 0x6a,
                "ADD" | "PLUS" => 0x6b,
                "SUBTRACT" | "MINUS" => 0x6d,
                "DECIMAL" | "PERIOD" | "DOT" => 0x6e,
                "DIVIDE" | "SLASH" => 0x6f,
                _ => return None,
            }
        }
        _ => return None,
    };
    Some(key)
}

fn number(params: &Value, key: &str) -> Result<i32, String> {
    params
        .get(key)
        .and_then(Value::as_i64)
        .map(|value| value as i32)
        .ok_or_else(|| format!("missing field `{key}`"))
}

fn window_text(hwnd: HWND) -> String {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    let mut buffer = vec![0u16; length.max(0) as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = vec![0u16; 256];
    let copied = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
}

fn role_for_class(class: &str) -> &'static str {
    match class.to_ascii_lowercase().as_str() {
        "static" => "Text",
        "edit" => "Edit",
        "button" => "Button",
        "listbox" => "List",
        "combobox" => "ComboBox",
        "scrollbar" => "ScrollBar",
        "msctls_trackbar32" => "Slider",
        "systreeview32" => "Tree",
        "syslistview32" => "List",
        _ => "Pane",
    }
}

fn process_path(pid: DWORD) -> Option<String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
    if process.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 32_768];
    let mut size = buffer.len() as DWORD;
    let success = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(process) };
    if success == 0 {
        None
    } else {
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn app_name(app: &str) -> String {
    let raw = app.strip_prefix("process:").unwrap_or(app);
    Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(raw)
        .to_string()
}
