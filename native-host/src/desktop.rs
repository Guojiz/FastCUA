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
    sync::{Mutex, OnceLock, mpsc},
    thread,
    time::Duration,
};

static UIA_TIMEOUT_APPS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static UIA_ELEMENT_MAPS: OnceLock<Mutex<HashMap<u64, HashMap<u64, UiaElementTarget>>>> =
    OnceLock::new();

#[derive(Clone)]
struct UiaElementTarget {
    name: String,
    role: String,
    bounds: RECT,
}

const STALE_UIA_ELEMENT: &str = "UIA element index is unavailable or stale. Call get_window_state with include_text: true again. Prefer sky.grid_view({window}) immediately; do not retry this element_index.";
const APPS_FOLDER_PREFIX: &str = "shell:AppsFolder\\";
const PAINT_AUMID: &str = "Microsoft.Paint_8wekyb3d8bbwe!App";
/// Let the Windows input stack settle before click/scroll/drag dispatch.
const MOVE_SETTLE_MS: u32 = 50;

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

fn canonical_app(value: &str) -> String {
    value.replace('/', "\\").to_ascii_lowercase()
}

fn get_window_exact(id: u64, requested_app: Option<&str>) -> Result<WindowRef, String> {
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
    if requested_app.is_some_and(|requested| canonical_app(requested) != canonical_app(&app)) {
        return Err(format!(
            "window {id} now belongs to a different application"
        ));
    }
    Ok(WindowRef {
        app,
        id,
        title: window_text(hwnd),
    })
}

pub fn get_window(id: u64, requested_app: Option<&str>) -> Result<WindowRef, String> {
    if let Ok(window) = get_window_exact(id, requested_app) {
        return Ok(window);
    }
    let Some(requested_app) = requested_app else {
        return Err(format!("window {id} no longer exists"));
    };
    let requested = canonical_app(requested_app);
    let mut matches = list_windows()
        .into_iter()
        .filter(|window| canonical_app(&window.app) == requested);
    let Some(window) = matches.next() else {
        return Err(format!(
            "window {id} no longer exists and no current window matches {requested_app}"
        ));
    };
    if matches.next().is_some() {
        return Err(format!(
            "window {id} no longer exists and {requested_app} has multiple current windows; call list_windows and choose one"
        ));
    }
    Ok(window)
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
    let foreground = unsafe { GetForegroundWindow() };
    // Re-activating an already-foreground window can collapse a selection or move
    // focus between two related input calls (for example Ctrl+A, then type).
    if foreground == hwnd {
        return Ok(());
    }
    if unsafe { IsHungAppWindow(hwnd) } != 0 {
        return Err(format!("window {id} is not responding"));
    }
    // ShowWindow/SetForegroundWindow send synchronous messages to the target
    // thread. A wedged app would park this synchronous host inside win32k, so
    // the activation attempt runs on a bounded worker.
    let hwnd_value = hwnd as usize;
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("cua-activate".into())
        .spawn(move || {
            let result = unsafe { activate_window_inner(hwnd_value as HWND) };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("spawn activation worker: {error}"))?;
    receiver
        .recv_timeout(Duration::from_millis(ACTIVATE_TIMEOUT_MS))
        .map_err(|_| format!("window {id} activation timed out (app not responding)"))?
}

/// One activation attempt must stay well under the daemon's per-request budget.
const ACTIVATE_TIMEOUT_MS: u64 = 1_500;

unsafe fn activate_window_inner(hwnd: HWND) -> Result<(), String> {
    let foreground = unsafe { GetForegroundWindow() };
    unsafe {
        ShowWindow(hwnd, SW_RESTORE);
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
    // Foreground changes are asynchronous. Do not inject into whichever app
    // happened to remain foreground when activation was requested.
    for _ in 0..10 {
        unsafe { Sleep(10) };
        let foreground = unsafe { GetForegroundWindow() };
        if foreground == hwnd {
            return Ok(());
        }
        unsafe {
            BringWindowToTop(hwnd);
            SetForegroundWindow(hwnd);
        }
    }
    Err(format!("could not activate window {}", hwnd as usize))
}

fn ensure_foreground_window(id: u64) -> Result<(), String> {
    if unsafe { GetForegroundWindow() } == id as usize as HWND {
        Ok(())
    } else {
        Err(format!("window {id} lost foreground; action cancelled"))
    }
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

fn accessibility_tree(window: &WindowRef, pump_free: bool) -> (String, String, Vec<HWND>) {
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
        // pump_free: the owning thread is known-wedged (UIA timed out), so read
        // stored text instead of sending messages that would each burn the
        // WINDOW_TEXT_TIMEOUT_MS budget.
        let name = if pump_free {
            internal_window_text(*hwnd)
        } else {
            window_text(*hwnd)
        };
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

/// Classify UIA usefulness so agents switch to grid_view immediately when the tree is unusable.
fn assess_uia_quality(
    elements: &[(u64, String, String, bool)],
    provider_error: Option<&str>,
) -> Value {
    let total = elements.len();
    let no_hit = elements
        .iter()
        .filter(|(_, _, _, has_bounds)| !has_bounds)
        .count();
    let shell_roles = [
        "Window", "Pane", "TitleBar", "Group", "Custom", "Image", "Thumb",
    ];
    let actionable = elements
        .iter()
        .filter(|(_, role, _, has_bounds)| {
            *has_bounds
                && matches!(
                    role.as_str(),
                    "Button"
                        | "Edit"
                        | "MenuItem"
                        | "CheckBox"
                        | "RadioButton"
                        | "ComboBox"
                        | "ListItem"
                        | "TreeItem"
                        | "TabItem"
                        | "Hyperlink"
                        | "Document"
                        | "SplitButton"
                )
        })
        .count();
    let only_shell = total > 0
        && elements
            .iter()
            .all(|(_, role, _, _)| shell_roles.iter().any(|s| *s == role.as_str()));

    let (quality, prefer_vision, reason) = if let Some(err) = provider_error {
        if err.contains("timed out") || err.contains("disabled") {
            ("broken", true, "timeout_or_provider_disabled")
        } else if total == 0 {
            ("broken", true, "empty_tree")
        } else {
            ("weak", true, "provider_error_fallback")
        }
    } else if total == 0 {
        ("broken", true, "empty_tree")
    } else if only_shell || actionable < 3 {
        ("broken", true, "only_shell")
    } else if total > 0 && (no_hit as f64 / total as f64) >= 0.5 {
        ("weak", true, "high_no_hit")
    } else if actionable < 5 {
        ("weak", true, "few_actionable")
    } else {
        ("good", false, "ok")
    };

    json!({
        "quality": quality,
        "prefer_vision": prefer_vision,
        "reason": reason,
        "actionable_count": actionable,
        "no_hit_count": no_hit,
        "element_count": total,
        "howto": if prefer_vision {
            "UIA tree unusable: call sky.grid_view({window}) immediately. Do not click element_index."
        } else {
            "UIA usable: prefer element_index; refresh tree after layout changes."
        }
    })
}

/// Passive capture paths (get_window_state, grid_view) tolerate activation
/// failure against a wedged window: BitBlt screenshots and HWND trees still
/// work. Input paths keep the hard error.
fn activation_failure_tolerable(hwnd: HWND, error: &str) -> bool {
    let hung = unsafe { IsHungAppWindow(hwnd) } != 0;
    hung || error.contains("activation timed out") || error.contains("not responding")
}

pub fn get_window_state(
    window: WindowRef,
    include_screenshot: bool,
    include_text: bool,
) -> Result<Value, String> {
    let timing = env::var_os("FASTCUA_HOST_TIMING").is_some();
    let stage = |name: &str, start: std::time::Instant| {
        if timing {
            eprintln!("[timing] {name}: {}ms", start.elapsed().as_millis());
        }
    };
    let t = std::time::Instant::now();
    if let Err(error) = activate_window(window.id) {
        if !activation_failure_tolerable(window.id as usize as HWND, &error) {
            return Err(error);
        }
    }
    stage("activate", t);
    let t = std::time::Instant::now();
    let (accessibility, uia_meta) = if include_text {
        let mut provider_err: Option<String> = None;
        // Set when the app's UIA provider is unresponsive (timed out or already
        // disabled). The rest of this request must then stay pump-free.
        let mut provider_unresponsive = false;
        let (tree, focused_element, document_text, quality_elems) = match uia_snapshot(&window) {
            Ok(snapshot) => {
                cache_uia_elements(&window, &snapshot)?;
                let elems: Vec<(u64, String, String, bool)> = snapshot
                    .elements
                    .iter()
                    .map(|e| (e.index, e.role.clone(), e.name.clone(), e.bounds.is_some()))
                    .collect();
                (
                    snapshot.tree,
                    snapshot.focused_element,
                    snapshot.document_text,
                    elems,
                )
            }
            Err(err) => {
                provider_unresponsive =
                    err.contains("timed out") || err.contains("disabled after provider timeout");
                provider_err = Some(err);
                let (tree, document_text, elements) =
                    accessibility_tree(&window, provider_unresponsive);
                cache_hwnd_elements(&window, &elements)?;
                let elems: Vec<(u64, String, String, bool)> = elements
                    .iter()
                    .enumerate()
                    .map(|(i, hwnd)| {
                        let mut bounds = RECT::default();
                        let has = unsafe { IsWindow(*hwnd) } != 0
                            && unsafe { GetWindowRect(*hwnd, &mut bounds) } != 0
                            && bounds.right > bounds.left
                            && bounds.bottom > bounds.top;
                        (
                            i as u64,
                            role_for_class(&class_name(*hwnd)).to_string(),
                            if i == 0 {
                                window.title.clone()
                            } else if provider_unresponsive {
                                internal_window_text(*hwnd)
                            } else {
                                window_text(*hwnd)
                            },
                            has,
                        )
                    })
                    .collect();
                (tree, String::new(), document_text, elems)
            }
        };
        // A wedged provider cannot answer the focused-value worker either; skip
        // it instead of burning its 800ms timeout on every request.
        let focused_value = if provider_unresponsive {
            None
        } else {
            uia::focused_value(window.id as usize as HWND)
        };
        let uia = assess_uia_quality(&quality_elems, provider_err.as_deref());
        (
            json!({
                "tree": tree,
                "focused_element": focused_element,
                "focused_value": focused_value,
                "selected_text": "",
                "document_text": document_text,
            }),
            uia,
        )
    } else {
        (
            json!({}),
            json!({
                "quality": "unknown",
                "prefer_vision": false,
                "reason": "include_text_false",
                "howto": "Call get_window_state with include_text:true to assess UIA, or use grid_view for targeting."
            }),
        )
    };
    stage("text", t);
    let t = std::time::Instant::now();
    let bounds = window_bounds(window.id)?;
    let screenshots = if include_screenshot {
        vec![capture_window(window.id)?]
    } else {
        Vec::new()
    };
    stage("capture", t);
    // Prefer screenshot pixel size as the coordinate space (matches capture bitmap).
    let (coord_w, coord_h) = if let Some(shot) = screenshots.first() {
        (
            shot.get("width")
                .and_then(Value::as_i64)
                .unwrap_or(bounds.width as i64) as i32,
            shot.get("height")
                .and_then(Value::as_i64)
                .unwrap_or(bounds.height as i64) as i32,
        )
    } else {
        (bounds.width, bounds.height)
    };
    let prefer_vision = uia_meta
        .get("prefer_vision")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(json!({
        "window": window,
        "accessibility": accessibility,
        "uia": uia_meta,
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
            "grid_hint": if prefer_vision {
                "UIA prefer_vision=true: call sky.grid_view({window}) NOW. Do not use element_index."
            } else {
                "When UIA is unusable: sky.grid_view packs SQUARE number cells. SELECT then refine then click_cell."
            }
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

/// Some when this app's UIA provider already timed out once this session.
/// UIA queries against it are disabled so requests fail fast instead of
/// blocking the (synchronous) host on a hung provider again.
fn uia_disabled_reason(window: &WindowRef) -> Option<String> {
    let timed_out = UIA_TIMEOUT_APPS.get_or_init(|| Mutex::new(HashSet::new()));
    let disabled = timed_out.lock().ok()?.contains(&window.app);
    disabled.then(|| "UI Automation disabled after provider timeout".to_string())
}

fn uia_snapshot(window: &WindowRef) -> Result<uia::Snapshot, String> {
    if env::var_os("FASTCUA_TEST_FORCE_UIA_FALLBACK").is_some() {
        return Err("UI Automation fallback forced for regression testing".into());
    }
    if let Some(reason) = uia_disabled_reason(window) {
        return Err(reason);
    }
    let timed_out = UIA_TIMEOUT_APPS.get_or_init(|| Mutex::new(HashSet::new()));
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

/// Bound for one screenshot capture. PrintWindow sends WM_PRINT and can park on
/// a wedged app; the capture must fail fast instead of blocking the synchronous
/// host. On timeout the worker is detached (it only touches its own GDI objects).
const CAPTURE_TIMEOUT_MS: u64 = 3_000;

fn capture_window_rgb(id: u64) -> Result<CapturedRgb, String> {
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("cua-capture".into())
        .spawn(move || {
            let result = capture_window_rgb_inner(id);
            let _ = sender.send(result);
        })
        .map_err(|error| format!("spawn capture worker: {error}"))?;
    receiver
        .recv_timeout(Duration::from_millis(CAPTURE_TIMEOUT_MS))
        .map_err(|_| "screenshot capture timed out (target window not responding)".to_string())?
}

fn capture_window_rgb_inner(id: u64) -> Result<CapturedRgb, String> {
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
    // PrintWindow sends WM_PRINT to the target — a wedged app cannot answer it.
    // Skip straight to BitBlt (reads the window's current surface) when hung.
    let hung = unsafe { IsHungAppWindow(hwnd) } != 0;
    if hung || unsafe { PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT) } == 0 {
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
fn pack_square_cells(
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    refine: bool,
) -> (i32, i32, i32, Vec<GridCell>) {
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

fn draw_hline(
    rgb: &mut [u8],
    w: i32,
    h: i32,
    y: i32,
    x0: i32,
    x1: i32,
    thick: i32,
    r: u8,
    g: u8,
    b: u8,
    a: f32,
) {
    let half = thick / 2;
    for dy in -half..=(thick - 1 - half) {
        for x in x0..=x1 {
            blend_px(rgb, w, h, x, y + dy, r, g, b, a);
        }
    }
}

fn draw_vline(
    rgb: &mut [u8],
    w: i32,
    h: i32,
    x: i32,
    y0: i32,
    y1: i32,
    thick: i32,
    r: u8,
    g: u8,
    b: u8,
    a: f32,
) {
    let half = thick / 2;
    for dx in -half..=(thick - 1 - half) {
        for y in y0..=y1 {
            blend_px(rgb, w, h, x + dx, y, r, g, b, a);
        }
    }
}

// 5×7 bitmap digits 0-9 (row-major, bit 0 = left).
const DIGIT_FONT: [[u8; 7]; 10] = [
    [
        0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
    ], // 0
    [
        0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
    ], // 1
    [
        0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
    ], // 2
    [
        0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110,
    ], // 3
    [
        0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
    ], // 4
    [
        0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
    ], // 5
    [
        0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
    ], // 6
    [
        0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
    ], // 7
    [
        0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
    ], // 8
    [
        0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
    ], // 9
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
        draw_hline(
            rgb, w, h, cell.top, cell.left, cell.right, thick, lr, lg, lb, la,
        );
        draw_hline(
            rgb,
            w,
            h,
            cell.bottom - 1,
            cell.left,
            cell.right,
            thick,
            lr,
            lg,
            lb,
            la,
        );
        draw_vline(
            rgb,
            w,
            h,
            cell.left,
            cell.top,
            cell.bottom,
            thick,
            lr,
            lg,
            lb,
            la,
        );
        draw_vline(
            rgb,
            w,
            h,
            cell.right - 1,
            cell.top,
            cell.bottom,
            thick,
            lr,
            lg,
            lb,
            la,
        );
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
    if let Err(error) = activate_window(window.id) {
        if !activation_failure_tolerable(window.id as usize as HWND, &error) {
            return Err(error);
        }
    }
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
        &cap.rgb, cap.width, cap.height, region_l, region_t, region_r, region_b,
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
    move_and_settle(window.id, x, y)?;
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
        ensure_foreground_window(window.id)?;
        dispatch_click(x, y, &button)?;
        unsafe { Sleep(35) };
    }
    Ok(())
}

fn set_cursor_position(x: i32, y: i32) -> Result<(), String> {
    if unsafe { SetCursorPos(x, y) } == 0 {
        return Err(format!("SetCursorPos failed (GetLastError={})", unsafe {
            GetLastError()
        }));
    }
    Ok(())
}

fn move_and_settle(window_id: u64, x: i32, y: i32) -> Result<(), String> {
    set_cursor_position(x, y)?;
    unsafe { Sleep(MOVE_SETTLE_MS) };
    ensure_cursor_position(x, y)?;
    ensure_foreground_window(window_id)
}

fn ensure_cursor_position(x: i32, y: i32) -> Result<(), String> {
    let mut actual = POINT::default();
    if unsafe { GetCursorPos(&mut actual) } == 0 {
        return Err(format!("GetCursorPos failed (GetLastError={})", unsafe {
            GetLastError()
        }));
    }
    if actual.x != x || actual.y != y {
        return Err("cursor moved; action cancelled".into());
    }
    Ok(())
}

fn dispatch_click(screen_x: i32, screen_y: i32, button: &str) -> Result<(), String> {
    // Prefer real injected input. Common item dialogs / DirectUI often ignore
    // SendMessage(BM_CLICK) / synthetic WM_LBUTTON* while still accepting SendInput.
    ensure_cursor_position(screen_x, screen_y)?;
    dispatch_input_click(button)?;
    ensure_cursor_position(screen_x, screen_y)
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
    send_mouse_release(up)
}

pub fn type_text(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing field `text`".to_string())?;
    // Append is the safe default. Replacement is allowed only when UIA exposes
    // a writable, scoped ValuePattern for the focused control. This prevents a
    // blind Ctrl+A from selecting an entire document, grid, or application.
    let replace = params
        .get("replace")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ensure_foreground_window(window.id)?;
    if replace {
        // set_focused_value is synchronous by design (a destructive write must
        // not linger on a detached timeout worker). When this app's provider is
        // already known-hung, fail fast here instead of blocking the host.
        if let Some(reason) = uia_disabled_reason(&window) {
            return Err(format!(
                "replace:true unavailable: {reason}. Use replace:false to type at the caret, or use sky.grid_view for vision targeting."
            ));
        }
        if !uia::set_focused_value(window.id as usize as HWND, text)? {
            return Err(
                "replace:true requires a focused writable text value. Refocus a text field, use replace:false to type at the caret, or explicitly select a broader document region with press_key first."
                    .into(),
            );
        }
        return Ok(());
    }
    send_text(window.id, text)
}

fn keyboard_input(key: WORD, scan: WORD, flags: DWORD) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_inputs(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            inputs.len() as UINT,
            inputs.as_ptr(),
            mem::size_of::<INPUT>() as i32,
        )
    };
    if sent != inputs.len() as UINT {
        Err(format!(
            "SendInput inserted {sent}/{} events (GetLastError={})",
            inputs.len(),
            unsafe { GetLastError() }
        ))
    } else {
        Ok(())
    }
}

fn send_text(window_id: u64, text: &str) -> Result<(), String> {
    // Chunk input so very large strings do not require one unbounded allocation.
    let mut inputs = Vec::with_capacity(256);
    for unit in text.encode_utf16() {
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE));
        inputs.push(keyboard_input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        if inputs.len() >= 256 {
            ensure_foreground_window(window_id)?;
            send_text_inputs(&inputs)?;
            inputs.clear();
        }
    }
    ensure_foreground_window(window_id)?;
    send_text_inputs(&inputs)
}

fn send_text_inputs(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            inputs.len() as UINT,
            inputs.as_ptr(),
            mem::size_of::<INPUT>() as i32,
        )
    };
    if sent == inputs.len() as UINT {
        return Ok(());
    }
    let error = unsafe { GetLastError() };
    let mut cleanup_error = None;
    if sent % 2 == 1 {
        let scan = unsafe { inputs[sent as usize - 1].Anonymous.ki.wScan };
        let release = keyboard_input(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        let mut released = false;
        for _ in 0..3 {
            if unsafe { SendInput(1, &release, mem::size_of::<INPUT>() as i32) } == 1 {
                released = true;
                break;
            }
            unsafe { Sleep(5) };
        }
        if !released {
            cleanup_error = Some(unsafe { GetLastError() });
        }
    }
    Err(format!(
        "SendInput inserted {sent}/{} text events (GetLastError={error}){}",
        inputs.len(),
        cleanup_error
            .map(|code| format!("; key release cleanup failed (GetLastError={code})"))
            .unwrap_or_default()
    ))
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
    ensure_foreground_window(window.id)?;
    for key in &keys {
        let scan = unsafe { MapVirtualKeyW(*key as UINT, MAPVK_VK_TO_VSC) } as u8;
        unsafe { keybd_event(*key as u8, scan, 0, 0) };
        unsafe { Sleep(8) };
    }
    for key in keys.iter().rev() {
        let scan = unsafe { MapVirtualKeyW(*key as UINT, MAPVK_VK_TO_VSC) } as u8;
        unsafe { keybd_event(*key as u8, scan, KEYEVENTF_KEYUP, 0) };
        unsafe { Sleep(4) };
    }
    Ok(())
}

pub fn scroll(params: &Value) -> Result<(), String> {
    let window = params_window(params)?;
    activate_window(window.id)?;
    let (x, y) = screen_point_from_params(&window, params)?;
    move_and_settle(window.id, x, y)?;
    let vertical = params.get("scrollY").and_then(Value::as_i64).unwrap_or(0) as i32;
    let horizontal = params.get("scrollX").and_then(Value::as_i64).unwrap_or(0) as i32;
    if vertical != 0 {
        ensure_cursor_position(x, y)?;
        send_mouse(MOUSEEVENTF_WHEEL, (-vertical) as u32)?;
    }
    if horizontal != 0 {
        ensure_cursor_position(x, y)?;
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
    move_and_settle(window.id, from_x, from_y)?;
    send_mouse(MOUSEEVENTF_LEFTDOWN, 0)?;
    let drag_result = (|| {
        let mut previous_x = from_x;
        let mut previous_y = from_y;
        for step in 1..=20 {
            ensure_foreground_window(window.id)?;
            ensure_cursor_position(previous_x, previous_y)?;
            let x = from_x + (to_x - from_x) * step / 20;
            let y = from_y + (to_y - from_y) * step / 20;
            set_cursor_position(x, y)?;
            previous_x = x;
            previous_y = y;
            unsafe { Sleep(8) };
        }
        ensure_foreground_window(window.id)?;
        ensure_cursor_position(to_x, to_y)?;
        Ok(())
    })();
    let release_result = send_mouse_release(MOUSEEVENTF_LEFTUP);
    if let Err(error) = drag_result {
        return match release_result {
            Ok(()) => Err(error),
            Err(release_error) => Err(format!(
                "{error}; mouse release also failed: {release_error}"
            )),
        };
    }
    release_result
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
    // Bound the cross-process write: a wedged target must fail fast, not park
    // the synchronous host on its message pump.
    let mut result: usize = 0;
    let sent = unsafe {
        SendMessageTimeoutW(
            target,
            WM_SETTEXT,
            0,
            value.as_ptr() as LPARAM,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            1_000,
            &mut result,
        )
    };
    if sent == 0 || result == 0 {
        return Err(format!("set value failed for element {index}"));
    }
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
    get_window_exact(id, app)
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
        (
            map_axis(params, "x", bounds.width)?,
            map_axis(params, "y", bounds.height)?,
        )
    };
    screen_point(window, x, y)
}

fn send_mouse(flags: DWORD, data: DWORD) -> Result<(), String> {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    send_inputs(&[input])
}

fn send_mouse_release(flags: DWORD) -> Result<(), String> {
    let mut first_error = None;
    for _ in 0..3 {
        match send_mouse(flags, 0) {
            Ok(()) => return Ok(()),
            Err(error) if first_error.is_none() => first_error = Some(error),
            Err(_) => {}
        }
        unsafe { Sleep(5) };
    }
    Err(format!(
        "{}; mouse release cleanup failed after 3 attempts",
        first_error.unwrap_or_else(|| "mouse release failed".into())
    ))
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
        // Single characters must win over the F-key prefix: bare "F"/"f" is the
        // letter, while "F1".."F20" are function keys.
        _ if normalized.len() == 1 => {
            let character = normalized.encode_utf16().next()?;
            let scanned = unsafe { VkKeyScanW(character) };
            if scanned == -1 {
                return None;
            }
            scanned as WORD & 0xff
        }
        _ if normalized.starts_with('F') => {
            let number = normalized[1..].parse::<u16>().ok()?;
            if (1..=20).contains(&number) {
                VK_F1 + number - 1
            } else {
                return None;
            }
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

/// Per-call bound for cross-process window text messages. A wedged app cannot
/// answer WM_GETTEXT; the synchronous host must never park on its message pump.
const WINDOW_TEXT_TIMEOUT_MS: UINT = 300;

fn window_text(hwnd: HWND) -> String {
    if unsafe { IsHungAppWindow(hwnd) } != 0 {
        return internal_window_text(hwnd);
    }
    let mut length: usize = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXTLENGTH,
            0,
            0,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            WINDOW_TEXT_TIMEOUT_MS,
            &mut length,
        )
    } == 0
    {
        return internal_window_text(hwnd);
    }
    let mut buffer = vec![0u16; length + 1];
    let mut copied: usize = 0;
    if unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            buffer.len() as WPARAM,
            buffer.as_mut_ptr() as LPARAM,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            WINDOW_TEXT_TIMEOUT_MS,
            &mut copied,
        )
    } == 0
    {
        return internal_window_text(hwnd);
    }
    String::from_utf16_lossy(&buffer[..copied.min(length)])
}

/// Read the title stored in the window structure without sending a message.
/// Safe against wedged apps; used only as the bounded fallback for window_text.
fn internal_window_text(hwnd: HWND) -> String {
    let mut buffer = vec![0u16; 512];
    let copied = unsafe { InternalGetWindowText(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
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
