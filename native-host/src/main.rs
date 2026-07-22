// SPDX-License-Identifier: MIT

mod desktop;
mod overlay;
mod uia;
mod win32;

use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process, thread,
};

const INTERRUPT_MESSAGE: &str = "Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use.";

#[derive(Debug, Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    meta: Value,
}

fn main() {
    // Keep captured bitmap pixels and absolute input coordinates in the same
    // per-monitor coordinate space. Without this, Windows virtualizes
    // GetWindowRect at 125%/150% DPI while PrintWindow returns physical pixels.
    unsafe {
        win32::SetProcessDpiAwarenessContext((-4isize) as win32::HANDLE);
    }
    if let Some(parent_pid) = parent_pid_from_args() {
        monitor_parent(parent_pid);
    }
    overlay::start_cursor_overlay();

    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("read request: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("parse request: {error}");
                continue;
            }
        };

        let close_after = request.method == "close";
        let response = handle_request(&request);
        if serde_json::to_writer(&mut stdout, &response).is_err() {
            break;
        }
        if stdout.write_all(b"\n").is_err() || stdout.flush().is_err() {
            break;
        }
        if close_after {
            break;
        }
    }
}

fn handle_request(request: &Request) -> Value {
    if let Some(path) = interrupt_path(&request.meta) {
        if request.method == "close" {
            let _ = fs::remove_file(path);
        } else if path.exists() {
            return error_response(request, INTERRUPT_MESSAGE);
        }
    }

    let approval_app = match request_app(request) {
        Ok(app) => app,
        Err(error) => return error_response(request, &error),
    };
    if let Some(app) = approval_app.as_deref() {
        let approved = request
            .meta
            .get("x-fastcua-approved-app")
            .or_else(|| request.meta.get("x-oai-cua-approved-app"))
            .and_then(Value::as_str);
        if approved != Some(app) {
            return json!({
                "id": request.id,
                "ok": false,
                "approvalRequest": {
                    "app": app,
                    "displayName": display_name(app),
                    "riskLevel": "low"
                }
            });
        }
    }

    let result = dispatch(&request.method, &request.params);
    match result {
        Ok(result) => json!({"id": request.id, "ok": true, "result": result}),
        Err(error) => error_response(request, &error),
    }
}

fn dispatch(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "list_apps" => {
            serde_json::to_value(desktop::list_apps()).map_err(|error| error.to_string())
        }
        "list_windows" => {
            serde_json::to_value(desktop::list_windows()).map_err(|error| error.to_string())
        }
        "get_window" => {
            let id = params
                .get("id")
                .and_then(Value::as_u64)
                .ok_or_else(|| "missing field `id`".to_string())?;
            let app = params.get("app").and_then(Value::as_str);
            serde_json::to_value(desktop::get_window(id, app)?).map_err(|error| error.to_string())
        }
        "launch_app" => {
            let app = params
                .get("app")
                .and_then(Value::as_str)
                .ok_or_else(|| "missing field `app`".to_string())?;
            desktop::launch_app(app)?;
            Ok(json!({}))
        }
        "activate_window" => {
            let window = desktop::params_window(params)?;
            desktop::activate_window(window.id)?;
            Ok(json!({}))
        }
        "get_window_state" => {
            let window = desktop::params_window(params)?;
            let include_screenshot = params
                .get("include_screenshot")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let include_text = params
                .get("include_text")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            desktop::get_window_state(window, include_screenshot, include_text)
        }
        "grid_view" => desktop::grid_view(params),
        "click" | "click_element" => {
            desktop::click(params)?;
            Ok(json!({}))
        }
        "type_text" => {
            desktop::type_text(params)?;
            Ok(json!({}))
        }
        "press_key" => {
            desktop::press_key(params)?;
            Ok(json!({}))
        }
        "scroll" | "scroll_element" => {
            desktop::scroll(params)?;
            Ok(json!({}))
        }
        "drag" => {
            desktop::drag(params)?;
            Ok(json!({}))
        }
        "set_value" => {
            desktop::set_value(params)?;
            Ok(json!({}))
        }
        "perform_secondary_action" => {
            desktop::perform_secondary_action(params)?;
            Ok(json!({}))
        }
        "close" => Ok(json!({"ok": true})),
        _ => Err(format!("unsupported method: {method}")),
    }
}

fn error_response(request: &Request, message: &str) -> Value {
    json!({"id": request.id, "ok": false, "error": message})
}

fn request_app(request: &Request) -> Result<Option<String>, String> {
    if matches!(
        request.method.as_str(),
        "list_apps" | "list_windows" | "close"
    ) {
        return Ok(None);
    }
    if request.method == "launch_app" {
        let app = request
            .params
            .get("app")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing field `app`".to_string())?;
        return desktop::validate_launch_app(app).map(Some);
    }
    if request.params.get("window").is_some() {
        return desktop::params_window(&request.params).map(|window| Some(window.app));
    }
    Ok(None)
}

fn interrupt_path(meta: &Value) -> Option<PathBuf> {
    let session = meta.get("session_id")?.as_str()?;
    let turn = meta.get("turn_id")?.as_str()?;
    // Prefer FastCUA home; accept CODEX_HOME only as legacy compat for tests / old daemons.
    let home = env::var_os("FASTCUA_HOME")
        .or_else(|| env::var_os("FASTCUA_CACHE_DIR"))
        .or_else(|| env::var_os("CODEX_HOME"))?;
    Some(
        PathBuf::from(home)
            .join("cache")
            .join("computer-use")
            .join("interrupts")
            .join(sanitize(session))
            .join(sanitize(turn)),
    )
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn display_name(app: &str) -> String {
    let raw = app.strip_prefix("process:").unwrap_or(app);
    Path::new(raw)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(raw)
        .to_string()
}

fn parent_pid_from_args() -> Option<u32> {
    let arguments: Vec<String> = env::args().collect();
    arguments
        .windows(2)
        .find(|pair| pair[0] == "--parent-pid")
        .and_then(|pair| pair[1].parse().ok())
}

fn monitor_parent(parent_pid: u32) {
    let handle = unsafe {
        win32::OpenProcess(
            win32::SYNCHRONIZE | win32::PROCESS_QUERY_LIMITED_INFORMATION,
            win32::FALSE,
            parent_pid,
        )
    };
    if handle.is_null() {
        return;
    }
    let handle_value = handle as usize;
    thread::spawn(move || unsafe {
        let handle = handle_value as win32::HANDLE;
        win32::WaitForSingleObject(handle, win32::INFINITE);
        win32::CloseHandle(handle);
        process::exit(0);
    });
}
