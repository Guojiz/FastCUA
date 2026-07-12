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
const DEFAULT_CONFIG = { costartMode: "claude", idleTimeoutMin: 5, approvalPolicy: "safe", whitelist: ["mspaint.exe", "notepad.exe", "explorer.exe"], port: 8420, bannerEnabled: false, overlayEnabled: true, overlayTitle: "FastCUA is using your computer", overlayLanguage: "auto", cuaBinPath: "" };
const APPROVAL_WAIT_MS …50184 tokens truncated…e, 100));
  }
  throw new Error(`timeout: ${message}`);
}

class PipeClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.socket = net.connect("\\\\.\\pipe\\fastcua");
    this.socket.setEncoding("utf8");
    this.socket.on("data", chunk => this.onData(chunk));
  }

  async ready() {
    if (!this.socket.connecting) return;
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  close() {
    this.socket.end();
  }
}

const originalConfig = await api("/api/config");
const client = new PipeClient();
await client.ready();

try {
  await api("/api/action", { action: "pause" });
  assert.equal((await api("/api/state")).controlState, "paused_by_user");
  await assert.rejects(client.request("list_windows"), /paused by the user/i);
  console.log("PASS manual pause blocks pipe requests");

  await api("/api/action", { action: "resume" });
  assert.equal((await api("/api/state")).controlState, "running");
  assert.ok(Array.isArray(await client.request("list_windows")));
  console.log("PASS one-action resume restores requests");

  await api("/api/config", { ...originalConfig, approvalPolicy: "safe", whitelist: originalConfig.whitelist.filter(entry => entry.toLowerCase() !== "fastcuafixture.exe") });
  const deniedRequest = client.request("launch_app", { app: fixture }).then(
    () => null,
    error => error,
  );
  const deniedState = await waitFor(state => state.controlState === "awaiting_approval", "approval state");
  assert.equal(deniedState.pendingApprovals.length, 1);
  await api("/api/action", { action: "denyApproval", token: deniedState.pendingApprovals[0].token });
  assert.match((await deniedRequest)?.message || "", /denied by user/i);
  console.log("PASS unknown app enters machine pause and can be denied");

  const allowedRequest = client.request("launch_app", { app: fixture });
  const allowedState = await waitFor(state => state.controlState === "awaiting_approval", "second approval state");
  await api("/api/action", { action: "allowOnce", token: allowedState.pendingApprovals[0].token });
  await allowedRequest;
  assert.equal((await api("/api/state")).controlState, "running");
  console.log("PASS allow-once resumes and completes the action");

  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  const trustedRequest = client.request("launch_app", { app: fixture });
  const trustedState = await waitFor(state => state.controlState === "awaiting_approval", "trusted approval state");
  await api("/api/action", { action: "allowAndWhitelist", token: trustedState.pendingApprovals[0].token });
  await trustedRequest;
  assert.ok((await api("/api/config")).whitelist.some(entry => entry.toLowerCase() === "fastcuafixture.exe"));
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  await client.request("launch_app", { app: fixture });
  assert.equal((await api("/api/state")).pendingApprovals.length, 0);
  console.log("PASS add-to-trusted persists and skips the next prompt");

  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  await api("/api/config", { ...originalConfig, approvalPolicy: "full", whitelist: originalConfig.whitelist.filter(entry => entry.toLowerCase() !== "fastcuafixture.exe") });
  await client.request("launch_app", { app: fixture });
  const fullState = await api("/api/state");
  assert.equal(fullState.approvalPolicy, "full");
  assert.equal(fullState.pendingApprovals.length, 0);
  console.log("PASS full access runs an unknown app without prompting");

  await api("/api/interject", { text: "integration redirect" });
  await api("/api/action", { action: "stopAll" });
  await assert.rejects(client.request("list_windows"), /integration redirect/i);
  console.log("PASS interjection interrupts the connected client");
} finally {
  await api("/api/action", { action: "resume" }).catch(() => {});
  await api("/api/config", originalConfig).catch(() => {});
  client.close();
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
}

console.log("7 control-plane integration checks passed.");
