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
