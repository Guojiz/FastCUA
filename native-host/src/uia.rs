// SPDX-License-Identifier: Apache-2.0

//! Minimal raw COM bindings for UIAutomationCore.
//!
//! Keeping this module independent from a generated bindings crate makes the
//! release self-contained on both MSVC and GNU Rust toolchains.

use crate::win32::{GetWindowRect, HWND, POINT, RECT};
use std::{ffi::c_void, mem, ptr, slice, sync::mpsc, thread, time::Duration};

type HRESULT = i32;
type ComPtr = *mut c_void;

const S_OK: HRESULT = 0;
const S_FALSE: HRESULT = 1;
const RPC_E_CHANGED_MODE: HRESULT = 0x80010106u32 as i32;
const CLSCTX_INPROC_SERVER: u32 = 1;
const COINIT_MULTITHREADED: u32 = 0;

const UIA_BUTTON: i32 = 50000;
const UIA_CALENDAR: i32 = 50001;
const UIA_CHECK_BOX: i32 = 50002;
const UIA_COMBO_BOX: i32 = 50003;
const UIA_EDIT: i32 = 50004;
const UIA_HYPERLINK: i32 = 50005;
const UIA_IMAGE: i32 = 50006;
const UIA_LIST_ITEM: i32 = 50007;
const UIA_LIST: i32 = 50008;
const UIA_MENU: i32 = 50009;
const UIA_MENU_BAR: i32 = 50010;
const UIA_MENU_ITEM: i32 = 50011;
const UIA_PROGRESS_BAR: i32 = 50012;
const UIA_RADIO_BUTTON: i32 = 50013;
const UIA_SCROLL_BAR: i32 = 50014;
const UIA_SLIDER: i32 = 50015;
const UIA_SPINNER: i32 = 50016;
const UIA_STATUS_BAR: i32 = 50017;
const UIA_TAB: i32 = 50018;
const UIA_TAB_ITEM: i32 = 50019;
const UIA_TEXT: i32 = 50020;
const UIA_TOOL_BAR: i32 = 50021;
const UIA_TOOL_TIP: i32 = 50022;
const UIA_TREE: i32 = 50023;
const UIA_TREE_ITEM: i32 = 50024;
const UIA_CUSTOM: i32 = 50025;
const UIA_GROUP: i32 = 50026;
const UIA_THUMB: i32 = 50027;
const UIA_DATA_GRID: i32 = 50028;
const UIA_DATA_ITEM: i32 = 50029;
const UIA_DOCUMENT: i32 = 50030;
const UIA_SPLIT_BUTTON: i32 = 50031;
const UIA_WINDOW: i32 = 50032;
const UIA_PANE: i32 = 50033;
const UIA_HEADER: i32 = 50034;
const UIA_HEADER_ITEM: i32 = 50035;
const UIA_TABLE: i32 = 50036;
const UIA_TITLE_BAR: i32 = 50037;
const UIA_SEPARATOR: i32 = 50038;

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

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, coinit: u32) -> HRESULT;
    fn CoUninitialize();
    fn CoCreateInstance(
        class: *const Guid,
        outer: ComPtr,
        context: u32,
        interface: *const Guid,
        object: *mut ComPtr,
    ) -> HRESULT;
}

#[link(name = "oleaut32")]
unsafe extern "system" {
    fn SysStringLen(value: *const u16) -> u32;
    fn SysFreeString(value: *mut u16);
}

pub struct Snapshot {
    pub tree: String,
    pub focused_element: String,
    pub document_text: String,
    pub elements: Vec<ElementSnapshot>,
}

#[derive(Clone)]
pub struct ElementSnapshot {
    pub index: u64,
    pub name: String,
    pub role: String,
    pub bounds: Option<RECT>,
}

pub fn snapshot(hwnd: HWND, title: &str, app_name: &str) -> Result<Snapshot, String> {
    let hwnd_value = hwnd as usize;
    let title = title.to_owned();
    let app_name = app_name.to_owned();
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("cua-uia-snapshot".into())
        .spawn(move || {
            let result = unsafe { snapshot_inner(hwnd_value as HWND, &title, &app_name) };
            let _ = sender.send(result);
        })
        .map_err(|error| format!("spawn UIA worker: {error}"))?;
    receiver
        .recv_timeout(Duration::from_millis(1_500))
        .map_err(|_| "UI Automation provider timed out".to_string())?
}

unsafe fn snapshot_inner(hwnd: HWND, title: &str, app_name: &str) -> Result<Snapshot, String> {
    let init = unsafe { CoInitializeEx(ptr::null_mut(), COINIT_MULTITHREADED) };
    if init < 0 && init != RPC_E_CHANGED_MODE {
        return Err(format!("CoInitializeEx failed: 0x{:08x}", init as u32));
    }
    let should_uninitialize = init == S_OK || init == S_FALSE;

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
        if should_uninitialize {
            unsafe { CoUninitialize() };
        }
        return Err(format!(
            "create UI Automation failed: 0x{:08x}",
            created as u32
        ));
    }
    let mut desktop_root = ptr::null_mut();
    let get_root: unsafe extern "system" fn(ComPtr, *mut ComPtr) -> HRESULT =
        unsafe { method(automation, 5) };
    let _desktop_root_result = unsafe { get_root(automation, &mut desktop_root) };
    if !desktop_root.is_null() {
        unsafe { release(desktop_root) };
    }

    let mut walker = ptr::null_mut();
    let control_view_walker: unsafe extern "system" fn(ComPtr, *mut ComPtr) -> HRESULT =
        unsafe { method(automation, 14) };
    let walker_result = unsafe { control_view_walker(automation, &mut walker) };

    let mut bounds = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut bounds) } == 0 {
        if !walker.is_null() {
            unsafe { release(walker) };
        }
        unsafe { release(automation) };
        if should_uninitialize {
            unsafe { CoUninitialize() };
        }
        return Err("GetWindowRect before UIA ElementFromPoint failed".into());
    }
    let point = POINT {
        x: bounds.left + (bounds.right - bounds.left) / 2,
        y: bounds.top + (bounds.bottom - bounds.top) / 2,
    };
    let mut root = ptr::null_mut();
    let element_from_point: unsafe extern "system" fn(ComPtr, POINT, *mut ComPtr) -> HRESULT =
        unsafe { method(automation, 7) };
    let root_result = unsafe { element_from_point(automation, point, &mut root) };
    if root_result < 0 || root.is_null() {
        if !walker.is_null() {
            unsafe { release(walker) };
        }
        unsafe { release(automation) };
        if should_uninitialize {
            unsafe { CoUninitialize() };
        }
        return Err(format!(
            "UIA ElementFromPoint failed: 0x{:08x}",
            root_result as u32
        ));
    }
    if walker_result >= 0 && !walker.is_null() {
        let get_parent: unsafe extern "system" fn(ComPtr, ComPtr, *mut ComPtr) -> HRESULT =
            unsafe { method(walker, 3) };
        for _ in 0..20 {
            if unsafe { element_hwnd(root) } == Some(hwnd) {
                break;
            }
            let mut parent = ptr::null_mut();
            if unsafe { get_parent(walker, root, &mut parent) } < 0 || parent.is_null() {
                break;
            }
            unsafe { release(root) };
            root = parent;
        }
    }

    let mut tree = format!("Window: \"{title}\", App: {app_name}.\n");
    let mut document_parts = Vec::new();
    let mut elements = Vec::new();
    let mut next_index = 0usize;
    let mut visited = 0usize;
    if walker_result >= 0 && !walker.is_null() {
        unsafe {
            walk_element(
                walker,
                root,
                0,
                &mut next_index,
                &mut visited,
                &mut tree,
                &mut document_parts,
                &mut elements,
            )
        };
    }

    let focused_element = unsafe { focused_description(automation) };
    if !walker.is_null() {
        unsafe { release(walker) };
    }
    unsafe {
        release(root);
        release(automation);
    }
    if should_uninitialize {
        unsafe { CoUninitialize() };
    }
    if tree.lines().count() <= 1 {
        return Err("UI Automation returned an empty tree".into());
    }
    Ok(Snapshot {
        tree,
        focused_element,
        document_text: document_parts.join("\n"),
        elements,
    })
}

unsafe fn walk_element(
    walker: ComPtr,
    element: ComPtr,
    depth: usize,
    next_index: &mut usize,
    visited: &mut usize,
    tree: &mut String,
    document_parts: &mut Vec<String>,
    elements: &mut Vec<ElementSnapshot>,
) {
    if element.is_null() || depth > 12 || *visited >= 300 {
        return;
    }
    *visited += 1;
    let index = *next_index;
    *next_index += 1;
    let name = unsafe { element_bstr(element, 23) }.unwrap_or_default();
    let control_type = unsafe { element_i32(element, 21) }.unwrap_or(UIA_CUSTOM);
    let role = role_name(control_type);
    elements.push(ElementSnapshot {
        index: index as u64,
        name: name.clone(),
        role: role.to_string(),
        bounds: unsafe { element_bounds(element) },
    });
    tree.push_str(&"\t".repeat(depth + 1));
    tree.push_str(&format!("{index} {role}"));
    if !name.is_empty() {
        tree.push(' ');
        tree.push_str(&name.replace(['\r', '\n'], " "));
        document_parts.push(name.clone());
    }
    if index == 0 {
        tree.push_str(" Secondary Actions: Raise");
    }
    tree.push('\n');

    if depth >= 12 {
        return;
    }
    let first_child: unsafe extern "system" fn(ComPtr, ComPtr, *mut ComPtr) -> HRESULT =
        unsafe { method(walker, 4) };
    let next_sibling: unsafe extern "system" fn(ComPtr, ComPtr, *mut ComPtr) -> HRESULT =
        unsafe { method(walker, 6) };
    let mut child = ptr::null_mut();
    if unsafe { first_child(walker, element, &mut child) } < 0 {
        return;
    }
    while !child.is_null() && *visited < 300 {
        unsafe {
            walk_element(
                walker,
                child,
                depth + 1,
                next_index,
                visited,
                tree,
                document_parts,
                elements,
            )
        };
        let mut next = ptr::null_mut();
        let _ = unsafe { next_sibling(walker, child, &mut next) };
        unsafe { release(child) };
        child = next;
    }
}

unsafe fn element_bounds(element: ComPtr) -> Option<RECT> {
    let getter: unsafe extern "system" fn(ComPtr, *mut RECT) -> HRESULT =
        unsafe { method(element, 43) };
    let mut value = RECT::default();
    if unsafe { getter(element, &mut value) } < 0
        || value.right <= value.left
        || value.bottom <= value.top
    {
        return None;
    }
    Some(value)
}

unsafe fn focused_description(automation: ComPtr) -> String {
    let get_focused: unsafe extern "system" fn(ComPtr, *mut ComPtr) -> HRESULT =
        unsafe { method(automation, 8) };
    let mut focused = ptr::null_mut();
    if unsafe { get_focused(automation, &mut focused) } < 0 || focused.is_null() {
        return String::new();
    }
    let name = unsafe { element_bstr(focused, 23) }.unwrap_or_default();
    let role = unsafe { element_i32(focused, 21) }
        .map(role_name)
        .unwrap_or("Element");
    unsafe { release(focused) };
    if name.is_empty() {
        role.to_string()
    } else {
        format!("{role} {name}")
    }
}

unsafe fn element_i32(element: ComPtr, index: usize) -> Option<i32> {
    let getter: unsafe extern "system" fn(ComPtr, *mut i32) -> HRESULT =
        unsafe { method(element, index) };
    let mut value = 0;
    if unsafe { getter(element, &mut value) } < 0 {
        None
    } else {
        Some(value)
    }
}

unsafe fn element_hwnd(element: ComPtr) -> Option<HWND> {
    let getter: unsafe extern "system" fn(ComPtr, *mut HWND) -> HRESULT =
        unsafe { method(element, 36) };
    let mut value = ptr::null_mut();
    if unsafe { getter(element, &mut value) } < 0 {
        None
    } else {
        Some(value)
    }
}

unsafe fn element_bstr(element: ComPtr, index: usize) -> Option<String> {
    let getter: unsafe extern "system" fn(ComPtr, *mut *mut u16) -> HRESULT =
        unsafe { method(element, index) };
    let mut value = ptr::null_mut();
    if unsafe { getter(element, &mut value) } < 0 || value.is_null() {
        return None;
    }
    let length = unsafe { SysStringLen(value) } as usize;
    let result = String::from_utf16_lossy(unsafe { slice::from_raw_parts(value, length) });
    unsafe { SysFreeString(value) };
    Some(result)
}

unsafe fn release(object: ComPtr) {
    if object.is_null() {
        return;
    }
    let release_fn: unsafe extern "system" fn(ComPtr) -> u32 = unsafe { method(object, 2) };
    unsafe { release_fn(object) };
}

unsafe fn method<T: Copy>(object: ComPtr, index: usize) -> T {
    let table = unsafe { *(object as *const *const *const c_void) };
    let address = unsafe { *table.add(index) };
    unsafe { mem::transmute_copy(&address) }
}

fn role_name(control_type: i32) -> &'static str {
    match control_type {
        UIA_BUTTON => "Button",
        UIA_CALENDAR => "Calendar",
        UIA_CHECK_BOX => "CheckBox",
        UIA_COMBO_BOX => "ComboBox",
        UIA_EDIT => "Edit",
        UIA_HYPERLINK => "Hyperlink",
        UIA_IMAGE => "Image",
        UIA_LIST_ITEM => "ListItem",
        UIA_LIST => "List",
        UIA_MENU => "Menu",
        UIA_MENU_BAR => "MenuBar",
        UIA_MENU_ITEM => "MenuItem",
        UIA_PROGRESS_BAR => "ProgressBar",
        UIA_RADIO_BUTTON => "RadioButton",
        UIA_SCROLL_BAR => "ScrollBar",
        UIA_SLIDER => "Slider",
        UIA_SPINNER => "Spinner",
        UIA_STATUS_BAR => "StatusBar",
        UIA_TAB => "Tab",
        UIA_TAB_ITEM => "TabItem",
        UIA_TEXT => "Text",
        UIA_TOOL_BAR => "ToolBar",
        UIA_TOOL_TIP => "ToolTip",
        UIA_TREE => "Tree",
        UIA_TREE_ITEM => "TreeItem",
        UIA_GROUP => "Group",
        UIA_THUMB => "Thumb",
        UIA_DATA_GRID => "DataGrid",
        UIA_DATA_ITEM => "DataItem",
        UIA_DOCUMENT => "Document",
        UIA_SPLIT_BUTTON => "SplitButton",
        UIA_WINDOW => "Window",
        UIA_PANE => "Pane",
        UIA_HEADER => "Header",
        UIA_HEADER_ITEM => "HeaderItem",
        UIA_TABLE => "Table",
        UIA_TITLE_BAR => "TitleBar",
        UIA_SEPARATOR => "Separator",
        _ => "Custom",
    }
}
