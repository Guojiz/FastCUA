// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const pipe = `\\\\.\\pipe\\fastcua-server-test-${process.pid}-${Date.now()}`;
const calls = [];
let clickCount = 0;
let lastClick = null;
let closedConnections = 0;
const daemon = net.createServer(socket => {
  socket.once("close", () => closedConnections++);
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
      if (request.method === "get_window_state") continue;
      if (request.method === "click") {
        clickCount += 1;
        lastClick = request.params || {};
      }
      const result = request.method === "list_windows" ? [] : { ok: true, click_count: clickCount, last_click: lastClick };
      socket.write(JSON.stringify({ id: request.id, result }) + "\n");
    }
  });
});
let daemonListening = false;
function startDaemon() {
  return new Promise((resolve, reject) => {
    daemon.once("error", reject);
    daemon.listen(pipe, () => {
      daemonListening = true;
      resolve();
    });
  });
}

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
  assert.equal(initialized.serverInfo.version, "0.2.1");

  const listed = await rpc("tools/list");
  const names = listed.tools.map(tool => tool.name);
  assert.ok(!names.includes("set_value"));
  assert.ok(!names.includes("end_turn"));
  assert.ok(names.includes("close"));
  const secondary = listed.tools.find(tool => tool.name === "perform_secondary_action");
  assert.deepEqual(secondary.inputSchema.properties.action.enum, ["Raise"]);
  const typeText = listed.tools.find(tool => tool.name === "type_text");
  assert.equal(typeText.inputSchema.properties.replace.default, false);
  assert.equal(typeText.inputSchema.properties.via_clipboard, undefined);
  assert.match(typeText.description, /fails safely instead of sending global Ctrl\+A/i);
  assert.match(listed.tools.find(tool => tool.name === "list_apps").description, /running apps/i);
  console.log("PASS MCP contract matches v0.2.1 capabilities");

  const delayedConnection = await rpc("tools/call", {
    name: "js",
    arguments: {
      code: "await sky.get_window_state({ window: { app: 'fixture.exe', id: 1 }, include_screenshot: false, include_text: false });",
    },
  });
  assert.equal(delayedConnection.isError, true);
  assert.match(delayedConnection.content[0].text, /timed out/i);
  await startDaemon();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(calls.filter(method => method === "get_window_state").length, 0);
  console.log("PASS a timed-out call cannot execute after a delayed daemon connection");

  const closedBeforeIdleTimeout = closedConnections;
  const timedOut = await rpc("tools/call", {
    name: "js",
    arguments: { code: "await sleep(250); await sky.list_windows();" },
  });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /timed out/i);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(calls.filter(method => method === "list_windows").length, 0);
  assert.equal(closedConnections, closedBeforeIdleTimeout);
  console.log("PASS timed-out JS cells cannot issue later desktop calls");

  const closedBeforeTimeout = closedConnections;
  const timedOutDesktopPromise = rpc("tools/call", {
    name: "js",
    arguments: {
      code: "await sky.get_window_state({ window: { app: 'fixture.exe', id: 1 }, include_screenshot: false, include_text: false });",
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const unrelatedWindowsPromise = rpc("tools/call", { name: "list_windows", arguments: {} });
  const [timedOutDesktop, windows] = await Promise.all([timedOutDesktopPromise, unrelatedWindowsPromise]);
  assert.equal(timedOutDesktop.isError, true);
  assert.match(timedOutDesktop.content[0].text, /timed out/i);
  assert.equal(windows.isError, false);
  for (let attempt = 0; attempt < 20 && closedConnections === closedBeforeTimeout; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(closedConnections > closedBeforeTimeout, "timed-out JS desktop call must close its daemon client");
  assert.equal(calls.filter(method => method === "list_windows").length, 1);
  console.log("PASS timed-out JS desktop work does not disconnect an unrelated MCP call");

  const firstJs = rpc("tools/call", {
    name: "js",
    arguments: {
      code: "await sky.get_window_state({ window: { app: 'fixture.exe', id: 1 }, include_screenshot: false, include_text: false });",
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  const secondJs = rpc("tools/call", {
    name: "js",
    arguments: { code: "const windows = await sky.list_windows(); nodeRepl.write(windows.length);" },
  });
  const [firstJsResult, secondJsResult] = await Promise.all([firstJs, secondJs]);
  assert.equal(firstJsResult.isError, true);
  assert.equal(secondJsResult.isError, false);
  assert.equal(calls.filter(method => method === "list_windows").length, 2);
  console.log("PASS concurrent JS cells are serialized and recover after cancellation");

  const closedBeforeDetached = closedConnections;
  const detached = await rpc("tools/call", {
    name: "js",
    arguments: {
      code: "void sky.get_window_state({ window: { app: 'fixture.exe', id: 1 }, include_screenshot: false, include_text: false }); await sleep(20);",
    },
  });
  assert.equal(detached.isError, false);
  for (let attempt = 0; attempt < 20 && closedConnections === closedBeforeDetached; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(closedConnections > closedBeforeDetached, "detached desktop work must be cancelled when its JS cell ends");
  const windowsAfterDetached = await rpc("tools/call", { name: "list_windows", arguments: {} });
  assert.equal(windowsAfterDetached.isError, false);
  console.log("PASS detached desktop work is cancelled without an unhandled rejection");

  const detachedCallback = await rpc("tools/call", {
    name: "js",
    arguments: { code: "fs.readFile('server.mjs', async () => { await sky.list_windows(); });" },
  });
  assert.equal(detachedCallback.isError, false);
  await new Promise(resolve => setTimeout(resolve, 100));
  const windowsAfterCallback = await rpc("tools/call", { name: "list_windows", arguments: {} });
  assert.equal(windowsAfterCallback.isError, false);
  console.log("PASS inactive-cell callbacks cannot crash the MCP server");

  const legacyEndTurn = await rpc("tools/call", {
    name: "js",
    arguments: { code: "await sky.end_turn();" },
  });
  assert.equal(legacyEndTurn.isError, true);
  assert.match(legacyEndTurn.content[0].text, /end_turn is not a function/i);
  console.log("PASS end_turn is unavailable through both MCP and sky");


  const clickProbe = await rpc("tools/call", {
    name: "js",
    arguments: { code: [
      "const win = { app: 'a.exe', id: 1 };",
      "const out = {};",
      "const view = { cropLeft: 100, cropTop: 50, width: 200, height: 100, scale: 2 };",
      "out.cv = await sky.click_view({ window: win, view: view, x: 10, y: 20 });",
      "try { await sky.click_view({ window: win, view: view, x: 250, y: 20 }); out.cvBad = 'not-rejected'; } catch (err) { out.cvBad = String(err.message || err); }",
      "const grid = { viewport: { left: 0, top: 0 }, cells: [{ id: '5', left: 100, top: 50, side: 40, cx: 120, cy: 70 }] };",
      "out.ccell = await sky.click_cell({ window: win, grid: grid, cell: '5' });",
      "out.cc = await sky.click_in_cell({ window: win, grid: grid, cell: '5', x: 10, y: 20 });",
      "try { await sky.click_in_cell({ window: win, grid: grid, cell: '5', x: 40, y: 20 }); out.ccBad = 'not-rejected'; } catch (err) { out.ccBad = String(err.message || err); }",
      "try { await sky.click_in_cell({ window: win, grid: { cells: [] }, cell: '5', x: 1, y: 1 }); out.ccMissing = 'not-rejected'; } catch (err) { out.ccMissing = String(err.message || err); }",
      "const view2 = { cropLeft: 0, cropTop: 0, width: 300, height: 229, scale: 2.2667 };",
      "const grid2 = { viewport: { left: 0, top: 0 }, cells: [{ id: '2', left: 50, top: 25, side: 40, cx: 70, cy: 45 }] };",
      "out.ccScaled = await sky.click_in_cell({ window: win, grid: grid2, cell: '2', x: 10, y: 5, view: view2 });",
      "try { await sky.click_in_cell({ window: win, grid: grid2, cell: '2', x: 20, y: 5, view: view2 }); out.ccScaledBad = 'not-rejected'; } catch (err) { out.ccScaledBad = String(err.message || err); }",
      "out.cvScaled = await sky.click_view({ window: win, view: view2, x: 176, y: 203 });",
      "nodeRepl.write(JSON.stringify(out));"
    ].join("\n") },
  });
  assert.equal(clickProbe.isError, false, clickProbe.content[0].text);
  const probe = JSON.parse(clickProbe.content[0].text);
  assert.equal(probe.cv.last_click.x, 120);
  assert.equal(probe.cv.last_click.y, 90);
  assert.equal(probe.cv.last_click.space, "window_pixels");
  assert.equal(probe.cv.click_count, 1);
  assert.match(probe.cvBad, /outside this view image/);
  assert.equal(probe.ccell.last_click.snap, true);
  assert.equal(probe.ccell.last_click.space, "window_pixels");
  assert.equal(probe.ccell.last_click.x, 120);
  assert.equal(probe.ccell.last_click.y, 70);
  assert.equal(probe.cc.last_click.x, 110);
  assert.equal(probe.cc.last_click.y, 70);
  assert.equal(probe.cc.last_click.snap, true);
  assert.match(probe.ccBad, /outside cell 5/);
  assert.match(probe.ccMissing, /cell/i);
  assert.equal(probe.ccScaled.last_click.x, 73);
  assert.equal(probe.ccScaled.last_click.y, 36);
  assert.match(probe.ccScaledBad, /outside cell 2/);
  assert.ok(Math.abs(probe.cvScaled.last_click.x - 399) <= 1 && Math.abs(probe.cvScaled.last_click.y - 460) <= 1, "downscaled view coords map back to window pixels");
  assert.equal(probe.cvScaled.click_count, 5, "rejected calls never reached the daemon");
  console.log("PASS click_view / click_in_cell translate, snap, and reject out-of-bounds");
  const exited = waitForChildExit();
  const closePromise = rpc("tools/call", { name: "close", arguments: {} });
  const afterClosePromise = rpc("tools/call", { name: "list_windows", arguments: {} });
  const [closed, afterClose] = await Promise.all([closePromise, afterClosePromise]);
  assert.equal(closed.isError, false);
  assert.equal(afterClose.isError, true);
  assert.match(afterClose.content[0].text, /closing/i);
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(calls.filter(method => method === "close").length >= 1, "close reached the daemon");
  assert.equal(calls.filter(method => method === "list_windows").length, 4);
  console.log("PASS close fences later work and exits the MCP client");
} finally {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("test shutting down"));
  }
  pending.clear();
  child.kill();
  if (daemonListening) await new Promise(resolve => daemon.close(resolve));
}
