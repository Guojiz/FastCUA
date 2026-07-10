// Standalone resident computer-use daemon.
//
// Drives a native computer-use helper binary as a subprocess via its stdio JSON
// protocol. Does NOT include or redistribute any helper binary — it is a
// runtime dependency provided by the user's system.
//
// Owns ONE helper subprocess (one cursor, shared across all clients), hosts a
// named pipe for MCP-server clients, centralizes app approval (cached across
// clients), turn metadata + Esc interrupt (per client), overlay lifecycle
// (idle-shutdown). Persistent-helper-shared-by-clients model (no per-process
// spawn).
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => { const s = "[fastcua] " + a.join(" "); process.stderr.write(s + "\n"); recentLogs.push(s); if (recentLogs.length > 100) recentLogs.shift(); };

// Data directory for the helper subprocess (passed via env to the native binary).
const CUA_CACHE_DIR = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const PIPE = "\\\\.\\pipe\\fastcua";
// Meta keys spoken to the helper over its own stdio protocol.
const APPROVED_KEY = "x-oai-cua-approved-app";
const BUDGET_KEY = "x-oai-cua-request-budget-ms";

// Resolve the helper binary (NOT bundled). Precedence: config.cuaBinPath > env
// CUA_BIN > auto-discover under common install locations. Returns null if not
// found so callers surface a clear error instead of crashing.
function discoverCuaBin() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const runtimesDir = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
  let entries;
  try { entries = fs.readdirSync(runtimesDir); } catch { return null; }
  for (const entry of entries) {
    const cand = path.join(runtimesDir, entry, "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}
function resolveCuaBin() {
  if (config.cuaBinPath && fs.existsSync(config.cuaBinPath)) return config.cuaBinPath;
  if (process.env.CUA_BIN && fs.existsSync(process.env.CUA_BIN)) return process.env.CUA_BIN;
  return discoverCuaBin();
}
const TIMEOUT_MS = 30000;
const ESC_MSG = "Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use.";
const B = (t) => String(t).replace(/[^A-Za-z0-9._-]/g, "_");
const recentLogs = [];
const events = []; // structured events for overlay [{id,ts,type,action,client,duration_ms,summary}]
let nextEventId = 1;
const startedAt = Date.now();
let currentAction = null; // in-flight: {action, summary, startedAt, client}
let pendingInterjection = null; // text from overlay interjection input
function emitEvent(type, data) {
  const e = { id: nextEventId++, ts: Date.now(), type, ...data };
  events.push(e);
  if (events.length > 200) events.shift();
}
function actionSummary(method, params) {
  if (!params) return "";
  if (params.window) {
    const app = params.window.app || "?";
    const short = app.includes("\\") ? app.split("\\").pop() : app;
    if (method === "click") return `${short} · click(${params.element_index ?? (params.x+','+params.y)})`;
    if (method === "drag") return `${short} · drag(${params.from_x},${params.from_y})→(${params.to_x},${params.to_y})`;
    if (method === "type_text") return `${short} · type "${params.text?.slice(0,20)||''}"`;
    if (method === "press_key") return `${short} · press ${params.key}`;
    if (method === "scroll") return `${short} · scroll(${params.scrollX||0},${params.scrollY||0})`;
    if (method === "set_value") return `${short} · set[${params.element_index}]="${params.value?.slice(0,20)||''}"`;
    return `${short} · ${method}`;
  }
  if (method === "list_apps") return "列出应用";
  if (method === "launch_app") return `启动 ${params.app?.split("\\").pop()||params.app}`;
  if (method === "get_window_state") return `截图 ${(params.window?.app||"").split("\\").pop()||"?"}`;
  return method;
}

// ---- config (web UI editable) ----
const CONFIG_PATH = path.join(HERE, "config.json");
const DEFAULT_CONFIG = { costartMode: "claude", idleTimeoutMin: 5, approvalPolicy: "auto", whitelist: ["mspaint.exe", "notepad.exe", "explorer.exe"], port: 8420, bannerEnabled: false, overlayEnabled: true, overlayTitle: "FastCUA · using your computer", cuaBinPath: "" };
function loadConfig() { try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) }; } catch { return { ...DEFAULT_CONFIG }; } }
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n"); }
let config = loadConfig();
function idleMs() { const m = config.idleTimeoutMin; return m > 0 ? m * 60 * 1000 : 0; }

// ---- binary ownership ----
let proc = null;
let nextBinId = 1;
const pendingBin = new Map(); // binId -> {resolve, reject, timer, method, params, meta, clientId}
const approvedApps = new Set(); // cached across all clients
let binBuf = "";

function startBinary() {
  if (proc && proc.exitCode == null && proc.signalCode == null) return;
  const bin = resolveCuaBin();
  if (!bin) {
    log("helper not found — set cuaBinPath in config or CUA_BIN env to the helper binary path");
    return;
  }
  proc = spawn(bin, ["--parent-pid", String(process.pid)], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, CODEX_HOME: CUA_CACHE_DIR },
  });
  binBuf = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", onBinaryData);
  proc.stderr.on("data", (d) => process.stderr.write("[bin] " + d));
  proc.on("exit", (code, sig) => {
    log("helper exited code=", code, "sig=", sig);
    proc = null;
    for (const e of pendingBin.values()) { clearTimeout(e.timer); e.reject(new Error("helper exited")); }
    pendingBin.clear();
  });
  log("helper spawned (one shared binary) at", bin);
}

function onBinaryData(chunk) {
  binBuf += chunk;
  let i;
  while ((i = binBuf.indexOf("\n")) >= 0) {
    const line = binBuf.slice(0, i).trim();
    binBuf = binBuf.slice(i + 1);
    if (line) { try { handleBinaryMessage(JSON.parse(line)); } catch (e) { log("bad binary json:", line.slice(0, 200)); } }
  }
}
function sendToBinary(method, params, meta, extraMeta) {
  return new Promise((resolve, reject) => {
    startBinary();
    if (!proc) { reject(new Error("helper binary not available (set cuaBinPath in config or CUA_BIN env)")); return; }
    const id = nextBinId++;
    const fullMeta = { ...meta, ...extraMeta, [BUDGET_KEY]: TIMEOUT_MS };
    const payload = JSON.stringify({ id, method, params, meta: fullMeta });
    const entry = { resolve, reject, method, params, meta, timer: null };
    entry.timer = setTimeout(() => {
      pendingBin.delete(id);
      reject(new Error("computer-use request timed out: " + method));
      resetBinary(); // wedged helper blocks all clients; reset so everyone recovers
    }, TIMEOUT_MS);
    pendingBin.set(id, entry);
    proc.stdin.write(payload + "\n", (e) => { if (e) { clearTimeout(entry.timer); pendingBin.delete(id); reject(e); } });
  });
}

async function handleBinaryMessage(msg) {
  if (typeof msg.id !== "number") return;
  const p = pendingBin.get(msg.id);
  if (!p) return;
  if (msg.approvalRequest) {
    pendingBin.delete(msg.id);
    clearTimeout(p.timer);
    const appId = typeof msg.approvalRequest.app === "string" ? msg.approvalRequest.app.trim() : "";
    const wl = config.whitelist || [];
    const inWhitelist = appId && wl.some(w => w && (appId.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(appId.toLowerCase())));
    if (config.approvalPolicy === "whitelist" && !inWhitelist) {
      log("approval for", appId, "-> DENIED (not in whitelist)");
      p.reject(new Error("App not in whitelist: " + appId));
      return;
    }
    if (appId) approvedApps.add(appId); // cache so other clients skip the dance
    log("approval for", appId, "-> auto-approve (cached)");
    try { const r = await sendToBinary(p.method, p.params, p.meta, { [APPROVED_KEY]: appId }); p.resolve(r); }
    catch (e) { p.reject(e); }
    return;
  }
  pendingBin.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else if (msg.error) p.reject(new Error(typeof msg.error === "string" ? msg.error : msg.error.message || "helper error"));
  else p.reject(new Error("unexpected helper response"));
}

function resetBinary() {
  const p = proc; proc = null;
  for (const e of pendingBin.values()) { clearTimeout(e.timer); e.reject(new Error("helper reset")); }
  pendingBin.clear();
  try { p && p.kill(); } catch {}
}

// ---- per-client state + named-pipe server ----
const clients = new Map(); // socket -> {sessionId, turnId, buf}
let idleTimer = null;

function interruptFilePath(sessionId, turnId) {
  return path.join(CUA_CACHE_DIR, "cache", "computer-use", "interrupts", B(sessionId), B(String(turnId)));
}
function checkInterrupt(c) {
  const f = interruptFilePath(c.sessionId, c.turnId);
  if (fs.existsSync(f)) {
    try { fs.unlinkSync(f); } catch {}
    return true;
  }
  return false;
}

function makeClient(socket) {
  const c = { sessionId: crypto.randomUUID(), turnId: 1, buf: "", socket };
  clients.set(socket, c);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  socket.setEncoding("utf8");
  socket.on("data", (d) => onClientData(c, d));
  socket.on("end", () => onClientGone(socket));
  socket.on("error", () => onClientGone(socket));
  log("client connected (", clients.size, "active) session=", c.sessionId);
}
function onClientGone(socket) {
  const c = clients.get(socket);
  clients.delete(socket);
  log("client gone (", clients.size, "left)");
  if (clients.size === 0) {
    const ms = idleMs();
    if (ms > 0) {
      idleTimer = setTimeout(() => {
        log("idle for", ms / 1000, "s — shutting down helper + daemon");
        if (proc) { try { proc.kill(); } catch {} }
        if (overlayProc) { try { overlayProc.kill(); } catch {} }
        process.exit(0);
      }, ms);
    }
  }
}

function onClientData(c, chunk) {
  c.buf += chunk;
  let i;
  while ((i = c.buf.indexOf("\n")) >= 0) {
    const line = c.buf.slice(0, i).trim();
    c.buf = c.buf.slice(i + 1);
    if (line) { try { handleClientReq(c, JSON.parse(line)); } catch (e) { log("bad client json:", line.slice(0, 200)); } }
  }
}

async function handleClientReq(c, req) {
  const { id, method, params } = req;
  if (method === "end_turn") { c.turnId++; reply(c, id, { result: { ok: true } }); return; }
  if (method === "close") { reply(c, id, { result: { ok: true } }); return; }
  if (checkInterrupt(c)) {
    const msg = pendingInterjection
      ? `User interjected: "${pendingInterjection}". Stop current work and respond to this instruction.`
      : ESC_MSG;
    pendingInterjection = null;
    emitEvent("interrupt", { client: c.sessionId.slice(0,8) });
    reply(c, id, { error: msg });
    return;
  }
  const meta = { session_id: c.sessionId, turn_id: String(c.turnId) };
  const app = params?.window?.app || params?.app;
  if (app && approvedApps.has(app)) meta[APPROVED_KEY] = app;
  const t0 = Date.now();
  const summary = actionSummary(method, params);
  currentAction = { action: method, summary, startedAt: t0, client: c.sessionId.slice(0,8) };
  emitEvent("action_start", { client: c.sessionId.slice(0,8), action: method, summary });
  try {
    const result = await sendToBinary(method, params, meta, {});
    const dur = Date.now() - t0;
    currentAction = null;
    emitEvent("action_end", { client: c.sessionId.slice(0,8), action: method, duration_ms: dur, summary, ok: true });
    reply(c, id, { result });
  } catch (e) {
    currentAction = null;
    const dur = Date.now() - t0;
    emitEvent("action_end", { client: c.sessionId.slice(0,8), action: method, duration_ms: dur, summary, ok: false, error: e.message });
    reply(c, id, { error: e.message });
  }
}
function reply(c, id, obj) {
  const payload = JSON.stringify({ id, ...obj }) + "\n";
  c.socket.write(payload, (e) => { if (e) log("reply write ERROR id=", id, ":", e.message); });
}

// ---- co-start (Windows login auto-start via HKCU Run key) ----
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VAL = "FastCUA";
function applyCostart(mode) {
  const cmd = `"${process.execPath}" "${path.join(HERE, "daemon.mjs")}"`;
  try {
    if (mode === "login") {
      execFileSync("reg", ["add", RUN_KEY, "/v", RUN_VAL, "/t", "REG_SZ", "/d", cmd, "/f"], { stdio: "ignore" });
      log("co-start: login auto-start ON");
    } else {
      try { execFileSync("reg", ["delete", RUN_KEY, "/v", RUN_VAL, "/f"], { stdio: "ignore" }); } catch {}
      log("co-start:", mode, "(no login entry)");
    }
  } catch (e) { log("co-start reg write failed:", e.message); }
}

// ---- HTTP config UI ----
function fmtUptime() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}
const WEB = fs.readFileSync(path.join(HERE, "web.html"), "utf8");
const httpServer = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(WEB); return;
    }
    if (u.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clients: clients.size, binaryPid: proc?.pid || null, approvedApps: [...approvedApps], uptime: fmtUptime(), recentLogs }));
      return;
    }
    if (u.pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(config)); return;
    }
    if (u.pathname === "/api/config" && req.method === "POST") {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        const next = { ...config, ...JSON.parse(body) };
        const costartChanged = next.costartMode !== config.costartMode;
        config = next; saveConfig(config);
        if (costartChanged) applyCostart(config.costartMode);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(config));
      });
      return;
    }
    if (u.pathname === "/api/events" && req.method === "GET") {
      const since = parseInt(u.searchParams.get("since") || "0", 10);
      const evts = events.filter(e => e.id > since);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events: evts, inflight: currentAction }));
      return;
    }
    if (u.pathname === "/api/action" && req.method === "POST") {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        const { action } = JSON.parse(body);
        if (action === "killBinary") { resetBinary(); log("action: binary killed"); }
        else if (action === "clearApprovals") { approvedApps.clear(); log("action: approvals cleared"); }
        else if (action === "restart") { log("action: restarting daemon"); resetBinary(); if (overlayProc) { try { overlayProc.kill(); } catch {} } setTimeout(() => process.exit(0), 200); }
        else if (action === "stopAll") {
          const msg = pendingInterjection
            ? `User interjected: "${pendingInterjection}". Stop current work and respond to this instruction.`
            : ESC_MSG;
          pendingInterjection = null;
          // Write interrupt file for every active client (future requests too)
          for (const [, c] of clients) {
            const f = interruptFilePath(c.sessionId, c.turnId);
            try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ""); } catch {}
          }
          // Immediately reject any in-flight binary action so the AI gets the message right now
          for (const e of pendingBin.values()) {
            clearTimeout(e.timer);
            e.reject(new Error(msg));
          }
          pendingBin.clear();
          currentAction = null;
          emitEvent("interrupt", { client: "stop" });
          log("action: stopAll — interrupted", clients.size, "clients + rejected", "in-flight actions -> AI resumes");
        }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (u.pathname === "/api/interject" && req.method === "POST") {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        const { text } = JSON.parse(body);
        pendingInterjection = text;
        log("interjection queued:", text.slice(0, 80));
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { res.writeHead(500); res.end("error: " + e.message); }
});
httpServer.on("error", (e) => log("http server error:", e.message));
httpServer.listen(config.port, "127.0.0.1", () => log("config UI: http://127.0.0.1:" + config.port));

// ---- overlay (PowerShell WPF floating banner) ----
let overlayProc = null;
function launchOverlay() {
  if (!config.overlayEnabled) return;
  const overlayPath = path.join(HERE, "overlay.ps1");
  if (!fs.existsSync(overlayPath)) { log("overlay.ps1 not found, skipping launch"); return; }
  const logPath = path.join(HERE, "overlay.log");
  try {
    const errFd = fs.openSync(logPath, "w");
    overlayProc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", overlayPath,
      "-Port", String(config.port),
      "-Title", config.overlayTitle || "FastCUA"
    ], { stdio: ["ignore", "ignore", errFd] });
    overlayProc.unref();
    overlayProc.on("exit", (code) => log("overlay exited code=", code));
    fs.closeSync(errFd);
    log("overlay launched (PowerShell WPF, rainbow border) -> stderr:", logPath);
  } catch (e) { log("overlay launch failed:", e.message); }
}

applyCostart(config.costartMode);
launchOverlay();

// ---- pipe server ----
const server = net.createServer({ allowHalfOpen: false }, makeClient);
server.on("error", (e) => { log("pipe server error:", e.message); process.exit(1); });
server.listen(PIPE, () => log("listening on", PIPE));

process.on("SIGINT", () => { if (proc) try { proc.kill(); } catch {}; if (overlayProc) try { overlayProc.kill(); } catch {}; process.exit(0); });
process.on("SIGTERM", () => { if (proc) try { proc.kill(); } catch {}; if (overlayProc) try { overlayProc.kill(); } catch {}; process.exit(0); });
process.on("SIGBREAK", () => { if (proc) try { proc.kill(); } catch {}; if (overlayProc) try { overlayProc.kill(); } catch {}; process.exit(0); });
log("fastcua daemon ready (one shared helper, pipe:", PIPE + ")");
