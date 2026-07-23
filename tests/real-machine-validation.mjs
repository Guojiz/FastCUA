// SPDX-License-Identifier: MIT
//
// Real-machine validation for FastCUA freeze hardening.
//
// Spawns the daemon like tests/run-control-plane.ps1 (own pipe/port, temp
// config, overlay disabled) and drives the raw newline-JSON pipe protocol:
//   1. UIA path  — Notepad + classic-fixture edit round-trip (type + read back).
//   2. Vision    — JPEG screenshot + grid_view annotated image, non-trivial bytes.
//   3. Freeze A  — hung UIA provider (fixture with FASTCUA_FIXTURE_HANG_MS):
//                  fail fast (<6s), helper NOT killed, later requests stay fast.
//   4. Freeze B  — target window killed mid-request: bounded error, daemon responsive.
//   5. Freeze C  — client disconnect during in-flight work: daemon recovers.
//   6. Click modes + capture contract: click_view/click_in_cell deltas,
//      downscaled capture click mapping, dedup unchanged, snap-to-center.
//   7. UIA profile: hang persisted -> short prior probe -> rehabilitation.
//
// Usage: node tests/real-machine-validation.mjs
// Output: tests/_validation-<yyyymmdd-HHmmss>.log

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CUA_BIN = path.join(ROOT, "native-host", "target", "release", "cua-native-host.exe");
const FIXTURE = path.join(HERE, "FastCuaFixture.exe");

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17);
const LOG_PATH = path.join(HERE, `_validation-${stamp}.log`);
const logLines = [];
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(" ");
  logLines.push(line);
  console.log(line);
  fs.writeFileSync(LOG_PATH, logLines.join("\n") + "\n");
}

const results = [];
function check(name, condition, detail = "") {
  const ok = Boolean(condition);
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) throw new Error(`validation failed: ${name} ${detail}`);
}
function timed(name, promise) {
  const t0 = performance.now();
  return Promise.resolve(promise).then(
    (value) => ({ value, ms: Math.round(performance.now() - t0), error: null }),
    (error) => ({ value: null, ms: Math.round(performance.now() - t0), error }),
  );
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function taskkillImage(image) {
  try { execFileSync("taskkill.exe", ["/IM", image, "/F"], { stdio: "ignore" }); } catch {}
}
function pidsOf(image) {
  try {
    const out = execFileSync("tasklist.exe", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    return [...out.matchAll(new RegExp(`"${image}","(\\d+)"`, "gi"))].map((m) => Number(m[1]));
  } catch { return []; }
}

class PipeClient {
  constructor(pipe) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.socket = net.connect(pipe);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.closed = new Promise((resolve) => this.socket.once("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("pipe client closed"));
      }
      this.pending.clear();
      resolve();
    }));
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }
  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    }
  }
  request(method, params = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`client-side timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() { try { this.socket.end(); } catch {} }
  destroy() { try { this.socket.destroy(); } catch {} }
}

async function apiJson(base, route, body) {
  const response = await fetch(base + route, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function waitForWindow(client, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await client.request("list_windows");
    const found = windows.find(predicate);
    if (found) return found;
    await sleep(150);
  }
  throw new Error(`window not found: ${label}`);
}

function decodeImageBytes(result) {
  const shot = result?.screenshots?.[0];
  const match = /^data:([^;]+);base64,(.*)$/s.exec(shot?.url || "");
  return match ? { mime: match[1], bytes: Buffer.byteLength(match[2], "base64") } : { mime: null, bytes: 0 };
}


// ---- extra session helpers (phases 6-7) ----
async function startDaemonSession(configDir, label) {
  const configPath = path.join(configDir, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      costartMode: "manual",
      idleTimeoutMin: 0,
      approvalPolicy: "safe",
      whitelist: ["notepad.exe", "FastCuaFixture.exe"],
      port: 8420,
      bannerEnabled: false,
      overlayEnabled: false,
      overlayTitle: "FastCUA validation",
      overlayLanguage: "auto",
      cuaBinPath: "",
    }, null, 2));
  }
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const pipe = `\\\\.\\pipe\\fastcua-validate-${label}-${process.pid}`;
  const proc = spawn(process.execPath, [path.join(ROOT, "daemon.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CUA_BIN,
      FASTCUA_PIPE: pipe,
      FASTCUA_HTTP_PORT: String(port),
      FASTCUA_CONFIG_PATH: configPath,
      FASTCUA_DISABLE_OVERLAY: "1",
      FASTCUA_HOME: path.join(configDir, "home"),
    },
  });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    try { await apiJson(base, "/api/state"); ready = true; }
    catch { await sleep(100); }
  }
  if (!ready) throw new Error(`daemon session ${label} did not become ready\n` + err.slice(-1500));
  const client = new PipeClient(pipe);
  await client.ready();
  return { proc, base, pipe, client, configDir, configPath };
}

async function stopDaemonSession(sess) {
  try { sess.client.close(); } catch {}
  try { await apiJson(sess.base, "/api/action", { action: "shutdown" }); } catch {}
  await Promise.race([new Promise((resolve) => sess.proc.once("exit", resolve)), sleep(3_000)]);
  try { sess.proc.kill(); } catch {}
}

function startMcpClient(pipe, configPath) {
  const proc = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      FASTCUA_PIPE: pipe,
      FASTCUA_COSTART_MODE: "manual",
      FASTCUA_CONFIG_PATH: configPath,
    },
  });
  let err = "";
  proc.stderr.on("data", (d) => { err += d; });
  let nextId = 1;
  let buf = "";
  const pending = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    }
  });
  const rpc = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("mcp timeout: " + method)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const js = async (code, timeoutMs = 30_000) => {
    const res = await rpc("tools/call", { name: "js", arguments: { code } }, timeoutMs);
    if (res?.isError) throw new Error("js cell failed: " + String(res?.content?.[0]?.text || "").slice(0, 500));
    return String(res?.content?.[0]?.text || "");
  };
  return { proc, rpc, js, getErr: () => err, kill: () => { try { proc.kill(); } catch {} } };
}

async function main() {
  if (!fs.existsSync(CUA_BIN)) throw new Error("native host not built: " + CUA_BIN);
  if (!fs.existsSync(FIXTURE)) throw new Error("fixture not built: " + FIXTURE);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-validate-"));
  const configPath = path.join(temp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    costartMode: "manual",
    idleTimeoutMin: 0,
    approvalPolicy: "safe",
    whitelist: ["notepad.exe", "FastCuaFixture.exe"],
    port: 8420,
    bannerEnabled: false,
    overlayEnabled: false,
    overlayTitle: "FastCUA validation",
    overlayLanguage: "auto",
    cuaBinPath: "",
  }, null, 2));

  // Reserve a free loopback port.
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const pipe = `\\\\.\\pipe\\fastcua-validate-${stamp}`;

  log("spawning daemon", JSON.stringify({ pipe, port }));
  const daemon = spawn(process.execPath, [path.join(ROOT, "daemon.mjs")], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      CUA_BIN,
      FASTCUA_PIPE: pipe,
      FASTCUA_HTTP_PORT: String(port),
      FASTCUA_CONFIG_PATH: configPath,
      FASTCUA_DISABLE_OVERLAY: "1",
      FASTCUA_HOME: path.join(temp, "home"),
    },
  });
  let daemonErr = "";
  daemon.stderr.on("data", (d) => { daemonErr += d; });

  const daemonExit = new Promise((resolve) => daemon.once("exit", resolve));
  const cleanup = () => {
    try { daemon.kill(); } catch {}
    taskkillImage("FastCuaFixture.exe");
    for (const pid of spawnedNotepadPids) {
      try { process.kill(pid); } catch {}
      try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
  };
  const spawnedNotepadPids = [];

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      try { await apiJson(base, "/api/state"); ready = true; }
      catch { await sleep(100); }
    }
    if (!ready) throw new Error("daemon did not become ready\n" + daemonErr.slice(-2000));

    const client = new PipeClient(pipe);
    await client.ready();

    // ---------- Phase 1: UIA path (Notepad) ----------
    log("--- phase 1: UIA text round-trip on Notepad ---");
    const notepadBefore = pidsOf("notepad.exe");
    const notepadExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe");
    let r = await timed("launch notepad", client.request("launch_app", { app: notepadExe }));
    check("launch notepad.exe", !r.error, `${r.ms}ms${r.error ? " " + r.error.message : ""}`);
    const notepadWindow = await waitForWindow(client,
      (w) => /notepad\.exe/i.test(w.app), "notepad");
    for (const pid of pidsOf("notepad.exe")) {
      if (!notepadBefore.includes(pid)) spawnedNotepadPids.push(pid);
    }
    log("notepad window", JSON.stringify(notepadWindow));

    r = await timed("state(text)", client.request("get_window_state", {
      window: notepadWindow, include_screenshot: false, include_text: true,
    }));
    check("notepad UIA tree resolves", !r.error, `${r.ms}ms`);
    const tree = r.value?.accessibility?.tree || "";
    const editMatch = /^\s*(\d+)\s+(?:Edit|Document)\b/m.exec(tree);
    check("notepad editor element found in UIA tree", editMatch, editMatch ? `element_index=${editMatch[1]}` : tree.slice(0, 300));
    r = await timed("click editor", client.request("click", {
      window: notepadWindow, element_index: Number(editMatch[1]),
    }));
    check("click notepad editor", !r.error, `${r.ms}ms${r.error ? " " + r.error.message : ""}`);

    r = await timed("read focused_value", client.request("get_window_state", {
      window: notepadWindow, include_screenshot: false, include_text: true,
    }));
    check("read focused_value", !r.error, `${r.ms}ms`);
    log("initial focused_value:", JSON.stringify(r.value?.accessibility?.focused_value));

    const typed = "FastCUA 真机验证 hello";
    r = await timed("type_text append", client.request("type_text", {
      window: notepadWindow, text: typed,
    }));
    check("type_text into notepad", !r.error, `${r.ms}ms${r.error ? " " + r.error.message : ""}`);

    r = await timed("verify typed text", client.request("get_window_state", {
      window: notepadWindow, include_screenshot: false, include_text: true,
    }));
    check("read back after typing", !r.error, `${r.ms}ms`);
    const afterFocus = r.value?.accessibility?.focused_value;
    const afterDoc = r.value?.accessibility?.document_text || "";
    const verifiedVia = typeof afterFocus === "string" && afterFocus.includes(typed) ? "focused_value"
      : afterDoc.includes(typed) ? "document_text"
      : (r.value?.accessibility?.tree || "").includes(typed) ? "tree" : null;
    check("typed text verified via UIA", verifiedVia, verifiedVia || `focused=${JSON.stringify(afterFocus)}`);
    // Undo the probe text so the real-machine drill leaves no edit behind.
    r = await timed("undo probe text", client.request("press_key", {
      window: notepadWindow, key: "Control_L+z",
    }));
    log("undo probe text:", r.error ? "error " + r.error.message : `${r.ms}ms ok`);

    // Scoped replace on the fixture edit control (classic Win32 EDIT).
    r = await timed("launch fixture", client.request("launch_app", { app: FIXTURE }));
    check("launch fixture", !r.error, `${r.ms}ms`);
    const fixtureWindow = await waitForWindow(client,
      (w) => w.title === "FastCUA Host Test Fixture", "fixture");
    r = await timed("fixture state", client.request("get_window_state", {
      window: fixtureWindow, include_screenshot: false, include_text: true,
    }));
    check("fixture state resolves", !r.error, `${r.ms}ms`);
    const editLines = (r.value?.accessibility?.tree || "").split("\n")
      .filter((line) => /^\s*\d+\s+Edit\b/.test(line));
    const fixtureEdit = /^\s*(\d+)\s+Edit\b/.exec(editLines[0] || "");
    check("fixture edit element found", fixtureEdit,
      fixtureEdit ? `element_index=${fixtureEdit[1]}` : (r.value?.accessibility?.tree || "").slice(0, 400));
    r = await timed("fixture click edit", client.request("click", {
      window: fixtureWindow, element_index: Number(fixtureEdit[1]),
    }));
    check("fixture click edit", !r.error, `${r.ms}ms`);
    r = await timed("fixture replace", client.request("type_text", {
      window: fixtureWindow, text: "替换 OK 123", replace: true,
    }));
    check("scoped replace:true on fixture edit", !r.error, `${r.ms}ms${r.error ? " " + r.error.message : ""}`);
    r = await timed("fixture verify replace", client.request("get_window_state", {
      window: fixtureWindow, include_screenshot: false, include_text: true,
    }));
    check("replace verified via focused_value", r.value?.accessibility?.focused_value === "替换 OK 123",
      JSON.stringify(r.value?.accessibility?.focused_value));
    taskkillImage("FastCuaFixture.exe");

    // ---------- Phase 2: vision path ----------
    log("--- phase 2: vision (screenshot + grid_view) ---");
    r = await timed("state(screenshot)", client.request("get_window_state", {
      window: notepadWindow, include_screenshot: true, include_text: false,
    }));
    check("screenshot request resolves", !r.error, `${r.ms}ms`);
    const shot = decodeImageBytes(r.value);
    check("screenshot JPEG non-trivial", shot.bytes > 10_000, `${shot.mime} ${shot.bytes} bytes`);
    check("screenshot bounded latency", r.ms < 8_000, `${r.ms}ms`);

    r = await timed("grid_view", client.request("grid_view", { window: notepadWindow, path: [] }));
    check("grid_view resolves", !r.error, `${r.ms}ms${r.error ? " " + r.error.message : ""}`);
    const gridBytes = decodeImageBytes(r.value);
    const gridOk = gridBytes.bytes > 10_000 || JSON.stringify(r.value).length > 20_000;
    check("grid_view annotated payload non-trivial", gridOk, `${gridBytes.mime} ${gridBytes.bytes} bytes`);
    check("grid_view bounded latency", r.ms < 8_000, `${r.ms}ms`);

    // ---------- Phase 3: freeze drill A — hung UIA provider ----------
    log("--- phase 3: hung UIA provider drill ---");
    const hungEnv = { ...process.env, FASTCUA_FIXTURE_HANG_MS: "9000" };
    const hung = spawn(FIXTURE, [], { env: hungEnv, stdio: "ignore", windowsHide: true });
    const hungWindow = await waitForWindow(client,
      (w) => w.title === "FastCUA Host Test Fixture", "hung fixture");
    const pidBefore = (await apiJson(base, "/api/state")).binaryPid;
    check("helper resident before hung-provider drill", pidBefore, `pid=${pidBefore}`);

    r = await timed("hung state(text)", client.request("get_window_state", {
      window: hungWindow, include_screenshot: false, include_text: true,
    }));
    const uiaMeta = r.value?.uia || {};
    check("hung provider fails fast with vision preference", !r.error && uiaMeta.prefer_vision === true,
      `${r.ms}ms quality=${uiaMeta.quality} reason=${uiaMeta.reason}${r.error ? " " + r.error.message : ""}`);
    check("hung provider bounded <6s", r.ms < 6_000, `${r.ms}ms`);
    const pidAfter = (await apiJson(base, "/api/state")).binaryPid;
    check("helper NOT killed by hung provider", pidAfter === pidBefore, `pid ${pidBefore} -> ${pidAfter}`);

    r = await timed("hung state(text) again", client.request("get_window_state", {
      window: hungWindow, include_screenshot: false, include_text: true,
    }));
    check("second request uses disabled-provider fast path", !r.error && r.ms < 2_500,
      `${r.ms}ms reason=${r.value?.uia?.reason}`);

    r = await timed("hung screenshot", client.request("get_window_state", {
      window: hungWindow, include_screenshot: true, include_text: false,
    }));
    const hungShot = decodeImageBytes(r.value);
    check("screenshot still works on hung window", !r.error && hungShot.bytes > 5_000,
      `${r.ms}ms ${hungShot.bytes} bytes`);

    r = await timed("hung grid_view", client.request("grid_view", { window: hungWindow, path: [] }));
    const hungGrid = decodeImageBytes(r.value);
    check("grid_view still works on hung window", !r.error && hungGrid.bytes > 5_000 && r.ms < 5_000,
      `${r.ms}ms ${hungGrid.bytes} bytes${r.error ? " " + r.error.message : ""}`);

    r = await timed("list_apps after hang", client.request("list_apps"));
    check("list_apps responsive after hang", !r.error && r.ms < 2_500, `${r.ms}ms`);

    r = await timed("replace on disabled provider", client.request("type_text", {
      window: hungWindow, text: "x", replace: true,
    }));
    check("replace:true fails fast on disabled provider",
      r.error && /disabled after provider timeout|not responding|could not activate/i.test(r.error.message) && r.ms < 2_500,
      `${r.ms}ms ${r.error ? r.error.message.slice(0, 120) : "unexpected success"}`);

    const stateApi = await timed("/api/state", apiJson(base, "/api/state"));
    check("/api/state responsive during hang", !stateApi.error && stateApi.ms < 1_000, `${stateApi.ms}ms`);

    log("waiting for fixture hang window to elapse...");
    await sleep(9_500);
    r = await timed("state after hang elapsed", client.request("get_window_state", {
      window: hungWindow, include_screenshot: false, include_text: true,
    }));
    check("daemon still responsive after hang elapsed", !r.error && r.ms < 5_000,
      `${r.ms}ms reason=${r.value?.uia?.reason}${r.error ? " " + r.error.message : ""}`);
    hung.kill("SIGTERM") || taskkillImage("FastCuaFixture.exe");
    taskkillImage("FastCuaFixture.exe");

    // ---------- Phase 4: freeze drill B — target killed mid-request ----------
    log("--- phase 4: target killed mid-request ---");
    const before2 = pidsOf("notepad.exe");
    const inflight = client.request("get_window_state", {
      window: notepadWindow, include_screenshot: true, include_text: true,
    }).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    await sleep(50);
    for (const pid of spawnedNotepadPids) {
      try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    }
    r = await timed("killed-mid-request", inflight);
    check("request bounded when target dies mid-flight", r.ms < 10_000,
      `${r.ms}ms ${r.error ? "error: " + r.error.message.slice(0, 100) : "resolved"}`);
    r = await timed("list_windows after kill", client.request("list_windows"));
    check("daemon responsive after target death", !r.error && r.ms < 2_500, `${r.ms}ms`);
    void before2;

    // ---------- Phase 5: freeze drill C — disconnect during in-flight work ----------
    log("--- phase 5: disconnect during in-flight work ---");
    r = await timed("relaunch fixture", client.request("launch_app", { app: FIXTURE }));
    check("relaunch fixture for disconnect drill", !r.error, `${r.ms}ms`);
    const dcWindow = await waitForWindow(client,
      (w) => w.title === "FastCUA Host Test Fixture", "fixture (disconnect drill)");
    const rude = new PipeClient(pipe);
    await rude.ready();
    const burst = Array.from({ length: 8 }, () => rude.request("get_window_state", {
      window: dcWindow, include_screenshot: false, include_text: true,
    }).then(() => null, (error) => error));
    rude.destroy();
    await rude.closed;
    const burstResults = await Promise.all(burst);
    check("disconnect cancelled in-flight work", burstResults.some(Boolean),
      `${burstResults.filter(Boolean).length}/8 cancelled`);
    r = await timed("list_windows after rude disconnect", client.request("list_windows"));
    check("main client unaffected by rude disconnect", !r.error && r.ms < 2_500, `${r.ms}ms`);
    const pidFinal = (await apiJson(base, "/api/state")).binaryPid;
    check("helper alive or transparently respawned", pidFinal, `pid=${pidFinal}`);
    taskkillImage("FastCuaFixture.exe");

    // ---------- Phase 6: click modes + capture contract (fresh daemon session) ----------
    log("--- phase 6: click_view / click_in_cell / downscale mapping / dedup / snap ---");
    const clickDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-clicks-"));
    const sessX = await startDaemonSession(clickDir, "clicks");
    try {
      let rx = await timed("session X launch fixture", sessX.client.request("launch_app", { app: FIXTURE }));
      check("session X fixture launches", !rx.error, `${rx.ms}ms`);
      const winX = await waitForWindow(sessX.client,
        (w) => w.title === "FastCUA Host Test Fixture", "fixture (session X)");
      log("session X fixture window", JSON.stringify(winX));
      const winJson = JSON.stringify({ app: winX.app, id: winX.id });

      // Capture space = physical pixels; the fixture is 680x520 LOGICAL (Fixture.cs).
      // dpi converts logical window px <-> capture px. LastClick/BtnClick are reported
      // by the fixture in its own logical client px, so all delta expectations below
      // are in logical units and dpi-independent.
      const st0 = await sessX.client.request("get_window_state", {
        window: winX, include_screenshot: false, include_text: false,
      });
      const vp0 = st0?.viewport || {};
      const dpi = Number(vp0.width) / 680;
      check("fixture viewport geometry sane", Number(vp0.width) >= 680 && dpi >= 1 && dpi <= 4,
        `viewport=${vp0.width}x${vp0.height} dpiFactor=${dpi}`);
      log("session X coordinate space", JSON.stringify({ viewportWidth: vp0.width, viewportHeight: vp0.height, dpi }));

      const mcp = startMcpClient(sessX.pipe, sessX.configPath);
      try {
        const init = await mcp.rpc("initialize");
        check("MCP server initializes against session X", init?.serverInfo?.name === "sky-computer-use",
          String(init?.serverInfo?.name || mcp.getErr()).slice(0, 200));

        // click_view end-to-end: two background points, delta must match translation.
        // Logical window-rel (620,490)/(630,500) = empty client area below the LastClick static.
        const cvText = await mcp.js([
          "const win = " + winJson + ";",
          "const dpi = " + dpi + ";",
          "const gv = await sky.grid_view({ window: win });",
          "const v = gv.view;",
          "const s = v.scale || 1;",
          "await sky.click_view({ window: win, view: v, x: (620 * dpi - v.cropLeft) / s, y: (490 * dpi - v.cropTop) / s });",
          "await sleep(200);",
          "const t1 = await sky.get_window_state({ window: win, include_screenshot: false, include_text: true });",
          "const m1 = /LastClick: (-?\\d+),(-?\\d+)/.exec(t1.accessibility.tree || '');",
          "await sky.click_view({ window: win, view: v, x: (630 * dpi - v.cropLeft) / s, y: (500 * dpi - v.cropTop) / s });",
          "await sleep(200);",
          "const t2 = await sky.get_window_state({ window: win, include_screenshot: false, include_text: true });",
          "const m2 = /LastClick: (-?\\d+),(-?\\d+)/.exec(t2.accessibility.tree || '');",
          "nodeRepl.write(JSON.stringify({ view: { cropLeft: v.cropLeft, cropTop: v.cropTop, width: v.width, height: v.height, scale: s }, m1: m1 && [Number(m1[1]), Number(m1[2])], m2: m2 && [Number(m2[1]), Number(m2[2])] }));",
        ].join("\n"));
        const cv = JSON.parse(cvText);
        check("click_view: fixture recorded both background clicks", !!(cv.m1 && cv.m2), JSON.stringify(cv).slice(0, 300));
        if (cv.m1 && cv.m2) {
          const dx = cv.m2[0] - cv.m1[0];
          const dy = cv.m2[1] - cv.m1[1];
          check("click_view: delta matches view->window translation", Math.abs(dx - 10) <= 2 && Math.abs(dy - 10) <= 2,
            `delta=(${dx},${dy}) view=${JSON.stringify(cv.view)}`);
        }

        // click_in_cell end-to-end: cell-local offsets land cell.left+x, cell.top+y.
        const ccText = await mcp.js([
          "const win = " + winJson + ";",
          "const dpi = " + dpi + ";",
          "const gv = await sky.grid_view({ window: win });",
          "const cells = gv.grid.cells || [];",
          "const px = 560 * dpi;",
          "const py = 450 * dpi;",
          "const cell = cells.find((c) => px >= c.left && px < c.left + (c.side || c.width) && py >= c.top && py < c.top + (c.side || c.height || c.width));",
          "if (!cell) throw new Error('no cell contains target: ' + JSON.stringify(cells).slice(0, 300));",
          "const x1 = px - cell.left;",
          "const y1 = py - cell.top;",
          "await sky.click_in_cell({ window: win, grid: gv.grid, cell: cell.id, x: x1, y: y1 });",
          "await sleep(200);",
          "const t1 = await sky.get_window_state({ window: win, include_screenshot: false, include_text: true });",
          "const m1 = /LastClick: (-?\\d+),(-?\\d+)/.exec(t1.accessibility.tree || '');",
          "await sky.click_in_cell({ window: win, grid: gv.grid, cell: cell.id, x: x1 + 10 * dpi, y: y1 + 10 * dpi });",
          "await sleep(200);",
          "const t2 = await sky.get_window_state({ window: win, include_screenshot: false, include_text: true });",
          "const m2 = /LastClick: (-?\\d+),(-?\\d+)/.exec(t2.accessibility.tree || '');",
          "let rej = '';",
          "try { await sky.click_in_cell({ window: win, grid: gv.grid, cell: cell.id, x: (cell.side || cell.width) + 5, y: 0 }); } catch (e) { rej = String(e && e.message || e); }",
          "nodeRepl.write(JSON.stringify({ cell, m1: m1 && [Number(m1[1]), Number(m1[2])], m2: m2 && [Number(m2[1]), Number(m2[2])], rej }));",
        ].join("\n"));
        const cc = JSON.parse(ccText);
        check("click_in_cell: fixture recorded both cell clicks", !!(cc.m1 && cc.m2), JSON.stringify(cc).slice(0, 300));
        if (cc.m1 && cc.m2) {
          const dx = cc.m2[0] - cc.m1[0];
          const dy = cc.m2[1] - cc.m1[1];
          check("click_in_cell: delta matches cell-local offset", Math.abs(dx - 10) <= 2 && Math.abs(dy - 10) <= 2,
            `delta=(${dx},${dy}) cell=${JSON.stringify(cc.cell)}`);
        }
        check("click_in_cell: out-of-cell coordinate rejected", /outside cell/.test(cc.rej || ""),
          String(cc.rej || "").slice(0, 160));
      } finally {
        mcp.kill();
      }

      // Downscaled capture + default screenshot-pixel click mapping (raw pipe).
      let r6 = await timed("downscaled capture", sessX.client.request("get_window_state", {
        window: winX, include_screenshot: true, include_text: false, max_edge: 300,
      }));
      check("downscaled capture resolves", !r6.error, `${r6.ms}ms${r6.error ? " " + r6.error.message : ""}`);
      const dShot = r6.value?.screenshots?.[0] || {};
      const dScale = Number(dShot.scale || r6.value?.viewport?.scale || 0);
      const expScale = Number(vp0.width) / 300;
      check("capture downscaled to max_edge 300", dShot.width === 300 && Math.abs(dScale - expScale) < expScale * 0.02,
        `width=${dShot.width} scale=${dShot.scale} expected~${expScale} viewport.scale=${r6.value?.viewport?.scale}`);
      const sxp1 = { x: Math.round(620 * dpi / dScale), y: Math.round(490 * dpi / dScale) };
      const sxp2 = { x: sxp1.x + 11, y: sxp1.y + 4 };
      const expLogDx = (Math.round(sxp2.x * dScale) - Math.round(sxp1.x * dScale)) / dpi;
      const expLogDy = (Math.round(sxp2.y * dScale) - Math.round(sxp1.y * dScale)) / dpi;
      await sessX.client.request("click", { window: winX, x: sxp1.x, y: sxp1.y });
      await sleep(200);
      const st1 = await sessX.client.request("get_window_state", {
        window: winX, include_screenshot: false, include_text: true,
      });
      const sm1 = /LastClick: (-?\d+),(-?\d+)/.exec(st1?.accessibility?.tree || "");
      await sessX.client.request("click", { window: winX, x: sxp2.x, y: sxp2.y });
      await sleep(200);
      const st2 = await sessX.client.request("get_window_state", {
        window: winX, include_screenshot: false, include_text: true,
      });
      const sm2 = /LastClick: (-?\d+),(-?\d+)/.exec(st2?.accessibility?.tree || "");
      check("screenshot-pixel clicks recorded by fixture", !!(sm1 && sm2),
        `m1=${sm1 && sm1[0]} m2=${sm2 && sm2[0]}`);
      if (sm1 && sm2) {
        const dx = Number(sm2[1]) - Number(sm1[1]);
        const dy = Number(sm2[2]) - Number(sm1[2]);
        check("default click space maps screenshot pixels through capture scale",
          Math.abs(dx - expLogDx) <= 3 && Math.abs(dy - expLogDy) <= 3,
          `delta=(${dx},${dy}) expected~(${expLogDx.toFixed(1)},${expLogDy.toFixed(1)}) scale=${dScale}`);
      }

      // Capture dedup: identical frame -> unchanged, input -> fresh capture.
      r6 = await timed("dedup capture #1", sessX.client.request("get_window_state", {
        window: winX, include_screenshot: true, include_text: false,
      }));
      check("dedup capture #1 carries an image", !r6.error && (r6.value?.screenshots?.[0]?.url || "").length > 100,
        `${r6.ms}ms`);
      r6 = await timed("dedup capture #2", sessX.client.request("get_window_state", {
        window: winX, include_screenshot: true, include_text: false,
      }));
      const shot2 = r6.value?.screenshots?.[0] || {};
      const unchanged2 = r6.value?.unchanged === true || shot2.unchanged === true;
      check("identical capture is deduplicated", !r6.error && unchanged2 && !(shot2.url),
        `unchanged=${unchanged2} note=${String(r6.value?.note || shot2.note || "").slice(0, 80)}`);
      const editM = /^\s*(\d+)\s+Edit\b/m.exec(st2?.accessibility?.tree || "");
      check("fixture edit found for dedup-invalidation probe", !!editM, "");
      if (editM) {
        await sessX.client.request("click", { window: winX, element_index: Number(editM[1]) });
        r6 = await timed("type for dedup probe", sessX.client.request("type_text", {
          window: winX, text: "dedup probe",
        }));
        check("type_text for dedup probe succeeds", !r6.error, `${r6.ms}ms${r6.error ? " " + r6.error.message : ""}`);
        r6 = await timed("dedup capture #3", sessX.client.request("get_window_state", {
          window: winX, include_screenshot: true, include_text: false,
        }));
        const shot3 = r6.value?.screenshots?.[0] || {};
        const unchanged3 = r6.value?.unchanged === true || shot3.unchanged === true;
        check("capture after input is fresh (not deduplicated)", !r6.error && (shot3.url || "").length > 100 && !unchanged3,
          `unchanged=${unchanged3}`);
      }

      // Snap: a point inside the button but off-center snaps to the element center.
      // Button logical client rect (490,19,145,32) -> window-rel (498,50)-(643,82);
      // click (520,60) logical is inside, center is client (562,35).
      r6 = await timed("snap click on button", sessX.client.request("click", {
        window: winX, x: Math.round(520 * dpi), y: Math.round(60 * dpi), space: "window_pixels", snap: true,
      }));
      check("snap click resolves", !r6.error, `${r6.ms}ms${r6.error ? " " + r6.error.message : ""}`);
      await sleep(200);
      const st3 = await sessX.client.request("get_window_state", {
        window: winX, include_screenshot: false, include_text: true,
      });
      const tree3 = st3?.accessibility?.tree || "";
      const clicksLine = /Clicks: \d+/.exec(tree3)?.[0] || "(none)";
      const bm = /BtnClick: (-?\d+),(-?\d+)/.exec(tree3);
      check("button registered the snapped click", /Clicks: 1/.test(tree3) && !!bm,
        `${clicksLine} BtnClick=${bm && bm[0]}`);
      if (bm) {
        const bx = Number(bm[1]);
        const by = Number(bm[2]);
        check("snap moved the click to the button center", Math.abs(bx - 562) <= 4 && Math.abs(by - 35) <= 4,
          `BtnClick=(${bx},${by}) expected~(562,35)`);
      }
    } finally {
      await stopDaemonSession(sessX);
      taskkillImage("FastCuaFixture.exe");
    }

    // ---------- Phase 7: per-app UIA quality profile ----------
    log("--- phase 7: UIA quality profile (hang -> short probe -> rehabilitate) ---");
    const profDir = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-uiaprof-"));
    const profPath = path.join(profDir, "uia-profile.json");
    const readProfile = () => { try { return JSON.parse(fs.readFileSync(profPath, "utf8")); } catch { return null; } };
    const fixtureEntry = (prof) => prof && Object.values(prof).find((e) => /FastCuaFixture\.exe/i.test(String(e?.app)));

    // Session A: unknown app, hung provider -> hang recorded and persisted.
    const sessA = await startDaemonSession(profDir, "profA");
    try {
      const hung = spawn(FIXTURE, [], {
        env: { ...process.env, FASTCUA_FIXTURE_HANG_MS: "8000" }, stdio: "ignore", windowsHide: true,
      });
      try {
        const hw = await waitForWindow(sessA.client,
          (w) => w.title === "FastCUA Host Test Fixture", "hung fixture (profile A)");
        const ra = await timed("profile A hung state", sessA.client.request("get_window_state", {
          window: hw, include_screenshot: false, include_text: true,
        }));
        check("profile A: hung provider times out with vision preference", !ra.error && ra.value?.uia?.prefer_vision === true,
          `${ra.ms}ms reason=${ra.value?.uia?.reason}${ra.error ? " " + ra.error.message : ""}`);
        await sleep(1_400); // profile save debounce (1s) + margin
        const entryA = fixtureEntry(readProfile());
        check("profile A: hang persisted to uia-profile.json", entryA && entryA.hangs >= 1,
          entryA ? `hangs=${entryA.hangs} quality=${entryA.last_quality}` : "file=" + JSON.stringify(readProfile()).slice(0, 200));
      } finally {
        try { hung.kill("SIGTERM"); } catch {}
        taskkillImage("FastCuaFixture.exe");
      }
    } finally {
      await stopDaemonSession(sessA);
    }

    // Session B: known-bad prior -> first probe of the session is SHORT, not 1500ms.
    const sessB = await startDaemonSession(profDir, "profB");
    try {
      const hung = spawn(FIXTURE, [], {
        env: { ...process.env, FASTCUA_FIXTURE_HANG_MS: "8000" }, stdio: "ignore", windowsHide: true,
      });
      try {
        const hw = await waitForWindow(sessB.client,
          (w) => w.title === "FastCUA Host Test Fixture", "hung fixture (profile B)");
        const rb = await timed("profile B first state", sessB.client.request("get_window_state", {
          window: hw, include_screenshot: false, include_text: true,
        }));
        check("profile B: known-bad app fails fast on the short prior probe",
          !rb.error && rb.ms < 6_000 && rb.value?.uia?.probe_ms === 300 && rb.value?.uia?.prefer_vision === true,
          `${rb.ms}ms probe_ms=${rb.value?.uia?.probe_ms} reason=${rb.value?.uia?.reason}${rb.error ? " " + rb.error.message : ""}`);
        await sleep(1_400);
        const entryB = fixtureEntry(readProfile());
        check("profile B: second hang accumulates", entryB && entryB.hangs >= 2,
          entryB ? `hangs=${entryB.hangs}` : "no entry");
      } finally {
        try { hung.kill("SIGTERM"); } catch {}
        taskkillImage("FastCuaFixture.exe");
      }
    } finally {
      await stopDaemonSession(sessB);
    }

    // Session C: healthy provider -> live success rehabilitates the app.
    const sessC = await startDaemonSession(profDir, "profC");
    try {
      let rc = await timed("profile C launch fixture", sessC.client.request("launch_app", { app: FIXTURE }));
      check("profile C fixture launches", !rc.error, `${rc.ms}ms`);
      const cw = await waitForWindow(sessC.client,
        (w) => w.title === "FastCUA Host Test Fixture", "fixture (profile C)");
      rc = await timed("profile C first state", sessC.client.request("get_window_state", {
        window: cw, include_screenshot: false, include_text: true,
      }));
      check("profile C: first request used the short prior probe", !rc.error && rc.value?.uia?.probe_ms === 300,
        `${rc.ms}ms probe_ms=${rc.value?.uia?.probe_ms}${rc.error ? " " + rc.error.message : ""}`);
      check("profile C: healthy provider answers inside the short probe",
        (rc.value?.accessibility?.tree || "").includes("Increment Button"),
        `quality=${rc.value?.uia?.quality}`);
      await sleep(1_400);
      const entryC = fixtureEntry(readProfile());
      check("profile C: live success rehabilitates the app", entryC && entryC.hangs === 0 && entryC.obs >= 1,
        entryC ? `hangs=${entryC.hangs} obs=${entryC.obs} quality=${entryC.last_quality}` : "no entry");
    } finally {
      await stopDaemonSession(sessC);
      taskkillImage("FastCuaFixture.exe");
    }

    // ---------- latency summary ----------
    const failed = results.filter((entry) => !entry.ok);
    log(`=== ${results.length - failed.length}/${results.length} validation checks passed ===`);
    if (failed.length) throw new Error("validation failures: " + failed.map((f) => f.name).join("; "));
    client.close();
    await apiJson(base, "/api/action", { action: "shutdown" });
    await Promise.race([daemonExit, sleep(3_000)]);
    log("daemon shut down cleanly; log:", LOG_PATH);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  log("FATAL", error.stack || error.message);
  log("=== validation FAILED ===");
  process.exitCode = 1;
});
