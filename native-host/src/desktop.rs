// SPDX-License-Identifier: Apache-2.0

use crate::{uia, win32::*};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use jpeg_encoder::{ColorType, Encoder};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, mem,
    path::Path,
    ptr,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};

static LAST_INPUT_HWND: AtomicUsize = AtomicUsize::new(0);
static UIA_TIMEOUT_APPS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static UIA_ELEMENT_MAPS: OnceLock<Mutex<HashMap<u64, HashMap<u64, UiaElementTarget>>>> =
    OnceLock::new();

#[derive(Clone)]
struct UiaElementTarget {
    name: String,
    role: String,
    bounds: RECT,
}

const STALE_UIA_ELEMENT: &str = "UIA element index is unavailable or stale. Call get_window_state with include_text: true again.";
const APPS_FOLDER_PREFIX: &str = "shell:AppsFolder\\";
const PAINT_AUMID: &str = "Microsoft.Paint_8wekyb3d8bbwe!App";

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

pub fn validate_launch_app(app: &str) -> Result<String, String> {
    let requested = app.trim();
    if matches!(
        requested.to_ascii_lowercase().as_str(),
        "paint" | "mspaint" | "mspaint.exe"
    ) {
        return Ok(format!("{APPS_FOLDER_PREFIX}{PAINT_AUMID}"));
    }

    if requested
        .get(..APPS_FOLDER_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(APPS_FOLDER_PREFIX))
    {
        let aumid = &requested[APPS_FOLDER_PREFIX.len()..];
        let Some((package_family, app_id)) = aumid.split_once('!') else {
            return Err(
                "packaged app target must contain a Package Family Name and App ID separated by `!`"
                    .into(),
            );
        };
        let valid_part = |part: &str| {
            !part.is_empty()
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
                })
        };
        if !valid_part(package_family) || !valid_part(app_id) || app_id.contains('!') {
            return Err("packaged app target contains invalid AUMID characters".into());
        }
        return Ok(format!("{APPS_FOLDER_PREFIX}{aumid}"));
    }

    let executable = requested.strip_prefix("process:").unwrap_or(requested);
    let candidate = Path::new(executable);
    if !candidate.is_absolute() {
        return Err(
            "launch app requires an absolute .exe path, `paint`, or shell:AppsFolder\\<AUMID>"
                .into(),
        );
    }
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("exe") {
        return Err(
            "launch app only accepts an absolute .exe path or a packaged-app target".into(),
        );
    }
    if !candidate.is_file() {
        if candidate
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("mspaint.exe"))
        {
            return Ok(format!("{APPS_FOLDER_PREFIX}{PAINT_AUMID}"));
        }
        return Err(format!("launch app target does not exist: {executable}"));
    }
    candidate
        .canonicalize()
        .map_err(|error| format!("canonicalize launch app: {error}"))
        .map(|path| path.to_string_lossy().into_owned())
}

pub fn launch_app(app: &str) -> Result<(), String> {
    let target = validate_launch_app(app)?;
    let operation = wide("open");
    let file = wide(&target);
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
        Err(format!("launch app failed ({result}): {target}"))
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

fn child_elements(parent: HWND) -> Vec<HWND> {
    let mut children = Vec::new();
    unsafe {
        EnumChildWindows(
            parent,
            Some(enum_child),
            &mut children as *mut Vec<HWND> as LPARAM,
        );
    }
    children
}

fn element_hwnd(window: &WindowRef, index: u64) -> Result<HWND, String> {
    if index == 0 {
        return Ok(window.id as usize as HWND);
    }
    child_elements(window.id as usize as HWND)
        .get(index.saturating_sub(1) as usize)
        .copied()
        .ok_or_else(|| {
            format!(
                "element {index} no longer exists in {}",
                app_name(&window.app)
            )
        })
}

fn accessibility_tree(window: &WindowRef) -> (String, String, Vec<HWND>) {
    let root = window.id as usize as HWND;
    let children = child_elements(root);
    let mut elements = Vec::with_capacity(children.len() + 1);
    elements.push(root);
    elements.extend(children.iter().copied());

    let mut tree = format!(
        "Window: \"{}\", App: {}.\n",
        window.title,
        app_name(&window.app)
    );
    tree.push_str(&format!(
        "\t0 Window {} Secondary Actions: Raise\n",
        window.title
    ));
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
    let accessibility = if include_text {
        let (tree, focused_element, document_text) = match uia_snapshot(&window) {
            Ok(snapshot) => {
                cache_uia_elements(&window, &snapshot)?;
                (
                    snapshot.tree,
                    snapshot.focused_element,
                    snapshot.document_text,
                )
            }
            Err(_) => {
                let (tree, document_text, elements) = accessibility_tree(&window);
                cache_hwnd_elements(&window, &elements)?;
                (tree, String::new(), document_text)
            }
        };
        // Read focused control value and return it to the model. The model decides
        // whether to edit; type_text must not silently no-op based on this value.
        let focused_value = uia::focused_value().unwrap_or_default();
        json!({
            "tree": tree,
            "focused_element": focused_element,
            "focused_value": focused_value,
            "selected_text": "",
            "document_text": document_text,
        })
    } else {
        json!({})
    };
    let bounds = window_bounds(window.id)?;
    let screenshots = if include_screenshot {
        vec![capture_window(window.id)?]
    } else {
        Vec::new()
    };
    // Prefer screenshot pixel size as the coordinate space (matches capture bitmap).
    let (coord_w, coord_h) = if let Some(shot) = screenshots.first() {
        (
            shot.get("width").and_then(Value::as_i64).unwrap_or(bounds.width as i64) as i32,
            shot.get("height").and_then(Value::as_i64).unwrap_or(bounds.height as i64) as i32,
        )
    } else {
        (bounds.width, bounds.height)
    };
    Ok(json!({
        "window": window,
        "accessibility": accessibility,
        "screenshots": screenshots,
        // Explicit coordinate space for agents: click/drag/scroll x,y are in this space.
        "viewport": {
            "width": coord_w,
            "height": coord_h,
            "originX": bounds.left,
            "originY": bounds.top,
            "screenLeft": bounds.left,
            "screenTop": bounds.top,
            "screenRight": bounds.right,
            "screenBottom": bounds.bottom,
            "coordinate_space": "window_screenshot_pixels",
            "origin": "top_left",
            "click_xy": "x,y are relative to window top-left; same units as screenshots[0].width/height",
            "normalized": "optional: pass x,y in 0..1 to mean fractions of width/height",
            "grid_hint": "When UIA indexes are unusable, subdivide the viewport into a letter grid (see sky.grid in js) and click cell centers"
        },
        "cacheDiagnostics": {
            "accessibilityRevision": 1,
            "accessibilitySnapshotCount": if include_text { 1 } else { 0 },
            "captureCachedSessionCount": 0
        }
    }))
}

#[derive(Clone, Copy)]
struct WindowBounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    width: i32,
    height: i32,
}

fn window_bounds(id: u64) -> Result<WindowBounds, String> {
    let hwnd = id as usize as HWND;
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err("GetWindowRect failed".into());
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return Err("window has invalid bounds or is not visible".into());
    }
    Ok(WindowBounds {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width,
        height,
    })
}

fn cache_uia_elements(window: &WindowRef, snapshot: &uia::Snapshot) -> Result<(), String> {
    let elements = snapshot
        .elements
        .iter()
        .filter_map(|element| {
            element.bounds.map(|bounds| {
                (
                    element.index,
                    UiaElementTarget {
                        name: element.name.clone(),
                        role: element.role.clone(),
                        bounds,
                    },
                )
            })
        })
        .collect();
    UIA_ELEMENT_MAPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "UIA element map cache poisoned".to_string())?
        .insert(window.id, elements);
    Ok(())
}

fn cache_hwnd_elements(window: &WindowRef, elements: &[HWND]) -> Result<(), String> {
    let elements = elements
        .iter()
        .enumerate()
        .filter_map(|(index, hwnd)| {
            let mut bounds = RECT::default();
            if unsafe { IsWindow(*hwnd) } == 0
                || unsafe { GetWindowRect(*hwnd, &mut bounds) } == 0
                || bounds.right <= bounds.left
                || bounds.bottom <= bounds.top
            {
                return None;
            }
            let class = class_name(*hwnd);
            Some((
                index as u64,
                UiaElementTarget {
                    name: if index == 0 {
                        window.title.clone()
                    } else {
                        window_text(*hwnd)
                    },
                    role: if index == 0 {
                        "Window".to_string()
                    } else {
                        role_for_class(&class).to_string()
                    },
                    bounds,
                },
            ))
        })
        .collect();
    UIA_ELEMENT_MAPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "UIA element map cache poisoned".to_string())?
        .insert(window.id, elements);
    Ok(())
}

fn uia_element_target(window: &WindowRef, index: u64) -> Result<UiaElementTarget, String> {
    UIA_ELEMENT_MAPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "UIA element map cache poisoned".to_string())?
        .get(&window.id)
        .and_then(|elements| elements.get(&index))
        .cloned()
        .ok_or_else(|| STALE_UIA_ELEMENT.to_string())
}

fn uia_snapshot(window: &WindowRef) -> Result<uia::Snapshot, String> {
    if env::var_os("FASTCUA_TEST_FORCE_UIA_FALLBACK").is_some() {
        return Err("UI Automation fallback forced for regression testing".into());
    }
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
        let _ = timed_out
            .lock()
            .map(|mut apps| apps.insert(window.app.clone()));
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
    let element_index = params.get("element_index").and_then(Value::as_u64);
    activate_window(window.id)?;
    let (x, y) = match (params.get("x"), params.get("y")) {
        (Some(_), Some(_)) => screen_point_from_params(&window, params)?,
        _ => {
            let index =
                element_index.ok_or_else(|| "parse click params: missing field `x`".to_string())?;
            let target = uia_element_target(&window, index)?;
            let rect = target.bounds;
            if rect.right <= rect.left || rect.bottom <= rect.top {
                return Err(STALE_UIA_ELEMENT.into());
            }
            let mut window_rect = RECT::default();
            if unsafe { GetWindowRect(window.id as usize as HWND, &mut window_rect) } == 0 {
                return Err(STALE_UIA_ELEMENT.into());
            }
            let x = rect.left + (rect.right - rect.left) / 2;
            let y = rect.top + (rect.bottom - rect.top) / 2;
            if x < window_rect.left
                || x >= window_rect.right
                || y < window_rect.top
                || y >= window_rect.bottom
            {
                return Err(STALE_UIA_ELEMENT.into());
            }
            let _description = (&target.name, &target.role);
            (x, y)
        }
    };
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
        dispatch_click(if child.is_null() { parent } else { child }, x, y, &button)?;
        unsafe { Sleep(35) };
    }
    Ok(())
}

fn dispatch_click(target: HWND, screen_x: i32, screen_y: i32, button: &str) -> Result<(), String> {
    let class = class_name(target);
    if class.eq_ignore_ascii_case("button") && matches!(button, "left" | "l") {
        unsafe { SendMessageW(target, BM_CLICK, 0, 0) };
        return Ok(());
    }
    if class.eq_ignore_ascii_case("edit") {
        let mut point = POINT {
            x: screen_x,
            y: screen_y,
        };
        unsafe { ScreenToClient(target, &mut point) };
        let coordinates = ((point.y as u32 & 0xffff) << 16) | (point.x as u32 & 0xffff);
        let (down_message, up_message, mask) = match button {
            "right" | "r" => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
            "middle" | "m" => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
            "left" | "l" => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
            _ => return Err(format!("unsupported mouse button: {button}")),
        };
        unsafe {
            SendMessageW(target, down_message, mask, coordinates as LPARAM);
            SendMessageW(target, up_message, 0, coordinates as LPARAM);
        }
        return Ok(());
    }
    dispatch_input_click(button)
}

fn dispatch_input_click(button: &str) -> Result<(), String> {
    let (down, up) = match button {
        "right" | "r" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" | "m" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        "left" | "l" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        _ => return Err(format!("unsupported mouse button: {button}")),
    };
    send_mouse(down, 0)?;
    unsafe { Sleep(20) };
    send_mouse(up, 0)?;
    Ok(())
}

pub fn type_text(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing field `text`".to_string())?;
    // Control flow (model decides, host executes):
    //   1. Model READs via get_window_state.accessibility.focused_value
    //   2. Model decides whether to change the field
    //   3. If changing: type_text with replace:true (default) → clear then type
    //   4. If appending: type_text with replace:false
    // Host must NOT silently skip based on current value — that hides state from the model.
    let replace = params
        .get("replace")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if replace {
        clear_focused_text()?;
    }
    for unit in text.encode_utf16() {
        send_unicode(unit)?;
    }
    Ok(())
}

/// Select-all + delete on the focused control (key events, not UIA).
fn clear_focused_text() -> Result<(), String> {
    send_vk(VK_CONTROL, false)?;
    send_vk(0x41, false)?; // VK for 'A'
    send_vk(0x41, true)?;
    send_vk(VK_CONTROL, true)?;
    unsafe { Sleep(25) };
    send_vk(VK_DELETE, false)?;
    send_vk(VK_DELETE, true)?;
    unsafe { Sleep(15) };
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
    let (x, y) = screen_point_from_params(&window, params)?;
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
    let bounds = window_bounds(window.id)?;
    let from_x = map_axis(params, "from_x", bounds.width)?;
    let from_y = map_axis(params, "from_y", bounds.height)?;
    let to_x = map_axis(params, "to_x", bounds.width)?;
    let to_y = map_axis(params, "to_y", bounds.height)?;
    let (from_x, from_y) = screen_point(&window, from_x, from_y)?;
    let (to_x, to_y) = screen_point(&window, to_x, to_y)?;
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
        .ok_or_else(|| "missing field `element_index`".to_string())?;
    let value = params
        .get("value")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing field `value`".to_string())?;
    let target = element_hwnd(&window, index)?;
    if !class_name(target).eq_ignore_ascii_case("edit") {
        return Err(format!("element {index} does not support setting a value"));
    }
    let value = wide(value);
    let result = unsafe { SendMessageW(target, WM_SETTEXT, 0, value.as_ptr() as LPARAM) };
    if result == 0 {
        return Err(format!("set value failed for element {index}"));
    }
    LAST_INPUT_HWND.store(target as usize, Ordering::SeqCst);
    Ok(())
}

pub fn perform_secondary_action(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    let index = params
        .get("element_index")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let action = params.get("action").and_then(Value::as_str).unwrap_or("");
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

#[cfg(test)]
mod tests {
    use super::{APPS_FOLDER_PREFIX, PAINT_AUMID, validate_launch_app};

    #[test]
    fn paint_alias_resolves_to_packaged_app() {
        let expected = format!("{APPS_FOLDER_PREFIX}{PAINT_AUMID}");
        assert_eq!(validate_launch_app("paint").unwrap(), expected);
        assert_eq!(validate_launch_app("MSPAINT").unwrap(), expected);
        assert_eq!(
            validate_launch_app(r"C:\definitely-missing\mspaint.exe").unwrap(),
            expected
        );
    }

    #[test]
    fn apps_folder_aumid_is_validated() {
        let target = r"shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
        assert_eq!(validate_launch_app(target).unwrap(), target);
        assert!(validate_launch_app(r"shell:AppsFolder\missing-app-id").is_err());
        assert!(validate_launch_app(r"shell:AppsFolder\Family!App&command").is_err());
    }
}

fn screen_point(window: &WindowRef, x: i32, y: i32) -> Result<(i32, i32), String> {
    let bounds = window_bounds(window.id)?;
    if x < 0 || y < 0 || x >= bounds.width || y >= bounds.height {
        return Err(format!(
            "coordinate out of window bounds: ({x},{y}) not in [0..{w}) x [0..{h}). \
             Use get_window_state().viewport (width={w}, height={h}) or normalized 0..1 fractions. \
             Prefer element_index when UIA is available; otherwise use a letter-grid refine then click the cell center.",
            w = bounds.width,
            h = bounds.height
        ));
    }
    Ok((bounds.left + x, bounds.top + y))
}

/// Map one axis: pixels, or 0..=1 fraction of axis_size when the value is in that range
/// and the caller is using normalized mode (both axes 0..=1).
fn map_axis(params: &Value, key: &str, _axis_size: i32) -> Result<i32, String> {
    let value = params
        .get(key)
        .ok_or_else(|| format!("missing field `{key}`"))?;
    let f = value
        .as_f64()
        .or_else(|| value.as_i64().map(|i| i as f64))
        .ok_or_else(|| format!("invalid coordinate field `{key}`"))?;
    Ok(f.round() as i32)
}

fn map_axis_normalized(params: &Value, key: &str, axis_size: i32) -> Result<i32, String> {
    let value = params
        .get(key)
        .ok_or_else(|| format!("missing field `{key}`"))?;
    let f = value
        .as_f64()
        .or_else(|| value.as_i64().map(|i| i as f64))
        .ok_or_else(|| format!("invalid coordinate field `{key}`"))?;
    if axis_size <= 0 {
        return Err("invalid axis size".into());
    }
    let px = (f * (axis_size as f64 - 1.0)).round() as i32;
    Ok(px.clamp(0, axis_size.saturating_sub(1)))
}

fn screen_point_from_params(window: &WindowRef, params: &Value) -> Result<(i32, i32), String> {
    let bounds = window_bounds(window.id)?;
    let x_raw = params
        .get("x")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)))
        .ok_or_else(|| "missing field `x`".to_string())?;
    let y_raw = params
        .get("y")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)))
        .ok_or_else(|| "missing field `y`".to_string())?;
    // Normalized mode only when BOTH coords are in 0..=1 (Apple-style relative targeting).
    let normalized = (0.0..=1.0).contains(&x_raw) && (0.0..=1.0).contains(&y_raw);
    let (x, y) = if normalized {
        (
            map_axis_normalized(params, "x", bounds.width)?,
            map_axis_normalized(params, "y", bounds.height)?,
        )
    } else {
        (map_axis(params, "x", bounds.width)?, map_axis(params, "y", bounds.height)?)
    };
    screen_point(window, x, y)
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

#[allow(dead_code)]
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
