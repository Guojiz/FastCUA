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
const PIPE = process.env.FASTCUA_PIPE || "\\\\.\\pipe\\fastcua";
// Meta keys spoken to the helper over its own stdio protocol.
const APPROVED_KEY = "x-oai-cua-approved-app";
const BUDGET_KEY = "x-oai-cua-request-budget-ms";

// Resolve the helper binary (NOT bundled). Precedence: config.cuaBinPath > env
// CUA_BIN > auto-discover under common install locations. Returns null if not
// found so callers surface a clear error instead of crashing.
function discoverCuaBin() {
  const localCandidates = [
    path.join(HERE, "native-host", "target", "release", "cua-native-host.exe"),
    path.join(HERE, "helper", "cua-native-host.exe"),
  ];
  for (const candidate of localCandidates) if (fs.existsSync(candidate)) return candidate;
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
// Agent-facing control-plane strings (prompt engineering):
// - Lead with a stable [control_plane:…] tag so models can branch without fuzzy matching.
// - BLOCK vs INSTRUCTION must never be ambiguous.
// - Prefer explicit "do not" recovery bans over soft "please wait" wording.
// - Only interjection is an INSTRUCTION; pause / approval / stop / shutdown are not tasks.
const ESC_MSG = "[control_plane:stopped] Computer Use was stopped by the user. This is not a new task. End Computer Use for this turn: do not call further Computer Use tools, do not retry, do not fall back to other desktop automation. Send a short final note that the user stopped Computer Use.";
const PAUSE_BLOCK_MSG = "[control_plane:paused] Computer use is paused by the user. This is a BLOCK, not a task instruction. Do not call Computer Use tools, do not retry, do not poll, and do not invent recovery steps. Wait until the user resumes control or sends a new chat message.";
const SHUTDOWN_MSG = "[control_plane:shutdown] FastCUA was shut down by the user. This is final for this turn. Do not restart FastCUA, reconnect the daemon, re-launch the helper, re-run install, or continue desktop automation. Wait for the user.";
const APPROVAL_BLOCK_MSG = "[control_plane:awaiting_approval] Computer use is waiting for a human approval decision. This is a BLOCK, not a task instruction. Do not retry the blocked call in a loop.";
function interjectMsg(text) {
  const safe = String(text).replace(/"/g, "'").slice(0, 2000);
  return `[control_plane:interjection] User instruction: "${safe}". Stop other desktop work and follow ONLY this instruction. Control is already paused; do not resume desktop actions until the user resumes or sends a further chat message.`;
}
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
const CONFIG_PATH = process.env.FASTCUA_CONFIG_PATH || path.join(HERE, "config.json");
const DEFAULT_CONFIG = { costartMode: "claude", idleTimeoutMin: 5, approvalPolicy: "safe", whitelist: ["mspaint.exe", "shell:AppsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App", "notepad.exe", "explorer.exe"], port: 8420, bannerEnabled: false, overlayEnabled: true, overlayTitle: "FastCUA is using your computer", overlayLanguage: "auto", cuaBinPath: "" };
const APPROVAL_WAIT_MS = 60_000;
const pendingApprovals = new Map();
let isUserPaused = false;
function canonicalApp(value) { return String(value || "").replace(/\//g, "\\").toLowerCase(); }
function isWhitelisted(appId) {
  const app = canonicalApp(appId), basename = app.slice(app.lastIndexOf("\\") + 1);
  return (config.whitelist || []).some((entry) => {
    const candidate = canonicalApp(entry).trim();
    return candidate && (candidate.includes("\\") ? app === candidate : basename === candidate);
  });
}
function approvalView(token, approval) { return { token, app: approval.app, action: approval.method, summary: approval.summary, createdAt: approval.createdAt }; }
function rejectPendingApproval(token, reason) {
  const approval = pendingApprovals.get(token);
  if (!approval) return false;
  pendingApprovals.delete(token); clearTimeout(approval.timer);
  approval.entry.reject(new Error(reason));
  emitEvent("approval_denied", { action: approval.method, summary: approval.summary, error: reason });
  return true;
}
function resolvePendingApproval(token, decision) {
  const approval = pendingApprovals.get(token);
  if (!approval) throw new Error("approval request is no longer pending");
  pendingApprovals.delete(token); clearTimeout(approval.timer);
  if (decision === "deny") { approval.entry.reject(new Error("Desktop action denied by user")); emitEvent("approval_denied", { action: approval.method, summary: approval.summary }); return; }
  if (decision === "allow_and_whitelist") {
    const basename = approval.app.slice(Math.max(approval.app.lastIndexOf("\\"), approval.app.lastIndexOf("/")) + 1);
    if (basename && !isWhitelisted(approval.app)) { config = { ...config, whitelist: [...(config.whitelist || []), basename] }; saveConfig(config); }
  }
  if (decision === "full_access") {
    // Switch control plane to full access (no further per-app prompts) and allow this request.
    if (config.approvalPolicy !== "full") {
      config = { ...config, approvalPolicy: "full" };
      saveConfig(config);
      emitEvent("policy", { approvalPolicy: "full" });
      log("approval: switched to FULL ACCESS from approval island");
    }
    // Allow any other pending prompts as well — full access means no more waiting.
    for (const [otherToken, other] of [...pendingApprovals.entries()]) {
      if (otherToken === token) continue;
      pendingApprovals.delete(otherToken);
      clearTimeout(other.timer);
      if (other.app) approvedApps.add(other.app);
      emitEvent("approval_allowed", { action: other.method, summary: other.summary, app: other.app, decision: "full_access" });
      sendToBinary(other.entry.method, other.entry.params, other.entry.meta, { [APPROVED_KEY]: other.app })
        .then(other.entry.resolve, other.entry.reject);
    }
  }
  if (approval.app) approvedApps.add(approval.app);
  emitEvent("approval_allowed", { action: approval.method, summary: approval.summary, app: approval.app, decision });
  sendToBinary(approval.entry.method, approval.entry.params, approval.entry.meta, { [APPROVED_KEY]: approval.app })
    .then(approval.entry.resolve, approval.entry.reject);
}
function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const costartMode = ["claude", "login", "manual"].includes(source.costartMode) ? source.costartMode : DEFAULT_CONFIG.costartMode;
  const requestedPolicy = ["whitelist", "prompt", "auto"].includes(source.approvalPolicy) ? "safe" : source.approvalPolicy;
  const approvalPolicy = ["safe", "full"].includes(requestedPolicy) ? requestedPolicy : DEFAULT_CONFIG.approvalPolicy;
  const idle = Number(source.idleTimeoutMin);
  const port = Number(source.port);
  const whitelist = Array.isArray(source.whitelist)
    ? [...new Set(source.whitelist.map(entry => String(entry).trim()).filter(Boolean))].slice(0, 100)
    : [...DEFAULT_CONFIG.whitelist];
  return {
    costartMode,
    idleTimeoutMin: Number.isFinite(idle) ? Math.min(120, Math.max(0, idle)) : DEFAULT_CONFIG.idleTimeoutMin,
    approvalPolicy,
    whitelist,
    port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_CONFIG.port,
    bannerEnabled: source.bannerEnabled === true,
    overlayEnabled: source.overlayEnabled !== false,
    overlayTitle: typeof source.overlayTitle === "string" ? source.overlayTitle.slice(0, 100) : DEFAULT_CONFIG.overlayTitle,
    overlayLanguage: ["auto", "en", "zh"].includes(source.overlayLanguage) ? source.overlayLanguage : DEFAULT_CONFIG.overlayLanguage,
    cuaBinPath: typeof source.cuaBinPath === "string" ? source.cuaBinPath.slice(0, 4096) : "",
  };
}
function loadConfig() { try { return normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) }); } catch { return { ...DEFAULT_CONFIG }; } }
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalizeConfig(c), null, 2) + "\n"); }
let config = loadConfig();
if (process.env.FASTCUA_HTTP_PORT) {
  config = normalizeConfig({ ...config, port: Number(process.env.FASTCUA_HTTP_PORT) });
}
function idleMs() { const m = config.idleTimeoutMin; return m > 0 ? m * 60 * 1000 : 0; }

// ---- binary ownership ----
let proc = null;
let nextBinId = 1;
const pendingBin = new Map(); // binId -> {resolve, reject, timer, method, params, meta, clientId}
const approvedApps = new Set(); // cached across all clients
function isApproved(app) { const target = canonicalApp(app); return [...approvedApps].some(value => canonicalApp(value) === target); }
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
    const inWhitelist = appId && isWhitelisted(appId);
    if (inWhitelist || config.approvalPolicy === "full") {
      if (appId) approvedApps.add(appId);
      log("approval for", appId, inWhitelist ? "-> WHITELIST" : "-> FULL ACCESS");
      try { p.resolve(await sendToBinary(p.method, p.params, p.meta, { [APPROVED_KEY]: appId })); } catch (e) { p.reject(e); }
      return;
    }
    const token = crypto.randomUUID();
    const approval = { app: appId, method: p.method, summary: actionSummary(p.method, p.params), createdAt: Date.now(), entry: p, timer: null };
    approval.timer = setTimeout(() => rejectPendingApproval(token, "Desktop approval timed out"), APPROVAL_WAIT_MS);
    pendingApprovals.set(token, approval);
    emitEvent("approval_required", { action: p.method, summary: approval.summary, app: appId, token });
    log("approval for", appId, "-> waiting for user decision");
    return;
  }
  pendingBin.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else if (msg.error) p.reject(new Error(typeof msg.error === "string" ? msg.error : msg.error.message || "helper error"));
  else p.reject(new Error("unexpected helper response"));
}

function killProcessTree(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 }); } catch {}
}
function resetBinary(reason = "helper reset") {
  const p = proc; proc = null;
  for (const e of pendingBin.values()) { clearTimeout(e.timer); e.reject(new Error(reason)); }
  pendingBin.clear();
  for (const token of [...pendingApprovals.keys()]) rejectPendingApproval(token, reason);
  try { if (p) killProcessTree(p.pid); } catch {}
}

// ---- per-client state + named-pipe server ----
const clients = new Map(); // socket -> {sessionId, turnId, buf}
let idleTimer = null;

function interruptFilePath(sessionId, turnId) {
  return path.join(CUA_CACHE_DIR, "cache", "computer-use", "interrupts", B(sessionId), B(String(turnId)));
}
function latchInterrupt(c) {
  if (c.interrupted) return true;
  const f = interruptFilePath(c.sessionId, c.turnId);
  if (fs.existsSync(f)) {
    c.interrupted = true;
    c.interruptMessage = c.interjection
      ? interjectMsg(c.interjection)
      : ESC_MSG;
    return true;
  }
  return false;
}
function clearClientInterrupt(c) {
  const f = interruptFilePath(c.sessionId, c.turnId);
  try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  c.interrupted = false;
  c.interruptMessage = null;
  c.interjection = null;
}

/**
 * Interrupt every connected client and reject in-flight helper work.
 * When pause=true (interjection path), also enter paused_by_user so the
 * control plane blocks further desktop actions until the user resumes.
 */
/**
 * Abort in-flight helper work without latching interrupt markers on clients.
 * Used by plain Pause: agent should not receive an "instruction" prompt—only a block
 * if/when their in-flight call is cancelled or they try another desktop tool.
 */
function abortInFlightWithoutAgentPrompt(reason = PAUSE_BLOCK_MSG) {
  currentAction = null;
  const p = proc;
  proc = null;
  for (const e of pendingBin.values()) {
    clearTimeout(e.timer);
    e.reject(new Error(reason));
  }
  pendingBin.clear();
  // Keep pendingApprovals: pause is not a deny. User may still decide on the approval island.
  try { if (p) killProcessTree(p.pid); } catch {}
}

function applyStopAll({ pause = false } = {}) {
  const interjection = pendingInterjection;
  // Only interjection text is a real agent-facing instruction. Plain stop uses ESC_MSG.
  const msg = interjection ? interjectMsg(interjection) : ESC_MSG;
  pendingInterjection = null;
  for (const [, c] of clients) {
    c.interjection = interjection;
    c.interrupted = true;
    c.interruptMessage = msg;
    const f = interruptFilePath(c.sessionId, c.turnId);
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ""); } catch {}
  }
  resetBinary(msg);
  currentAction = null;
  if (pause) {
    isUserPaused = true;
    emitEvent("paused", { client: "user", reason: interjection ? "interjection" : "stop" });
  }
  emitEvent("interrupt", { client: "stop", paused: Boolean(pause) });
  log(
    "action: stopAll — interrupted",
    clients.size,
    "clients",
    pause ? "(paused_by_user)" : "(running latch only)",
    interjection ? `interjection="${String(interjection).slice(0, 60)}"` : ""
  );
}

function makeClient(socket) {
  const c = { sessionId: crypto.randomUUID(), turnId: 1, buf: "", socket, interjection: null, interrupted: false, interruptMessage: null };
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
  if (c) clearClientInterrupt(c);
  clients.delete(socket);
  log("client gone (", clients.size, "left)");
  if (clients.size === 0) {
    const ms = idleMs();
    if (ms > 0) {
      idleTimer = setTimeout(() => {
        log("idle for", ms / 1000, "s — shutting down helper + daemon");
        resetBinary();
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
  if (method === "close") {
    clearClientInterrupt(c);
    c.turnId++;
    closeClientAfterReply(c, id, { result: { ok: true } });
    return;
  }
  if (isUserPaused) { reply(c, id, { error: PAUSE_BLOCK_MSG }); return; }
  if (pendingApprovals.size) { reply(c, id, { error: APPROVAL_BLOCK_MSG }); return; }
  if (latchInterrupt(c)) {
    const msg = c.interruptMessage || ESC_MSG;
    emitEvent("interrupt", { client: c.sessionId.slice(0,8) });
    reply(c, id, { error: msg });
    return;
  }
  const meta = { session_id: c.sessionId, turn_id: String(c.turnId) };
  const app = params?.window?.app || params?.app;
  if (app && isApproved(app)) meta[APPROVED_KEY] = app;
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
function closeClientAfterReply(c, id, obj) {
  const payload = JSON.stringify({ id, ...obj }) + "\n";
  c.socket.end(payload, (e) => {
    if (e) log("close reply write ERROR id=", id, ":", e.message);
    else log("client closed its computer-use turn");
  });
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
function trustedMutationOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
      && parsed.port === String(config.port);
  } catch {
    return false;
  }
}
const httpServer = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "POST" && !trustedMutationOrigin(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "untrusted request origin" }));
      return;
    }
    if (u.pathname === "/" || u.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(WEB); return;
    }
    if (u.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clients: clients.size, binaryPid: proc?.pid || null, approvedApps: [...approvedApps], pendingApprovals: [...pendingApprovals.entries()].map(([token, approval]) => approvalView(token, approval)), approvalPolicy: config.approvalPolicy, controlState: isUserPaused ? "paused_by_user" : pendingApprovals.size ? "awaiting_approval" : "running", uptime: fmtUptime(), recentLogs }));
      return;
    }
    if (u.pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(config)); return;
    }
    if (u.pathname === "/api/config" && req.method === "POST") {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        try {
          if (Buffer.byteLength(body) > 64 * 1024) throw new Error("config payload too large");
          const next = normalizeConfig({ ...config, ...JSON.parse(body) });
          const costartChanged = next.costartMode !== config.costartMode;
          const approvalChanged = next.approvalPolicy !== config.approvalPolicy || JSON.stringify(next.whitelist) !== JSON.stringify(config.whitelist);
          config = next;
          saveConfig(config);
          if (approvalChanged) approvedApps.clear();
          if (costartChanged) applyCostart(config.costartMode);
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(config));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }
    if (u.pathname === "/api/events" && req.method === "GET") {
      const since = parseInt(u.searchParams.get("since") || "0", 10);
      const evts = events.filter(e => e.id > since);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events: evts, inflight: currentAction, pendingApprovals: [...pendingApprovals.entries()].map(([token, approval]) => approvalView(token, approval)), approvalPolicy: config.approvalPolicy, controlState: isUserPaused ? "paused_by_user" : pendingApprovals.size ? "awaiting_approval" : "running" }));
      return;
    }
    if (u.pathname === "/api/action" && req.method === "POST") {
      let body = ""; req.on("data", d => body += d); req.on("end", async () => {
        try {
          if (Buffer.byteLength(body) > 16 * 1024) throw new Error("action payload too large");
          const { action, token } = JSON.parse(body);
          if (action === "killBinary") { resetBinary(); log("action: binary killed"); }
          else if (action === "clearApprovals") { approvedApps.clear(); log("action: approvals cleared"); }
          else if (action === "pause") {
            isUserPaused = true;
            // Abort in-flight desktop work, but do NOT latch interrupt prompts on clients.
            // Agent only sees PAUSE_BLOCK_MSG if a call is cancelled or they try again.
            abortInFlightWithoutAgentPrompt(PAUSE_BLOCK_MSG);
            emitEvent("paused", { client: "user" });
            log("action: user paused desktop control (block only — no agent prompt)");
          }
          else if (action === "resume") { isUserPaused = false; emitEvent("resumed", { client: "user" }); log("action: user resumed desktop control"); }
          else if (action === "allowOnce" || action === "allowAndWhitelist" || action === "alwaysApprove" || action === "fullAccess" || action === "denyApproval") {
            // alwaysApprove = whitelist this app; fullAccess = set approvalPolicy to full + allow.
            const decision = (action === "allowAndWhitelist" || action === "alwaysApprove")
              ? "allow_and_whitelist"
              : action === "fullAccess" ? "full_access"
              : action === "allowOnce" ? "allow_once" : "deny";
            await resolvePendingApproval(token, decision);
          }
          else if (action === "restart") { log("action: restarting daemon"); resetBinary(); if (overlayProc) { try { overlayProc.kill(); } catch {} } setTimeout(() => process.exit(0), 200); }
          else if (action === "shutdown") {
            isUserPaused = true;
            for (const [, client] of clients) {
              client.interrupted = true;
              client.interruptMessage = SHUTDOWN_MSG;
              const marker = interruptFilePath(client.sessionId, client.turnId);
              try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, ""); } catch {}
            }
            resetBinary(SHUTDOWN_MSG);
            currentAction = null;
            emitEvent("shutdown", { client: "user" });
            log("action: shutdown — releasing helper, overlay, pipe, and HTTP server");
            setTimeout(() => {
              resetBinary();
              if (overlayProc) { try { overlayProc.kill(); } catch {} }
              try { server.close(); } catch {}
              try { httpServer.close(); } catch {}
              process.exit(0);
            }, 250);
          }
          else if (action === "stopAll") {
            applyStopAll({ pause: Boolean(pendingInterjection) });
          } else {
            throw new Error("unknown action");
          }
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }
    if (u.pathname === "/api/interject" && req.method === "POST") {
      let body = ""; req.on("data", d => body += d); req.on("end", () => {
        try {
          if (Buffer.byteLength(body) > 16 * 1024) throw new Error("interjection payload too large");
          const parsed = JSON.parse(body);
          const text = typeof parsed.text === "string" ? parsed.text.trim().slice(0, 2000) : "";
          if (!text) throw new Error("interjection text is required");
          // Atomic: queue text, interrupt in-flight work, AND enter paused_by_user so
          // the island/console show Pause state and further desktop actions require Resume.
          // Overlay still may call stopAll afterward; applyStopAll is idempotent.
          pendingInterjection = text;
          applyStopAll({ pause: true });
          log("interjection applied + paused:", text.slice(0, 80));
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, paused: true }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message }));
        }
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
  if (!config.overlayEnabled || process.env.FASTCUA_DISABLE_OVERLAY === "1") return;
  const overlayPath = path.join(HERE, "overlay.ps1");
  if (!fs.existsSync(overlayPath)) { log("overlay.ps1 not found, skipping launch"); return; }
  const logPath = path.join(HERE, "overlay.log");
  try {
    const errFd = fs.openSync(logPath, "w");
    overlayProc = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", overlayPath,
      "-Port", String(config.port),
      "-Title", config.overlayTitle || "FastCUA",
      "-Language", config.overlayLanguage || "auto"
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
server.on("error", (e) => { log("pipe server error:", e.message); resetBinary(); if (overlayProc) { try { overlayProc.kill(); } catch {} } process.exit(1); });
server.listen(PIPE, () => log("listening on", PIPE));

process.on("SIGINT", () => { resetBinary(); if (overlayProc) try { overlayProc.kill(); } catch {}; process.exit(0); });
process.on("SIGTERM", () => { resetBinary(); if (overlayProc) try { overlayProc.kill(); } catch {}; process.exit(0); });
process.on("SIGBREAK", () => { resetBinary(); if (overlayProc) try { overlayProc.kill(); } catch {}; process.exit(0); });
log("fastcua daemon ready (one shared helper, pipe:", PIPE + ")");
