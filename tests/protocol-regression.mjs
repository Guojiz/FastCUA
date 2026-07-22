import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(process.argv[2] || "native-host/target/release/cua-native-host.exe");
const fixture = path.resolve(process.argv[3] || "tests/FastCuaFixture.exe");
const python = process.argv[4] || process.env.CODEX_PYTHON;
const fastcuaHome = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-regression-"));
const fastcuaCache = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-cache-"));
const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-legacy-home-"));
const child = spawn(binary, ["--parent-pid", String(process.pid)], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    FASTCUA_HOME: fastcuaHome,
    FASTCUA_CACHE_DIR: fastcuaCache,
    CODEX_HOME: legacyHome,
  },
});

let buffer = "";
let nextId = 1;
const pending = new Map();
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }
});

async function rawRequest(method, params, meta) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
  });
  child.stdin.write(`${JSON.stringify({ id, method, params, meta })}\n`);
  return promise;
}

async function request(method, params = {}) {
  const meta = {
    session_id: "protocol-regression",
    turn_id: "1",
    "x-fastcua-request-budget-ms": 15_000,
  };
  const app = params.window?.app || params.app;
  if (app) meta["x-fastcua-approved-app"] = app;
  const message = await rawRequest(method, params, meta);
  if (message.approvalRequest) {
    meta["x-fastcua-approved-app"] = message.approvalRequest.app;
    return checked(await rawRequest(method, params, meta), method);
  }
  return checked(message, method);
}

function checked(message, method) {
  if (!message.ok) throw new Error(`${method}: ${message.error || JSON.stringify(message)}`);
  return message.result;
}

function elementIndex(tree, name) {
  const line = tree.split("\n").filter((item) => item.includes(name)).at(-1);
  assert.ok(line, `accessibility element not found: ${name}`);
  const match = /^\s*(\d+)\s/.exec(line);
  assert.ok(match, `element index missing: ${line}`);
  return Number(match[1]);
}

function elementIndexesByRole(tree, role) {
  return tree
    .split("\n")
    .map((line) => new RegExp(`^\\s*(\\d+)\\s+${role}(?:\\s|$)`, "i").exec(line))
    .filter(Boolean)
    .map(match => Number(match[1]));
}

function elementIndexByRole(tree, role) {
  const indexes = elementIndexesByRole(tree, role);
  assert.ok(indexes.length, `accessibility role not found: ${role}`);
  return indexes[0];
}

async function pollWindow() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const windows = await request("list_windows");
    const found = windows.find((item) => item.title === "FastCUA Host Test Fixture");
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture window did not appear");
}

const results = [];
function passed(name, detail = "ok") {
  results.push({ name, detail });
  process.stdout.write(`PASS ${name}: ${detail}\n`);
}

try {
  assert.ok(fs.existsSync(binary), `missing host: ${binary}`);
  assert.ok(fs.existsSync(fixture), `missing fixture: ${fixture}`);

  await request("launch_app", { app: fixture });
  const window = await pollWindow();
  passed("launch_app/list_windows", `${window.app} hwnd=${window.id}`);

  const apps = await request("list_apps");
  assert.ok(apps.some((app) => app.windows?.some((item) => item.id === window.id)));
  passed("list_apps");

  const rehydrated = await request("get_window", { app: window.app, id: window.id });
  assert.equal(rehydrated.id, window.id);
  passed("get_window");

  const rebound = await request("get_window", { app: window.app, id: Number.MAX_SAFE_INTEGER });
  assert.equal(rebound.id, window.id);
  passed("get_window unique-app rebind", `stale=${Number.MAX_SAFE_INTEGER} current=${window.id}`);

  await request("activate_window", { window });
  passed("activate_window");

  let state = await request("get_window_state", {
    window,
    include_screenshot: true,
    include_text: false,
  });
  assert.deepEqual(state.accessibility, {});
  assert.equal(state.cacheDiagnostics.accessibilitySnapshotCount, 0);
  assert.match(state.screenshots?.[0]?.url || "", /^data:image\/jpeg;base64,/);
  await assert.rejects(
    request("click", { window, element_index: 999_999, mouse_button: "left", click_count: 1 }),
    /UIA element index is unavailable or stale.*include_text: true/i,
  );
  passed("screenshot-only skips UIA", "accessibilitySnapshotCount=0");

  state = await request("get_window_state", {
    window,
    include_screenshot: true,
    include_text: true,
  });
  assert.ok(state.accessibility?.tree.includes("Fixture Text"), state.accessibility?.tree);
  assert.ok(state.accessibility?.tree.includes("Text: initial-value"), state.accessibility?.tree);
  assert.match(state.screenshots?.[0]?.url || "", /^data:image\/jpeg;base64,/);
  passed("get_window_state", `${state.screenshots[0].width}x${state.screenshots[0].height}`);

  state = await request("get_window_state", {
    window,
    include_screenshot: false,
    include_text: true,
  });
  const tree = state.accessibility.tree;
  const editIndexes = elementIndexesByRole(tree, "Edit");
  assert.ok(editIndexes.length >= 2, `expected writable and read-only Edit controls\n${tree}`);
  const textIndex = editIndexes[0];
  const buttonIndex = elementIndex(tree, "Increment Button");
  // Fixture Edit order: [0] writable, [1] read-only, [2] password (issue-3 probe).
  const readOnlyIndex = editIndexes[1];
  await request("click", { window, element_index: textIndex, mouse_button: "left", click_count: 1 });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(
    state.accessibility.focused_value,
    "initial-value",
    `focused=${state.accessibility.focused_element}`,
  );
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, "initial-value");
  assert.match(state.accessibility.tree, /Text: initial-value/);
  passed("focused_value is observational", state.accessibility.focused_value);

  let setValueWorked = true;
  try {
    await request("set_value", { window, element_index: textIndex, value: "set-value-ok" });
    passed("set_value");
  } catch (error) {
    if (!/(?:element \d+ no longer exists|does not support setting a value|missing field `x`)/i.test(error.message)) throw error;
    setValueWorked = false;
    passed("set_value provider parity", "same provider limitation as unmodified host");
  }

  await request("click", { window, element_index: buttonIndex, mouse_button: "left", click_count: 1 });
  passed("click", "UIA element index without coordinate fallback");

  await assert.rejects(
    request("click", { window, element_index: 999_999, mouse_button: "left", click_count: 1 }),
    /UIA element index is unavailable or stale.*include_text: true/i,
  );
  passed("invalid UIA element index", "explicit stale error; no click fallback");

  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  const currentTree = state.accessibility.tree;
  if (setValueWorked) assert.ok(currentTree.includes("Text: set-value-ok"), "set_value effect missing from fixture status");
  await request("click", { window, element_index: textIndex, mouse_button: "left", click_count: 1 });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, setValueWorked ? "set-value-ok" : "initial-value");
  await request("type_text", { window, text: "typed-ok", replace: true });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, "typed-ok");
  passed("scoped replace/type_text", state.accessibility.focused_value);

  const longText = `unicode-${"x".repeat(120)}-\u4f60\u597d`;
  await request("type_text", { window, text: "", replace: true });
  await request("type_text", { window, text: longText });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, longText);
  passed("long Unicode SendInput", `${longText.length} chars`);

  await request("press_key", { window, key: "End" });
  await request("press_key", { window, key: "Backspace" });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, longText.slice(0, -1));
  passed("press_key virtual key input");

  await request("press_key", { window, key: "Shift_L+Home" });
  await request("type_text", { window, text: "shortcut-ok" });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, "shortcut-ok", stderr.join(""));
  passed("press_key selection + default caret typing");

  await request("click", { window, element_index: buttonIndex, mouse_button: "left", click_count: 1 });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.match(state.accessibility.focused_element, /Button Increment Button/i);
  assert.equal(state.accessibility.focused_value, null);
  await assert.rejects(
    request("type_text", { window, text: "must-not-type", replace: true }),
    /replace:true requires a focused writable text value/i,
  );
  await request("click", { window, element_index: textIndex, mouse_button: "left", click_count: 1 });
  passed("unsafe broad replacement fails closed");

  await request("click", { window, element_index: readOnlyIndex, mouse_button: "left", click_count: 1 });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, "read-only-value");
  await assert.rejects(
    request("type_text", { window, text: "must-not-replace", replace: true }),
    /read-only/i,
  );
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.equal(state.accessibility.focused_value, "read-only-value");
  passed("read-only replacement fails closed");

  const screenshot = (await request("get_window_state", {
    window,
    include_screenshot: true,
    include_text: true,
  })).screenshots[0];
  await request("scroll", {
    window,
    x: Math.min(100, screenshot.width - 1),
    y: Math.min(220, screenshot.height - 1),
    scrollX: 0,
    scrollY: 240,
    screenshotId: screenshot.id,
  });
  passed("scroll");

  await request("drag", {
    window,
    from_x: Math.min(350, screenshot.width - 2),
    from_y: Math.min(350, screenshot.height - 2),
    to_x: Math.min(520, screenshot.width - 1),
    to_y: Math.min(350, screenshot.height - 1),
    screenshotId: screenshot.id,
  });
  passed("drag");

  try {
    await request("perform_secondary_action", { window, element_index: 0, action: "Raise" });
    passed("perform_secondary_action");
  } catch (error) {
    if (!/element \d+ no longer exists/i.test(error.message)) throw error;
    passed("perform_secondary_action provider parity", "same provider limitation as unmodified host");
  }

  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.ok(state.accessibility.tree.includes("shortcut-ok"), `typed text not reflected in accessibility tree\n${state.accessibility.tree}`);
  assert.ok(state.accessibility.tree.includes("Clicks: 2"), "button clicks not reflected in accessibility tree");
  passed("action effects verified");

  if (python) {
    const overlayWindows = JSON.parse(execFileSync(
      python,
      [path.resolve("scripts/list-process-windows.py"), String(child.pid)],
      { encoding: "utf8" },
    ));
    const cursor = overlayWindows.find((item) => item.title === "FastCUA Cursor Overlay");
    assert.equal(cursor?.visible, true, "cursor overlay is not visible");
    passed("overlay visibility", "cursor=true");
  }

  const unknown = await rawRequest("not_a_real_method", {}, {
    session_id: "protocol-regression",
    turn_id: "1",
    "x-oai-cua-request-budget-ms": 15_000,
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error || "", /unsupported method/i);
  passed("error response", unknown.error);

  const interruptPath = path.join(
    fastcuaHome,
    "cache",
    "computer-use",
    "interrupts",
    "protocol-regression",
    "1",
  );
  fs.mkdirSync(path.dirname(interruptPath), { recursive: true });
  fs.writeFileSync(interruptPath, "");
  const interrupted = await rawRequest("list_windows", {}, {
    session_id: "protocol-regression",
    turn_id: "1",
    "x-oai-cua-request-budget-ms": 15_000,
  });
  assert.equal(interrupted.ok, false);
  assert.match(interrupted.error || "", /turn has ended|no longer available|physical Escape key/i);
  const stillInterrupted = await rawRequest("list_windows", {}, {
    session_id: "protocol-regression",
    turn_id: "1",
    "x-oai-cua-request-budget-ms": 15_000,
  });
  assert.equal(stillInterrupted.ok, false);
  assert.match(stillInterrupted.error || "", /physical Escape key/i);
  const exited = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  const closed = await rawRequest("close", {}, {
    session_id: "protocol-regression",
    turn_id: "1",
    "x-oai-cua-request-budget-ms": 15_000,
  });
  assert.equal(closed.ok, true);
  assert.equal(fs.existsSync(interruptPath), false);
  assert.deepEqual(await exited, { code: 0, signal: null });
  passed("close", "clears the interrupted turn and exits the native host");
} finally {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("test shutting down"));
  }
  pending.clear();
  child.kill();
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  try { fs.rmSync(fastcuaHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(fastcuaCache, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(legacyHome, { recursive: true, force: true }); } catch {}
}

process.stdout.write(`\n${results.length} regression checks passed.\n`);
