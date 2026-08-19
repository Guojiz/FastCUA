// Standalone resident computer-use daemon.
//
// Drives a native computer-use helper binary as a subprocess via its stdio JSON
// protocol. Does NOT include or redistribute any helper binary — it is a
// runtime dependency provided by the user's system.
//
// Owns ONE helper subprocess (one cursor, shared across all clients), hosts a
// named pipe for MCP-server clients, centralizes app approval (cached across
// clients), turn metadata + Esc interrupt (per client), persistent Computer Use
// history recording, and idle-shutdown. Headless: configuration is a local
// config.json file; there is no HTTP UI, console, or overlay. The optional
// control UI lives in the DeepSeek Harness plugin instead.
// Persistent-helper-shared-by-clients model (no per-process spawn).
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  readRuntimeManifest,
  runtimeConfigPath,
  runtimeDataDir,
  runtimeInfo,
  runtimePipe,
  runtimeRootHash,
} from "./lib/runtime.mjs";
import { checkForUpdates } from "./lib/update-check.mjs";
import { HistoryStore, sanitizeParams } from "./lib/history.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_MANIFEST = readRuntimeManifest(HERE);
const RUNTIME_ROOT_HASH = runtimeRootHash(HERE);
const log = (...a) => { const s = "[fastcua] " + a.join(" "); process.stderr.write(s + "\n"); recentLogs.push(s); if (recentLogs.length > 100) recentLogs.shift(); };

// Data directory for the helper subprocess (passed via env to the native binary).
// Keep mutable data outside the runtime and independent from any AI client's home.
const CUA_CACHE_DIR = runtimeDataDir(HERE, RUNTIME_MANIFEST);
const PIPE = runtimePipe(HERE);
fs.mkdirSync(CUA_CACHE_DIR, { recursive: true });
// Meta keys spoken to the helper over its own stdio protocol.
// Prefer FastCUA names; host still accepts legacy x-oai-* aliases.
const APPROVED_KEY = "x-fastcua-approved-app";
const BUDGET_KEY = "x-fastcua-request-budget-ms";
const APPROVED_KEY_LEGACY = "x-oai-cua-approved-app";
const BUDGET_KEY_LEGACY = "x-oai-cua-request-budget-ms";

// Resolve the helper binary (NOT bundled). Precedence: config.cuaBinPath > env
// CUA_BIN > FastCUA install / repo paths. No third-party product binary fallback.
function discoverCuaBin() {
  const localCandidates = [
    path.join(HERE, "native-host", "target", "release", "cua-native-host.exe"),
    path.join(HERE, "helper", "cua-native-host.exe"),
    path.join(HERE, "cua-native-host.exe"),
  ];
  for (const candidate of localCandidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}
function resolveCuaBin() {
  if (config.cuaBinPath && fs.existsSync(config.cuaBinPath)) return config.cuaBinPath;
  if (process.env.CUA_BIN && fs.existsSync(process.env.CUA_BIN)) return process.env.CUA_BIN;
  return discoverCuaBin();
}
// Software action budget: every helper request must finish or fail within 30s (not human approval wait).
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
  // One-shot instruction: agent should continue tools after this message is delivered.
  // Do NOT tell the agent to wait for resume — interject auto-resumes the control plane.
  return `[control_plane:interjection] User instruction: "${safe}". Abort the previous plan and follow ONLY this instruction. You may call Computer Use tools again immediately to carry it out.`;
}
const B = (t) => String(t).replace(/[^A-Za-z0-9._-]/g, "_");
const recentLogs = [];
const events = []; // structured control/activity events [{id,ts,type,action,client,duration_ms,summary}]
let nextEventId = 1;
const startedAt = Date.now();
let currentAction = null; // in-flight: {action, summary, startedAt, client}
let pendingInterjection = null; // text supplied by the host control plane
function emitEvent(type, data) {
  const e = { id: nextEventId++, ts: Date.now(), type, ...data };
  events.push(e);
  if (events.length > 200) events.shift();
  historyRecordEvent(type, data);
}
// Persist control-plane events into the Computer Use history timeline. Desktop
// actions are recorded separately in handleClientReq (with screenshots/params).
function historyRecordEvent(type, data) {
  if (!history.enabled) return;
  if (!["approval_required", "approval_allowed", "approval_denied", "policy", "paused", "resumed", "interjection", "shutdown", "interrupt"].includes(type)) return;
  const app = data?.app || null;
  const summaries = {
    approval_required: () => `approval required: ${app || "unknown app"}${data?.action ? ` · ${data.action}` : ""}`,
    approval_allowed: () => `approval allowed: ${app || "unknown app"}${data?.decision ? ` (${data.decision})` : ""}`,
    approval_denied: () => `approval denied: ${app || "unknown app"}`,
    policy: () => `approval policy: ${data?.approvalPolicy || "changed"}`,
    paused: () => "control paused",
    resumed: () => "control resumed",
    interjection: () => `interjection (${data?.text ? String(data.text).length : 0} chars)`,
    shutdown: () => "fastcua shutdown",
    interrupt: () => `interrupt (client ${data?.client || "?"})`,
  };
  try {
    history.append({
      sessionId: null,
      turnId: null,
      client: data?.client || null,
      app,
      action: `control:${type}`,
      summary: String((summaries[type] || (() => type))()).slice(0, 500),
      params: null,
      ok: type !== "approval_denied",
      durationMs: null,
      error: null,
      screenshots: [],
    });
  } catch (e) {
    log("history append failed (control event):", e.message);
  }
}
function actionSummary(method, params) {
  if (!params) return "";
  if (params.window) {
    const app = params.window.app || "?";
    const short = app.includes("\\") ? app.split("\\").pop() : app;
    if (method === "click") return `${short} · click(${params.element_index ?? (params.x+','+params.y)})`;
    if (method === "drag") return `${short} · drag(${params.from_x},${params.from_y})→(${params.to_x},${params.to_y})`;
    if (method === "type_text") return `${short} · type ${String(params.text || "").length} chars`;
    if (method === "press_key") return `${short} · press ${params.key}`;
    if (method === "scroll") return `${short} · scroll(${params.scrollX||0},${params.scrollY||0})`;
    if (method === "set_value") return `${short} · set[${params.element_index}] ${String(params.value || "").length} chars`;
    return `${short} · ${method}`;
  }
  if (method === "list_apps") return "列出应用";
  if (method === "launch_app") return `启动 ${params.app?.split("\\").pop()||params.app}`;
  if (method === "get_window_state") return `截图 ${(params.window?.app||"").split("\\").pop()||"?"}`;
  return method;
}
// Append one desktop action to the persistent Computer Use history timeline.
function recordActionHistory({ method, params, app, summary, sessionId, turnId, ok, durationMs, error, result }) {
  if (!history.enabled) return;
  try {
    const screenshots = (result && Array.isArray(result.screenshots))
      ? result.screenshots.map((s) => ({ url: s?.url, width: s?.width, height: s?.height }))
      : [];
    history.append({
      sessionId,
      turnId,
      client: sessionId ? sessionId.slice(0, 8) : null,
      app: app ? String(app) : null,
      action: method,
      summary,
      params: sanitizeParams(method, params),
      ok,
      durationMs,
      error: error || null,
      screenshots,
    });
  } catch (e) {
    log("history append failed (action):", e.message);
  }
}

// ---- config (config-file and named-pipe editable) ----
const CONFIG_PATH = runtimeConfigPath(HERE, RUNTIME_MANIFEST);
// Default whitelist: exact basenames / AUMIDs only (no substring match). Common local tools; not browsers/password managers.
const DEFAULT_WHITELIST = [
  "mspaint.exe",
  "shell:AppsFolder\\Microsoft.Paint_8wekyb3d8bbwe!App",
  "notepad.exe",
  "explorer.exe",
  "calc.exe",
  "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
  "write.exe",
  "Code.exe",
];
// Default is FULL ACCESS: no per-app prompts unless the user edits config.json
// and opts back into "safe" (whitelist/prompt) mode.
const DEFAULT_CONFIG = {
  costartMode: "claude",
  idleTimeoutMin: 5,
  approvalPolicy: "full",
  whitelist: [...DEFAULT_WHITELIST],
  checkForUpdates: true,
  cuaBinPath: "",
  historyEnabled: true,
  historyCaptureScreenshots: true,
  historyMaxEntries: 10000,
  historyRetentionDays: 30,
  historyMaxShotsPerAction: 1,
};
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
const VALID_APPROVAL_DECISIONS = ["deny", "allow_once", "allow_and_whitelist", "full_access"];
function resolvePendingApproval(token, decision) {
  if (!VALID_APPROVAL_DECISIONS.includes(decision)) throw new Error("unknown approval decision: " + decision);
  const approval = pendingApprovals.get(token);
  if (!approval) throw new Error("approval request is no longer pending");

  if (decision === "deny") {
    pendingApprovals.delete(token);
    clearTimeout(approval.timer);
    approval.entry.reject(new Error("Desktop action denied by user"));
    emitEvent("approval_denied", { action: approval.method, summary: approval.summary });
    return;
  }

  // Persist any security-policy mutation before changing live state or
  // consuming the approval token. If persistence fails, the request remains
  // pending and the existing in-memory policy remains authoritative.
  let nextConfig = config;
  if (decision === "allow_and_whitelist") {
    const basename = approval.app.slice(Math.max(approval.app.lastIndexOf("\\"), approval.app.lastIndexOf("/")) + 1);
    if (basename && !isWhitelisted(approval.app)) nextConfig = { ...config, whitelist: [...(config.whitelist || []), basename] };
  } else if (decision === "full_access" && config.approvalPolicy !== "full") {
    nextConfig = { ...config, approvalPolicy: "full" };
  }
  if (nextConfig !== config) saveConfig(nextConfig);

  pendingApprovals.delete(token);
  clearTimeout(approval.timer);
  const policyChanged = nextConfig.approvalPolicy !== config.approvalPolicy;
  config = nextConfig;
  if (policyChanged) {
    emitEvent("policy", { approvalPolicy: "full" });
    log("approval: switched to FULL ACCESS from host control plane");
  }

  if (decision === "full_access") {
    // Full access resolves all already-pending prompts, but an active pause
    // still wins and prevents those desktop actions from executing.
    for (const [otherToken, other] of [...pendingApprovals.entries()]) {
      pendingApprovals.delete(otherToken);
      clearTimeout(other.timer);
      if (other.app) approvedApps.add(other.app);
      emitEvent("approval_allowed", { action: other.method, summary: other.summary, app: other.app, decision: "full_access" });
      if (isUserPaused) { other.entry.reject(new Error(PAUSE_BLOCK_MSG)); continue; }
      sendToBinary(other.entry.method, other.entry.params, other.entry.meta, { [APPROVED_KEY]: other.app })
        .then(other.entry.resolve, other.entry.reject);
    }
  }

  // allow_once authorizes only this retry; policy-backed decisions may be
  // cached only after their config mutation has been persisted successfully.
  if (approval.app && decision !== "allow_once") approvedApps.add(approval.app);
  emitEvent("approval_allowed", { action: approval.method, summary: approval.summary, app: approval.app, decision });
  if (isUserPaused) { approval.entry.reject(new Error(PAUSE_BLOCK_MSG)); return; }
  sendToBinary(approval.entry.method, approval.entry.params, approval.entry.meta, { [APPROVED_KEY]: approval.app })
    .then(approval.entry.resolve, approval.entry.reject);
}
function normalizeConfig(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const costartMode = ["claude", "login", "manual"].includes(source.costartMode) ? source.costartMode : DEFAULT_CONFIG.costartMode;
  const requestedPolicy = ["whitelist", "prompt", "auto"].includes(source.approvalPolicy) ? "safe" : source.approvalPolicy;
  // Missing policy uses the product default. A present-but-unknown policy is a
  // semantic config error and must fail closed rather than silently grant full.
  const approvalPolicy = requestedPolicy == null ? DEFAULT_CONFIG.approvalPolicy : (["safe", "full"].includes(requestedPolicy) ? requestedPolicy : "safe");
  const idle = Number(source.idleTimeoutMin);
  const whitelist = Array.isArray(source.whitelist)
    ? [...new Set(source.whitelist.map(entry => String(entry).trim()).filter(Boolean))].slice(0, 100)
    : [...DEFAULT_CONFIG.whitelist];
  return {
    costartMode,
    idleTimeoutMin: Number.isFinite(idle) ? Math.min(120, Math.max(0, idle)) : DEFAULT_CONFIG.idleTimeoutMin,
    approvalPolicy,
    whitelist,
    checkForUpdates: source.checkForUpdates !== false,
    cuaBinPath: typeof source.cuaBinPath === "string" ? source.cuaBinPath.slice(0, 4096) : "",
    historyEnabled: source.historyEnabled !== false,
    historyCaptureScreenshots: source.historyCaptureScreenshots !== false,
    historyMaxEntries: Number.isFinite(Number(source.historyMaxEntries)) ? Math.min(1_000_000, Math.max(0, Number(source.historyMaxEntries))) : DEFAULT_CONFIG.historyMaxEntries,
    historyRetentionDays: Number.isFinite(Number(source.historyRetentionDays)) ? Math.min(3650, Math.max(0, Number(source.historyRetentionDays))) : DEFAULT_CONFIG.historyRetentionDays,
    historyMaxShotsPerAction: Number.isFinite(Number(source.historyMaxShotsPerAction)) ? Math.min(10, Math.max(1, Number(source.historyMaxShotsPerAction))) : DEFAULT_CONFIG.historyMaxShotsPerAction,
  };
}
function recoverConfigBackup() {
  const backup = CONFIG_PATH + ".bak";
  if (!fs.existsSync(backup)) return;
  let currentValid = false;
  try { JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); currentValid = true; } catch {}
  if (!currentValid) fs.copyFileSync(backup, CONFIG_PATH);
  try { fs.unlinkSync(backup); } catch {}
}
function loadConfig() {
  recoverConfigBackup();
  for (const candidate of [CONFIG_PATH, path.join(HERE, "config.json")]) {
    let raw;
    try { raw = fs.readFileSync(candidate, "utf8"); } catch { continue; } // file missing: try next candidate
    try {
      const loaded = JSON.parse(raw);
      return normalizeConfig({ ...DEFAULT_CONFIG, ...loaded });
    } catch (e) {
      // File exists but is not valid JSON: fail CLOSED to safe mode rather
      // than silently falling back to the full-access default.
      log("config.json at", candidate, "is invalid JSON (" + e.message + ") \u2014 failing closed to safe mode");
      return normalizeConfig({ ...DEFAULT_CONFIG, approvalPolicy: "safe" });
    }
  }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const payload = JSON.stringify(normalizeConfig(c), null, 2) + "\n";
  const backup = CONFIG_PATH + ".bak";
  try { fs.unlinkSync(backup); } catch {}
  const hadCurrent = fs.existsSync(CONFIG_PATH);
  if (hadCurrent) fs.copyFileSync(CONFIG_PATH, backup);
  try {
    fs.writeFileSync(CONFIG_PATH, payload);
  } catch (error) {
    if (hadCurrent && fs.existsSync(backup)) fs.copyFileSync(backup, CONFIG_PATH);
    throw error;
  }
  try { fs.unlinkSync(backup); } catch {}
}
let config = loadConfig();
const history = new HistoryStore(path.join(CUA_CACHE_DIR, "history"), {
  enabled: config.historyEnabled,
  captureScreenshots: config.historyCaptureScreenshots,
  maxEntries: config.historyMaxEntries,
  retentionDays: config.historyRetentionDays,
  maxShots: config.historyMaxShotsPerAction,
});
let updateStatus = {
  status: RUNTIME_MANIFEST.buildType === "development" ? "development" : "pending",
  checkedAt: null,
  currentVersion: RUNTIME_MANIFEST.version,
};

// ---- per-app UIA quality profile (PRIOR, not verdict) ----
// Known-bad apps still get a live probe on their first request of a session --
// just a SHORT one; a recovered provider rehabilitates the app immediately.
const UIA_PROFILE_PATH = path.join(path.dirname(CONFIG_PATH), "uia-profile.json");
const UIA_PROFILE_TTL_MS = 30 * 24 * 3600 * 1000;
const UIA_PROBE_MS = 300;
let uiaProfile = loadUiaProfile(); // key -> {app, hangs, obs, avg_ms, last_quality, last_seen}
const uiaProfileProbed = new Set(); // identity keys already probed since helper (re)start
const uiaIdentityCache = new Map(); // exe path -> {mtimeMs, size, key}
let uiaProfileSaveTimer = null;
function loadUiaProfile() {
  try {
    const raw = JSON.parse(fs.readFileSync(UIA_PROFILE_PATH, "utf8"));
    const now = Date.now();
    const out = {};
    for (const [k, e] of Object.entries(raw)) {
      if (e && typeof e === "object" && now - (e.last_seen || 0) < UIA_PROFILE_TTL_MS) out[k] = e;
    }
    return out;
  } catch { return {}; } // corrupt/missing -> every app unknown
}
function saveUiaProfile() {
  clearTimeout(uiaProfileSaveTimer);
  uiaProfileSaveTimer = setTimeout(() => {
    try {
      const tmp = UIA_PROFILE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(uiaProfile, null, 1));
      fs.renameSync(tmp, UIA_PROFILE_PATH);
    } catch (e) { log("uia-profile save failed:", e.message); }
  }, 1000);
}
// Exe identity = full path + PE header timestamp + content hash (cached by
// mtime+size). AUMIDs/aliases without an .exe path get no persisted profile.
function uiaIdentityKey(app) {
  const filePath = String(app || "").replace(/^process:/, "");
  if (!/\.exe$/i.test(filePath)) return null;
  try {
    const st = fs.statSync(filePath);
    const cached = uiaIdentityCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.key;
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(4096);
      fs.readSync(fd, head, 0, head.length, 0);
      let peTs = 0;
      const peOff = head.length >= 0x40 ? head.readUInt32LE(0x3c) : 0;
      if (peOff + 12 <= head.length && head.readUInt32LE(peOff) === 0x4550) peTs = head.readUInt32LE(peOff + 8);
      const hash = crypto.createHash("sha1");
      const chunk = Buffer.alloc(1024 * 1024);
      const limit = Math.min(st.size, 8 * 1024 * 1024);
      for (let off = 0; off < limit; off += chunk.length) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - off), off);
        if (n <= 0) break;
        hash.update(chunk.subarray(0, n));
      }
      if (st.size > 64 * 1024 * 1024) {
        for (let off = st.size - 8 * 1024 * 1024; off < st.size; off += chunk.length) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, st.size - off), off);
          if (n <= 0) break;
          hash.update(chunk.subarray(0, n));
        }
      }
      const key = `${filePath.toLowerCase()}|pe:${peTs.toString(16)}|sha1:${hash.digest("hex").slice(0, 16)}`;
      uiaIdentityCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, key });
      return key;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function uiaProfileEntry(app) {
  const key = uiaIdentityKey(app);
  if (!key) return { key: null, entry: null };
  const entry = uiaProfile[key];
  if (entry && Date.now() - (entry.last_seen || 0) >= UIA_PROFILE_TTL_MS) { delete uiaProfile[key]; return { key, entry: null }; }
  return { key, entry };
}
// One short probe per known-bad app per helper session; everything else is untouched.
function maybeUiaProfileProbe(method, params, app) {
  if (method !== "get_window_state" || params?.include_text === false || !app) return 0;
  const { key, entry } = uiaProfileEntry(app);
  if (!key || !entry || !(entry.hangs > 0) || uiaProfileProbed.has(key)) return 0;
  uiaProfileProbed.add(key);
  log("uia-profile: known-bad app", app, "-> short probe " + UIA_PROBE_MS + "ms (prior only; live result decides)");
  return UIA_PROBE_MS;
}
function recordUiaObservation(method, params, app, result, dur, errorMessage) {
  if (method !== "get_window_state" || params?.include_text === false || !app) return;
  const { key } = uiaProfileEntry(app);
  if (!key) return;
  const reason = result?.uia?.reason || "";
  const quality = result?.uia?.quality;
  const timedOut = reason === "timeout_or_provider_disabled" || /timed out/i.test(errorMessage || "");
  if (!timedOut && !quality) return;
  const entry = uiaProfile[key] || (uiaProfile[key] = { app: String(app), hangs: 0, obs: 0, avg_ms: 0, last_quality: "unknown", last_seen: 0 });
  entry.last_seen = Date.now();
  if (timedOut) {
    entry.hangs = Math.min((entry.hangs || 0) + 1, 99);
    entry.last_quality = "timeout";
  } else {
    entry.obs = Math.min((entry.obs || 0) + 1, 1000);
    entry.avg_ms = Math.round(((entry.avg_ms || 0) * (entry.obs - 1) + dur) / entry.obs);
    entry.last_quality = quality;
    if (entry.hangs > 0) {
      // Live evidence beats the prior: a working provider rehabilitates the app.
      entry.hangs = Math.max(0, entry.hangs - 2);
      if (!entry.hangs) log("uia-profile:", app, "rehabilitated (UIA answered)");
    }
  }
  saveUiaProfile();
}
function idleMs() { const m = config.idleTimeoutMin; return m > 0 ? m * 60 * 1000 : 0; }

// ---- binary ownership ----
let proc = null;
let nextBinId = 1;
const pendingBin = new Map(); // binId -> {resolve, reject, timer, method, params, meta, clientId}
const approvedApps = new Set(); // cached across all clients
function isApproved(app) { const target = canonicalApp(app); return [...approvedApps].some(value => canonicalApp(value) === target); }

function startBinary() {
  if (proc && proc.exitCode == null && proc.signalCode == null) return;
  const bin = resolveCuaBin();
  if (!bin) {
    log("helper not found — set cuaBinPath in config or CUA_BIN env to the helper binary path");
    return;
  }
  const child = spawn(bin, ["--parent-pid", String(process.pid)], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: {
      ...process.env,
      FASTCUA_HOME: CUA_CACHE_DIR,
      // Legacy alias still read by older host builds / interrupt paths.
      CODEX_HOME: CUA_CACHE_DIR,
    },
  });
  proc = child;
  let childBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    if (proc !== child) return;
    childBuffer += chunk;
    let i;
    while ((i = childBuffer.indexOf("\n")) >= 0) {
      const line = childBuffer.slice(0, i).trim();
      childBuffer = childBuffer.slice(i + 1);
      if (line) { try { handleBinaryMessage(JSON.parse(line)); } catch { log("bad binary json:", line.slice(0, 200)); } }
    }
  });
  child.stderr.on("data", (d) => process.stderr.write("[bin] " + d));
  child.on("exit", (code, sig) => {
    log("helper exited code=", code, "sig=", sig);
    // A reset can spawn a replacement before the retired child's exit event.
    // Never let that stale callback clear or reject the replacement generation.
    if (proc !== child) return;
    proc = null;
    for (const [id, entry] of pendingBin) {
      if (entry.child !== child) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error("helper exited"));
      pendingBin.delete(id);
    }
  });
  uiaProfileProbed.clear(); // new helper process = new UIA session
  log("helper spawned (one shared binary) at", bin);
}
function sendToBinary(method, params, meta, extraMeta) {
  return new Promise((resolve, reject) => {
    startBinary();
    const child = proc;
    if (!child) { reject(new Error("helper binary not available (set cuaBinPath in config or CUA_BIN env)")); return; }
    const id = nextBinId++;
    const fullMeta = {
      ...meta,
      ...extraMeta,
      [BUDGET_KEY]: TIMEOUT_MS,
      [BUDGET_KEY_LEGACY]: TIMEOUT_MS,
    };
    // Dual-write approval markers so either new or legacy host keys match.
    if (fullMeta[APPROVED_KEY] && !fullMeta[APPROVED_KEY_LEGACY]) {
      fullMeta[APPROVED_KEY_LEGACY] = fullMeta[APPROVED_KEY];
    }
    if (fullMeta[APPROVED_KEY_LEGACY] && !fullMeta[APPROVED_KEY]) {
      fullMeta[APPROVED_KEY] = fullMeta[APPROVED_KEY_LEGACY];
    }
    const payload = JSON.stringify({ id, method, params, meta: fullMeta });
    const entry = { resolve, reject, method, params, meta, child, timer: null };
    entry.timer = setTimeout(() => {
      pendingBin.delete(id);
      reject(new Error("computer-use request timed out: " + method));
      resetBinary(); // wedged helper blocks all clients; reset so everyone recovers
    }, TIMEOUT_MS);
    pendingBin.set(id, entry);
    child.stdin.write(payload + "\n", (e) => { if (e) { clearTimeout(entry.timer); pendingBin.delete(id); reject(e); } });
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
function abortBinaryRequests(reason = "helper reset") {
  const p = proc; proc = null;
  for (const e of pendingBin.values()) { clearTimeout(e.timer); e.reject(new Error(reason)); }
  pendingBin.clear();
  try { if (p) killProcessTree(p.pid); } catch {}
}
function resetBinary(reason = "helper reset") {
  abortBinaryRequests(reason);
  for (const token of [...pendingApprovals.keys()]) rejectPendingApproval(token, reason);
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
  c.interruptOneShot = false;
  c.interruptPauseLinked = false;
}

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
  // Keep pendingApprovals: pause is not a deny. The host control plane may still resolve them.
  try { if (p) killProcessTree(p.pid); } catch {}
}

/**
 * Interrupt every connected client and reject in-flight helper work.
 *
 * Tool-message contract (what the agent should receive):
 * - pause=true, no interjection: no instruction latch; only isUserPaused block
 * - interjection set: latch ONE instruction message; do NOT stay paused (auto-resume)
 * - stop without interjection: ESC_MSG latch and stay interrupted until next turn/close
 */
function applyStopAll({ pause = false } = {}) {
  const interjection = pendingInterjection;
  // Paired stop+pause is semantically just Pause: block future calls and cancel
  // in-flight helper work without client latches or approval loss.
  if (pause && !interjection) {
    pendingInterjection = null;
    isUserPaused = true;
    abortInFlightWithoutAgentPrompt(PAUSE_BLOCK_MSG);
    emitEvent("paused", { client: "user", reason: "stop" });
    log("action: stopAll — paused", clients.size, "clients (block only)");
    return;
  }
  // Only interjection text is a real agent-facing instruction. Plain stop uses ESC_MSG.
  const msg = interjection ? interjectMsg(interjection) : ESC_MSG;
  pendingInterjection = null;
  for (const [, c] of clients) {
    c.interjection = interjection;
    c.interrupted = true;
    c.interruptMessage = msg;
    // Mark one-shot so interjection is delivered once then control continues.
    c.interruptOneShot = Boolean(interjection);
    c.interruptPauseLinked = false;
    const f = interruptFilePath(c.sessionId, c.turnId);
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ""); } catch {}
  }
  resetBinary(msg);
  currentAction = null;
  if (interjection) {
    // Interject = redirect instruction. Cancel in-flight, deliver text, AUTO-RESUME.
    isUserPaused = false;
    emitEvent("interjection", { client: "user", text: String(interjection).slice(0, 200) });
    emitEvent("resumed", { client: "user", reason: "interjection_auto_resume" });
  }
  emitEvent("interrupt", {
    client: "stop",
    paused: false,
    interjection: Boolean(interjection),
  });
  log(
    "action: stopAll — interrupted",
    clients.size,
    "clients",
    interjection ? "(interject + auto-resume)" : "(running latch only)",
    interjection ? `interjection="${String(interjection).slice(0, 60)}"` : ""
  );
}

function makeClient(socket) {
  const c = {
    sessionId: crypto.randomUUID(),
    turnId: 1,
    buf: "",
    socket,
    interjection: null,
    interrupted: false,
    interruptMessage: null,
    interruptOneShot: false,
    interruptPauseLinked: false,
    clientGroup: null,
    closed: false,
  };
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
  if (c) {
    const sessionId = c.sessionId;
    const hasBinaryWork = [...pendingBin.values()].some(entry => entry.meta?.session_id === sessionId);
    for (const [token, approval] of [...pendingApprovals.entries()]) {
      if (approval.entry.meta?.session_id === sessionId) {
        rejectPendingApproval(token, "computer-use client disconnected before approval");
      }
    }
    if (hasBinaryWork) {
      // The shared native host is synchronous, so killing it is the only safe
      // cancellation boundary. Other queued callers fail fast and can retry.
      abortBinaryRequests("computer-use client disconnected during an action");
      currentAction = null;
    }
    clearClientInterrupt(c);
  }
  clients.delete(socket);
  log("client gone (", clients.size, "left)");
  if (clients.size === 0) {
    const ms = idleMs();
    if (ms > 0) {
      idleTimer = setTimeout(() => {
        log("idle for", ms / 1000, "s — shutting down helper + daemon");
        resetBinary();
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
  if (typeof req.clientGroup === "string" && req.clientGroup.length <= 100) {
    c.clientGroup = req.clientGroup;
  }
  if (c.closed) {
    reply(c, id, { error: "computer-use client is closed" });
    return;
  }
  if (method === "close") {
    c.closed = true;
    clearClientInterrupt(c);
    c.turnId++;
    closeClientAfterReply(c, id, { result: { ok: true } });
    return;
  }
  if (method === "runtime_info") {
    reply(c, id, {
      result: runtimeInfo(HERE, {
        component: "daemon",
        serverPath: path.join(HERE, "server.mjs"),
        daemonPath: path.join(HERE, "daemon.mjs"),
        nativeHostPath: resolveCuaBin(),
        update: updateStatus,
      }),
    });
    return;
  }
  // ---- headless control plane + Computer Use history (named-pipe methods) ----
  // These are NOT gated by pause/approval/interrupt: they are how a control UI
  // (the DeepSeek Harness plugin, a test, or a script) drives the daemon.
  if (method === "state") {
    reply(c, id, { result: buildState() });
    return;
  }
  if (method === "get_config") {
    reply(c, id, { result: config });
    return;
  }
  if (method === "set_config") {
    try {
      const next = normalizeConfig({ ...config, ...(params?.config || params || {}) });
      const costartChanged = next.costartMode !== config.costartMode;
      const approvalChanged = next.approvalPolicy !== config.approvalPolicy || JSON.stringify(next.whitelist) !== JSON.stringify(config.whitelist);
      saveConfig(next);
      config = next;
      history.reconfigure({
        enabled: config.historyEnabled,
        captureScreenshots: config.historyCaptureScreenshots,
        maxEntries: config.historyMaxEntries,
        retentionDays: config.historyRetentionDays,
        maxShots: config.historyMaxShotsPerAction,
      });
      if (approvalChanged) approvedApps.clear();
      if (costartChanged) applyCostart(config.costartMode);
      emitEvent("policy", { approvalPolicy: config.approvalPolicy });
      reply(c, id, { result: config });
    } catch (error) {
      reply(c, id, { error: error.message });
    }
    return;
  }
  if (method === "pause") {
    isUserPaused = true;
    // Abort in-flight desktop work, but do NOT latch interrupt prompts on clients.
    // Agent only sees PAUSE_BLOCK_MSG if a call is cancelled or they try again.
    abortInFlightWithoutAgentPrompt(PAUSE_BLOCK_MSG);
    emitEvent("paused", { client: "user" });
    log("action: user paused desktop control (block only — no agent prompt)");
    reply(c, id, { result: { ok: true } });
    return;
  }
  if (method === "resume") {
    isUserPaused = false;
    for (const [, peer] of clients) {
      if (peer.interrupted && peer.interruptPauseLinked) clearClientInterrupt(peer);
    }
    emitEvent("resumed", { client: "user" });
    reply(c, id, { result: { ok: true } });
    return;
  }
  if (method === "interject") {
    const text = typeof params?.text === "string" ? params.text.trim().slice(0, 2000) : "";
    if (!text) { reply(c, id, { error: "interjection text is required" }); return; }
    pendingInterjection = text;
    applyStopAll({ pause: false });
    isUserPaused = false;
    reply(c, id, { result: { ok: true, paused: false, resumed: true, interjection: true } });
    return;
  }
  if (method === "resolve_approval") {
    try {
      await resolvePendingApproval(params?.token, params?.decision);
      reply(c, id, { result: { ok: true } });
    } catch (error) {
      reply(c, id, { error: error.message });
    }
    return;
  }
  if (method === "clear_approvals") {
    approvedApps.clear();
    reply(c, id, { result: { ok: true } });
    return;
  }
  if (method === "stop_all") {
    applyStopAll({ pause: Boolean(params?.pause) });
    reply(c, id, { result: { ok: true } });
    return;
  }
  if (method === "restart") {
    log("action: restarting daemon");
    resetBinary();
    reply(c, id, { result: { ok: true } });
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (method === "shutdown") {
    shutdownDaemon();
    reply(c, id, { result: { ok: true } });
    return;
  }
  if (method === "list_history") {
    const includeScreenshots = params?.includeScreenshots === true || params?.include_screenshots === true;
    // Agent-facing history is scoped to the requesting daemon client. A host
    // settings/history UI reads the local history file through its own grant.
    const entries = history.list({
      limit: params?.limit,
      since: params?.since,
      app: params?.app,
      sessionId: c.sessionId,
      includeScreenshots,
    });
    reply(c, id, { result: { entries, stats: history.stats() } });
    return;
  }
  if (method === "get_history") {
    const includeScreenshots = params?.includeScreenshots !== false && params?.include_screenshots !== false;
    const candidate = history.get(params?.id, { includeScreenshots });
    const entry = candidate?.sessionId === c.sessionId ? candidate : null;
    reply(c, id, { result: entry });
    return;
  }
  if (method === "clear_history") {
    history.clear();
    reply(c, id, { result: { ok: true, stats: history.stats() } });
    return;
  }
  // Order matters for agent messaging:
  // 1) Deliver latched interrupt FIRST (interjection one-shot or stop).
  //    Interjection must not be masked by isUserPaused (user was paused while typing).
  // 2) Then plain pause / approval blocks (no instruction payload).
  if (latchInterrupt(c)) {
    const msg = c.interruptMessage || ESC_MSG;
    const oneShot = Boolean(c.interruptOneShot);
    emitEvent("interrupt", { client: c.sessionId.slice(0, 8), oneShot });
    reply(c, id, { error: msg });
    // Interjection is one-shot: clear latch so subsequent tools can run under auto-resume.
    // Stop/ESC stays latched so further Computer Use tools keep failing this turn.
    if (oneShot) {
      if (c.clientGroup) {
        for (const peer of clients.values()) {
          if (peer.clientGroup === c.clientGroup) clearClientInterrupt(peer);
        }
      } else {
        clearClientInterrupt(c);
      }
    }
    return;
  }
  if (isUserPaused) { reply(c, id, { error: PAUSE_BLOCK_MSG }); return; }
  if (pendingApprovals.size) { reply(c, id, { error: APPROVAL_BLOCK_MSG }); return; }
  const meta = { session_id: c.sessionId, turn_id: String(c.turnId) };
  const app = params?.window?.app || params?.app;
  if (app && isApproved(app)) meta[APPROVED_KEY] = app;
  const clientProbe = Number(params?.uia_probe_ms);
  const uiaProbe = Number.isFinite(clientProbe) && clientProbe > 0
    ? Math.min(clientProbe, 30_000) // explicit client budget wins over profile short-probe
    : maybeUiaProfileProbe(method, params, app);
  if (uiaProbe) meta["x-fastcua-uia-probe-ms"] = uiaProbe;
  const t0 = Date.now();
  const summary = actionSummary(method, params);
  const action = { action: method, summary, startedAt: t0, client: c.sessionId.slice(0,8) };
  currentAction = action;
  emitEvent("action_start", { client: c.sessionId.slice(0,8), action: method, summary });
  try {
    const result = await sendToBinary(method, params, meta, {});
    const dur = Date.now() - t0;
    recordUiaObservation(method, params, app, result, dur, null);
    recordActionHistory({ method, params, app, summary, sessionId: c.sessionId, turnId: String(c.turnId), ok: true, durationMs: dur, error: null, result });
    if (currentAction === action) currentAction = null;
    emitEvent("action_end", { client: c.sessionId.slice(0,8), action: method, duration_ms: dur, summary, ok: true });
    reply(c, id, { result });
  } catch (e) {
    if (currentAction === action) currentAction = null;
    const dur = Date.now() - t0;
    recordUiaObservation(method, params, app, null, dur, e.message);
    recordActionHistory({ method, params, app, summary, sessionId: c.sessionId, turnId: String(c.turnId), ok: false, durationMs: dur, error: e.message, result: null });
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
const RUN_VAL = RUNTIME_MANIFEST.buildType === "development"
  ? `FastCUA-dev-${RUNTIME_ROOT_HASH}`
  : "FastCUA";
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

// ---- headless control-plane helpers (named-pipe only; no HTTP UI / overlay) ----
function fmtUptime() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}
function buildState() {
  return {
    clients: clients.size,
    binaryPid: proc?.pid || null,
    approvedApps: [...approvedApps],
    pendingApprovals: [...pendingApprovals.entries()].map(([token, approval]) => approvalView(token, approval)),
    approvalPolicy: config.approvalPolicy,
    controlState: isUserPaused ? "paused_by_user" : pendingApprovals.size ? "awaiting_approval" : "running",
    uptime: fmtUptime(),
    runtime: runtimeInfo(HERE, { component: "daemon", nativeHostPath: resolveCuaBin() }),
    update: updateStatus,
    history: history.stats(),
    inflight: currentAction ? { ...currentAction } : null,
    recentEvents: events.slice(-100),
    recentLogs,
  };
}
function shutdownDaemon() {
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
  log("action: shutdown — releasing helper and pipe server");
  setTimeout(() => {
    resetBinary();
    try { server.close(); } catch {}
    process.exit(0);
  }, 250);
}

// ---- update check (logs only; no UI surface) ----
checkForUpdates(HERE, { enabled: config.checkForUpdates }).then((result) => {
  updateStatus = result;
  if (result.status === "available") {
    log(`update available: ${result.currentVersion} -> ${result.latestVersion}`);
  }
}).catch((error) => {
  updateStatus = { status: "error", currentVersion: RUNTIME_MANIFEST.version, error: error.message };
});
const updateTimer = setInterval(() => {
  checkForUpdates(HERE, { enabled: config.checkForUpdates }).then((result) => {
    updateStatus = result;
  }).catch(() => {});
}, 6 * 60 * 60 * 1000);
updateTimer.unref();

applyCostart(config.costartMode);

// ---- pipe server ----
const server = net.createServer({ allowHalfOpen: false }, makeClient);
server.on("error", (e) => { log("pipe server error:", e.message); resetBinary(); process.exit(1); });
server.listen(PIPE, () => log("listening on", PIPE));

process.on("SIGINT", () => { resetBinary(); process.exit(0); });
process.on("SIGTERM", () => { resetBinary(); process.exit(0); });
process.on("SIGBREAK", () => { resetBinary(); process.exit(0); });
log("fastcua daemon ready (one shared helper, pipe:", PIPE + ")");
