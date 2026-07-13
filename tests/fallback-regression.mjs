// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const binary = path.resolve(process.argv[2] || "native-host/target/release/cua-native-host.exe");
const fixture = path.resolve(process.argv[3] || "tests/FastCuaFixture.exe");
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-fallback-"));
const child = spawn(binary, ["--parent-pid", String(process.pid)], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, CODEX_HOME: codexHome, FASTCUA_TEST_FORCE_UIA_FALLBACK: "1" },
});

let buffer = "";
let nextId = 1;
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
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

async function raw(method, params = {}) {
  const id = nextId++;
  const meta = { session_id: "fallback-regression", turn_id: "1", "x-oai-cua-request-budget-ms": 15_000 };
  const app = params.window?.app || params.app;
  if (app) meta["x-oai-cua-approved-app"] = app;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15_000);
    pending.set(id, { resolve, reject, timer });
  });
  child.stdin.write(JSON.stringify({ id, method, params, meta }) + "\n");
  return promise;
}

async function request(method, params = {}) {
  let message = await raw(method, params);
  if (message.approvalRequest) {
    const id = nextId++;
    const meta = {
      session_id: "fallback-regression",
      turn_id: "1",
      "x-oai-cua-request-budget-ms": 15_000,
      "x-oai-cua-approved-app": message.approvalRequest.app,
    };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15_000);
      pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(JSON.stringify({ id, method, params, meta }) + "\n");
    message = await promise;
  }
  if (!message.ok) throw new Error(message.error || JSON.stringify(message));
  return message.result;
}

function indexFor(tree, name) {
  const line = tree.split("\n").find(item => item.includes(name));
  assert.ok(line, `fallback element not found: ${name}\n${tree}`);
  return Number(/^\s*(\d+)\s/.exec(line)?.[1]);
}

try {
  await request("launch_app", { app: fixture });
  let window;
  for (let attempt = 0; attempt < 40 && !window; attempt++) {
    window = (await request("list_windows")).find(item => item.title === "FastCUA Host Test Fixture");
    if (!window) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(window, "fixture window did not appear");

  let state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  const buttonIndex = indexFor(state.accessibility.tree, "Increment Button");
  await request("click", { window, element_index: buttonIndex, mouse_button: "left", click_count: 1 });
  state = await request("get_window_state", { window, include_screenshot: false, include_text: true });
  assert.match(state.accessibility.tree, /Clicks: 1/);
  await assert.rejects(
    request("click", { window, element_index: 999_999, mouse_button: "left", click_count: 1 }),
    /unavailable or stale/i,
  );
  console.log("PASS HWND fallback indexes are cached, clickable, and stale-safe");
} finally {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("test shutting down"));
  }
  pending.clear();
  child.kill();
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch {}
}
