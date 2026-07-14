// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const pipe = `\\\\.\\pipe\\fastcua-server-test-${process.pid}-${Date.now()}`;
const calls = [];
const daemon = net.createServer(socket => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      calls.push(request.method);
      const result = request.method === "list_windows" ? [] : { ok: true };
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
    }
  });
});
await new Promise((resolve, reject) => {
  daemon.once("error", reject);
  daemon.listen(pipe, resolve);
});

const child = spawn(process.execPath, [path.resolve("server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    FASTCUA_PIPE: pipe,
    FASTCUA_COSTART_MODE: "manual",
    FASTCUA_JS_TIMEOUT_MS: "100",
  },
});
child.stdout.setEncoding("utf8");
let stdout = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", chunk => {
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) break;
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message.result);
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5_000);
    pending.set(id, { resolve, reject, timer });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return promise;
}

function waitForChildExit() {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

try {
  const initialized = await rpc("initialize");
  assert.equal(initialized.serverInfo.name, "sky-computer-use");
  assert.equal(initialized.serverInfo.version, "0.2.0");

  const listed = await rpc("tools/list");
  const names = listed.tools.map(tool => tool.name);
  assert.ok(!names.includes("set_value"));
  assert.ok(!names.includes("end_turn"));
  assert.ok(names.includes("close"));
  const secondary = listed.tools.find(tool => tool.name === "perform_secondary_action");
  assert.deepEqual(secondary.inputSchema.properties.action.enum, ["Raise"]);
  assert.match(listed.tools.find(tool => tool.name === "list_apps").description, /running apps/i);
  console.log("PASS MCP contract matches v0.2.0 capabilities");

  const timedOut = await rpc("tools/call", {
    name: "js",
    arguments: { code: "await sleep(250); await sky.list_windows();" },
  });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /timed out/i);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(calls.filter(method => method === "list_windows").length, 0);
  console.log("PASS timed-out JS cells cannot issue later desktop calls");

  const windows = await rpc("tools/call", { name: "list_windows", arguments: {} });
  assert.equal(windows.isError, false);
  assert.equal(calls.filter(method => method === "list_windows").length, 1);

  const legacyEndTurn = await rpc("tools/call", {
    name: "js",
    arguments: { code: "await sky.end_turn();" },
  });
  assert.equal(legacyEndTurn.isError, true);
  assert.match(legacyEndTurn.content[0].text, /end_turn is not a function/i);
  console.log("PASS end_turn is unavailable through both MCP and sky");

  const exited = waitForChildExit();
  const closed = await rpc("tools/call", { name: "close", arguments: {} });
  assert.equal(closed.isError, false);
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(calls.filter(method => method === "close").length, 1);
  assert.equal(calls.filter(method => method === "list_windows").length, 1);
  console.log("PASS close ends the turn and exits the MCP client");
} finally {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("test shutting down"));
  }
  pending.clear();
  child.kill();
  await new Promise(resolve => daemon.close(resolve));
}
