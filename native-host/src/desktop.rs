// SPDX-License-Identifier: MIT

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
            "grid_hint": "When UIA is unusable: sky.grid(viewport) packs SQUARE number cells (3 rows, else 2). SELECT a number (no click). sky.grid_refine(grid,id) → 3x3 squares INSIDE that cell only. sky.click_cell only when ready."
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
    if let Some(target) = uia_element_target_cached(window, index) {
        return Ok(target);
    }
    // One live re-snapshot after UI churn (common dialogs / virtualized trees).
    if let Ok(snapshot) = uia_snapshot(window) {
        let _ = cache_uia_elements(window, &snapshot);
        if let Some(target) = uia_element_target_cached(window, index) {
            return Ok(target);
        }
    }
    Err(STALE_UIA_ELEMENT.to_string())
}

fn uia_element_target_cached(window: &WindowRef, index: u64) -> Option<UiaElementTarget> {
    UIA_ELEMENT_MAPS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?
        .get(&window.id)?
        .get(&index)
        .cloned()
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

struct CapturedRgb {
    width: i32,
    height: i32,
    origin_x: i32,
    origin_y: i32,
    rgb: Vec<u8>,
}

fn capture_window_rgb(id: u64) -> Result<CapturedRgb, String> {
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

    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for pixel in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
    }
    Ok(CapturedRgb {
        width,
        height,
        origin_x: rect.left,
        origin_y: rect.top,
        rgb,
    })
}

fn encode_jpeg_rgb(rgb: &[u8], width: i32, height: i32, quality: u8) -> Result<Vec<u8>, String> {
    let mut jpeg = Vec::new();
    Encoder::new(&mut jpeg, quality)
        .encode(rgb, width as u16, height as u16, ColorType::Rgb)
        .map_err(|error| format!("JPEG encode failed: {error}"))?;
    Ok(jpeg)
}

fn capture_window(id: u64) -> Result<Value, String> {
    let cap = capture_window_rgb(id)?;
    let jpeg = encode_jpeg_rgb(&cap.rgb, cap.width, cap.height, 82)?;
    Ok(json!({
        "id": "screenshot-0",
        "url": format!("data:image/jpeg;base64,{}", BASE64.encode(jpeg)),
        "width": cap.width,
        "height": cap.height,
        "originX": cap.origin_x,
        "originY": cap.origin_y,
        "zIndex": 0
    }))
}

#[derive(Clone, Debug)]
struct GridCell {
    id: String,
    row: i32,
    col: i32,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    cx: i32,
    cy: i32,
    side: i32,
}

/// Apple-like square packing. `refine`: force 3×3 squares inside the region.
fn pack_square_cells(left: i32, top: i32, right: i32, bottom: i32, refine: bool) -> (i32, i32, i32, Vec<GridCell>) {
    let rw = (right - left).max(1);
    let rh = (bottom - top).max(1);
    let (rows, cols, side, origin_left, origin_top) = if refine {
        let side = (rw.min(rh) as f64) / 3.0;
        let side_i = side.max(1.0);
        let gl = left as f64 + (rw as f64 - side_i * 3.0) / 2.0;
        let gt = top as f64 + (rh as f64 - side_i * 3.0) / 2.0;
        (3, 3, side_i, gl, gt)
    } else {
        // Prefer 3 rows of squares; if width too tight, 2 rows.
        let mut rows = 3i32;
        let mut side = rh as f64 / 3.0;
        let mut cols = (rw as f64 / side + 1e-6).floor() as i32;
        if cols < 2 {
            rows = 2;
            side = rh as f64 / 2.0;
            cols = (rw as f64 / side + 1e-6).floor() as i32;
        }
        if cols < 1 {
            rows = 1;
            cols = 1;
            side = rw.min(rh) as f64;
        }
        let side_i = side.max(1.0);
        let gl = left as f64 + (rw as f64 - side_i * cols as f64) / 2.0;
        let gt = top as f64 + (rh as f64 - side_i * rows as f64) / 2.0;
        (rows, cols, side_i, gl, gt)
    };

    let mut cells = Vec::new();
    let mut id = 1i32;
    for r in 0..rows {
        for c in 0..cols {
            let l = origin_left + c as f64 * side;
            let t = origin_top + r as f64 * side;
            let rr = l + side;
            let bb = t + side;
            let li = l.round() as i32;
            let ti = t.round() as i32;
            let ri = rr.round() as i32;
            let bi = bb.round() as i32;
            cells.push(GridCell {
                id: id.to_string(),
                row: r,
                col: c,
                left: li,
                top: ti,
                right: ri,
                bottom: bi,
                cx: (li + ri) / 2,
                cy: (ti + bi) / 2,
                side: (ri - li).max(1),
            });
            id += 1;
        }
    }
    (rows, cols, side.round() as i32, cells)
}

fn crop_rgb(
    rgb: &[u8],
    full_w: i32,
    full_h: i32,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
) -> Result<(i32, i32, Vec<u8>), String> {
    let l = left.clamp(0, full_w);
    let t = top.clamp(0, full_h);
    let r = right.clamp(0, full_w).max(l + 1);
    let b = bottom.clamp(0, full_h).max(t + 1);
    let cw = r - l;
    let ch = b - t;
    let mut out = vec![0u8; (cw * ch * 3) as usize];
    for y in 0..ch {
        let src_y = t + y;
        if src_y < 0 || src_y >= full_h {
            continue;
        }
        let src_off = ((src_y * full_w + l) * 3) as usize;
        let dst_off = (y * cw * 3) as usize;
        let n = (cw * 3) as usize;
        out[dst_off..dst_off + n].copy_from_slice(&rgb[src_off..src_off + n]);
    }
    Ok((cw, ch, out))
}

/// Blend a color onto RGB with alpha in 0..1 (UI stays readable under the grid).
fn blend_px(rgb: &mut [u8], w: i32, h: i32, x: i32, y: i32, r: u8, g: u8, b: u8, a: f32) {
    if x < 0 || y < 0 || x >= w || y >= h {
        return;
    }
    let i = ((y * w + x) * 3) as usize;
    let a = a.clamp(0.0, 1.0);
    let ia = 1.0 - a;
    rgb[i] = (rgb[i] as f32 * ia + r as f32 * a).round() as u8;
    rgb[i + 1] = (rgb[i + 1] as f32 * ia + g as f32 * a).round() as u8;
    rgb[i + 2] = (rgb[i + 2] as f32 * ia + b as f32 * a).round() as u8;
}

fn draw_hline(rgb: &mut [u8], w: i32, h: i32, y: i32, x0: i32, x1: i32, thick: i32, r: u8, g: u8, b: u8, a: f32) {
    let half = thick / 2;
    for dy in -half..=(thick - 1 - half) {
        for x in x0..=x1 {
            blend_px(rgb, w, h, x, y + dy, r, g, b, a);
        }
    }
}

fn draw_vline(rgb: &mut [u8], w: i32, h: i32, x: i32, y0: i32, y1: i32, thick: i32, r: u8, g: u8, b: u8, a: f32) {
    let half = thick / 2;
    for dx in -half..=(thick - 1 - half) {
        for y in y0..=y1 {
            blend_px(rgb, w, h, x + dx, y, r, g, b, a);
        }
    }
}

// 5×7 bitmap digits 0-9 (row-major, bit 0 = left).
const DIGIT_FONT: [[u8; 7]; 10] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110], // 0
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110], // 1
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111], // 2
    [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110], // 3
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010], // 4
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110], // 5
    [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110], // 6
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000], // 7
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110], // 8
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100], // 9
];

fn draw_digit(
    rgb: &mut [u8],
    w: i32,
    h: i32,
    digit: u8,
    cx: i32,
    cy: i32,
    scale: i32,
    fill: (u8, u8, u8),
    outline: (u8, u8, u8),
) {
    if digit > 9 {
        return;
    }
    let scale = scale.max(1);
    let gw = 5 * scale;
    let gh = 7 * scale;
    let ox = cx - gw / 2;
    let oy = cy - gh / 2;
    let font = &DIGIT_FONT[digit as usize];
    // Outline first (1px ring), then fill — keeps numbers readable without solid plate.
    for pass in 0..2 {
        let (r, g, b) = if pass == 0 { outline } else { fill };
        let a = if pass == 0 { 0.55 } else { 0.72 };
        for row in 0..7 {
            let bits = font[row];
            for col in 0..5 {
                if (bits >> (4 - col)) & 1 == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let px = ox + col * scale + sx;
                        let py = oy + row as i32 * scale + sy;
                        if pass == 0 {
                            for dy in -1..=1 {
                                for dx in -1..=1 {
                                    if dx == 0 && dy == 0 {
                                        continue;
                                    }
                                    blend_px(rgb, w, h, px + dx, py + dy, r, g, b, a * 0.7);
                                }
                            }
                        } else {
                            blend_px(rgb, w, h, px, py, r, g, b, a);
                        }
                    }
                }
            }
        }
    }
}

/// Draw square cell borders (semi-transparent) + outlined numbers. Does not fill cell interiors.
fn draw_square_grid_overlay(rgb: &mut [u8], w: i32, h: i32, cells: &[GridCell]) {
    if cells.is_empty() {
        return;
    }
    let side = cells[0].side.max(1);
    // Thin lines relative to cell size — visible but not a heavy cage.
    let thick = (side / 90).clamp(1, 2);
    // Cyan-ish stroke at ~38% so UI underneath stays legible.
    let (lr, lg, lb, la) = (80u8, 220u8, 255u8, 0.38f32);
    for cell in cells {
        // Rectangle outline only (no fill).
        draw_hline(rgb, w, h, cell.top, cell.left, cell.right, thick, lr, lg, lb, la);
        draw_hline(rgb, w, h, cell.bottom - 1, cell.left, cell.right, thick, lr, lg, lb, la);
        draw_vline(rgb, w, h, cell.left, cell.top, cell.bottom, thick, lr, lg, lb, la);
        draw_vline(rgb, w, h, cell.right - 1, cell.top, cell.bottom, thick, lr, lg, lb, la);
    }
    for cell in cells {
        // Small digits dead-center on the cell (same as click target cx,cy).
        // Keep ~8–12% of side so the midpoint stays obvious and UI is not covered.
        let scale = ((side as f64) * 0.045).round() as i32;
        let scale = scale.clamp(1, 3);
        let digits: Vec<u8> = cell
            .id
            .chars()
            .filter_map(|ch| ch.to_digit(10).map(|d| d as u8))
            .collect();
        if digits.is_empty() {
            continue;
        }
        // Glyph is 5*scale wide; 1*scale gap between digits. Whole block centered on (cx,cy).
        let glyph_w = 5 * scale;
        let gap = scale;
        let total_w = digits.len() as i32 * glyph_w + (digits.len() as i32 - 1).max(0) * gap;
        let mut x = cell.cx - total_w / 2 + glyph_w / 2;
        for d in digits {
            draw_digit(
                rgb,
                w,
                h,
                d,
                x,
                cell.cy, // vertical center of cell = click midpoint
                scale,
                (255, 255, 255),
                (0, 0, 0),
            );
            x += glyph_w + gap;
        }
    }
}

/// One screenshot with square number grid overlaid. Optional `path` of cell ids drills in
/// (crop to selection → 3×3 squares only inside). Single image to save tokens.
pub fn grid_view(params: &Value) -> Result<Value, String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let cap = capture_window_rgb(window.id)?;

    let path: Vec<String> = params
        .get("path")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // Walk path on full-window coordinates to find the crop region.
    let mut region_l = 0i32;
    let mut region_t = 0i32;
    let mut region_r = cap.width;
    let mut region_b = cap.height;
    for (depth, id) in path.iter().enumerate() {
        // depth 0: initial square pack; depth>=1: 3×3 refine inside previous cell.
        let (_rows, _cols, _side, cells) =
            pack_square_cells(region_l, region_t, region_r, region_b, depth > 0);
        let cell = cells.iter().find(|c| c.id == *id).ok_or_else(|| {
            format!(
                "unknown grid cell id `{id}` at depth {depth}; valid: {}",
                cells
                    .iter()
                    .map(|c| c.id.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })?;
        region_l = cell.left;
        region_t = cell.top;
        region_r = cell.right;
        region_b = cell.bottom;
    }

    // Display: crop to current region (token-friendly zoom) and draw CURRENT level grid.
    let display_refine = !path.is_empty();
    let (rows, cols, side, cells_abs) =
        pack_square_cells(region_l, region_t, region_r, region_b, display_refine);

    let (cw, ch, mut crop) = crop_rgb(
        &cap.rgb,
        cap.width,
        cap.height,
        region_l,
        region_t,
        region_r,
        region_b,
    )?;

    let cells_local: Vec<GridCell> = cells_abs
        .iter()
        .map(|c| GridCell {
            id: c.id.clone(),
            row: c.row,
            col: c.col,
            left: c.left - region_l,
            top: c.top - region_t,
            right: c.right - region_l,
            bottom: c.bottom - region_t,
            cx: c.cx - region_l,
            cy: c.cy - region_t,
            side: c.side,
        })
        .collect();

    draw_square_grid_overlay(&mut crop, cw, ch, &cells_local);

    let jpeg = encode_jpeg_rgb(&crop, cw, ch, 72)?;
    let cells_json: Vec<Value> = cells_abs
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "row": c.row,
                "col": c.col,
                "left": c.left,
                "top": c.top,
                "right": c.right,
                "bottom": c.bottom,
                "cx": c.cx,
                "cy": c.cy,
                "width": c.side,
                "height": c.side,
                "square": true
            })
        })
        .collect();

    Ok(json!({
        "window": window,
        "path": path,
        "select_only": true,
        "phase": if display_refine { "refine" } else { "initial" },
        "viewport": {
            "width": cap.width,
            "height": cap.height,
            "originX": cap.origin_x,
            "originY": cap.origin_y,
            "coordinate_space": "window_screenshot_pixels",
            "origin": "top_left",
            "click_xy": "grid cells use absolute window pixels (cx,cy); click_cell uses those"
        },
        "view": {
            "cropLeft": region_l,
            "cropTop": region_t,
            "cropRight": region_r,
            "cropBottom": region_b,
            "width": cw,
            "height": ch,
            "note": "Single annotated image: semi-transparent square outlines + outlined numbers. Crop zooms current region."
        },
        "grid": {
            "width": cap.width,
            "height": cap.height,
            "cols": cols,
            "rows": rows,
            "side": side,
            "mode": "square",
            "phase": if display_refine { "refine" } else { "initial" },
            "path": path,
            "region": { "left": region_l, "top": region_t, "right": region_r, "bottom": region_b },
            "cells": cells_json,
            "select_only": true,
            "howto": "SELECT a number (no click). Refine: grid_view path+[id]. Click: click_cell only when ready."
        },
        "screenshots": [{
            "id": "grid-0",
            "url": format!("data:image/jpeg;base64,{}", BASE64.encode(jpeg)),
            "width": cw,
            "height": ch,
            "originX": cap.origin_x + region_l,
            "originY": cap.origin_y + region_t,
            "zIndex": 0,
            "annotated": true,
            "overlay": "square_cells_semi_transparent_lines_outlined_numbers"
        }]
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
            // Prefer element center; clamp if slightly outside outer HWND
            // (nav-pane / DirectUI often report partial or inflated bounds).
            let mut x = rect.left + (rect.right - rect.left) / 2;
            let mut y = rect.top + (rect.bottom - rect.top) / 2;
            if x < window_rect.left
                || x >= window_rect.right
                || y < window_rect.top
                || y >= window_rect.bottom
            {
                x = x.clamp(window_rect.left + 1, window_rect.right - 2);
                y = y.clamp(window_rect.top + 1, window_rect.bottom - 2);
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
    // Prefer real injected input. Common item dialogs / DirectUI often ignore
    // SendMessage(BM_CLICK) / synthetic WM_LBUTTON* while still accepting SendInput.
    let _ = (target, screen_x, screen_y);
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
