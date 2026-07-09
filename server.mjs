// Thin MCP server: connects to the resident FastCUA daemon over a named pipe
// (spawns the daemon detached if it isn't running yet), and exposes the window2
// API + a persistent js REPL. The daemon owns ONE shared helper subprocess (one
// cursor) across all clients — the `codex-computer-use` binary is a runtime
// dependency provided by the user's Codex install; this project does not
// include or redistribute it.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const log = (...a) => process.stderr.write("[fastcua] " + a.join(" ") + "\n");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const DAEMON = path.join(HERE, "daemon.mjs");
const PIPE = "\\\\.\\pipe\\fastcua";
// read co-start config: "manual" means don't auto-spawn the daemon (user runs it themselves)
function readCostart() { try { return JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8")).costartMode || "claude"; } catch { return "claude"; } }

// ---- daemon client (named pipe, newline JSON) ----
class DaemonClient {
  constructor() { this.sock = null; this.buf = ""; this.pending = new Map(); this.nextId = 1; this.connectPromise = null; }
  async ensure() {
    if (this.sock && this.sock.writable && !this.sock.destroyed) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }
  connect() {
    return new Promise((resolve) => {
      let attempt = 0;
      const tryConn = () => {
        const sock = net.createConnection(PIPE);
        sock.once("connect", () => { this.sock = sock; this.attach(sock); log("connected to daemon"); resolve(); });
        sock.once("error", () => {
          if (attempt === 0 && readCostart() !== "manual") { this.spawnDaemon(); }
          if (attempt < 6) { attempt++; setTimeout(tryConn, 350); }
          else { log("daemon unavailable after retries"); resolve(); } // requests will reject "daemon unavailable"
        });
      };
      tryConn();
    });
  }
  spawnDaemon() {
    try {
      log("spawning daemon (detached, co-starts with this Claude session)");
      const d = spawn(NODE, [DAEMON], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env } });
      d.unref();
    } catch (e) { log("spawn daemon failed:", e.message); }
  }
  attach(sock) {
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id == null) continue;
        const p = this.pending.get(m.id);
        if (!p) continue;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
      }
    });
    sock.on("error", () => this.failAll("daemon connection lost"));
    sock.on("close", () => { this.sock = null; this.failAll("daemon connection closed"); });
  }
  failAll(msg) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(msg)); } this.pending.clear(); this.sock = null; }
  request(method, params) {
    return new Promise(async (resolve, reject) => {
      await this.ensure();
      if (!this.sock || !this.sock.writable || this.sock.destroyed) { reject(new Error("daemon unavailable")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("request timed out: " + method)); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params }) + "\n", (e) => { if (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } });
    });
  }
  async close() { try { await this.request("close", {}); } catch {} try { this.sock && this.sock.end(); } catch {} }
}
const daemon = new DaemonClient();

// thin sky-like wrapper; sky.* forwards to the daemon
const sky = {
  list_apps: () => daemon.request("list_apps", {}),
  list_windows: () => daemon.request("list_windows", {}),
  get_window: (i) => daemon.request("get_window", i),
  launch_app: (i) => daemon.request("launch_app", i),
  get_window_state: (i) => daemon.request("get_window_state", i),
  click: (i) => daemon.request("click", i),
  press_key: (i) => daemon.request("press_key", i),
  type_text: (i) => daemon.request("type_text", i),
  scroll: (i) => daemon.request("scroll", i),
  set_value: (i) => daemon.request("set_value", i),
  drag: (i) => daemon.request("drag", i),
  perform_secondary_action: (i) => daemon.request("perform_secondary_action", i),
  activate_window: (i) => daemon.request("activate_window", i),
  end_turn: () => daemon.request("end_turn", {}),
  close: async () => { await daemon.close(); return { ok: true }; },
};

// ---- persistent JS REPL (independent `js` tool) ----
let replSession = { out: [], images: [] };
const fmtRepl = (a) => (a === null ? "null" : a === undefined ? "undefined" : typeof a === "string" ? a : (() => { try { return JSON.stringify(a, null, 2); } catch { return String(a); } })());
const skyProxy = new Proxy(sky, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (typeof v !== "function") return v;
    return async (input) => {
      const r = await Reflect.apply(v, target, [input]);
      if (prop === "get_window_state" && r && Array.isArray(r.screenshots)) {
        for (const s of r.screenshots) {
          const m = /^data:([^;]+);base64,(.*)$/s.exec(s.url || "");
          if (m) replSession.images.push({ data: m[2], mimeType: m[1] });
        }
      }
      return r;
    };
  },
});
const replSandbox = {
  sky: skyProxy,
  console: {
    log: (...a) => replSession.out.push(a.map(fmtRepl).join(" ")),
    error: (...a) => replSession.out.push(a.map(fmtRepl).join(" ")),
    warn: (...a) => replSession.out.push(a.map(fmtRepl).join(" ")),
    info: (...a) => replSession.out.push(a.map(fmtRepl).join(" ")),
  },
  nodeRepl: {
    write: (...a) => replSession.out.push(a.map(fmtRepl).join(" ")),
    emitImage: (url) => { const m = /^data:([^;]+);base64,(.*)$/s.exec(url || ""); if (m) replSession.images.push({ data: m[2], mimeType: m[1] }); },
    setResponseMeta: () => {}, requestMeta: {},
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, parseInt, parseFloat, isNaN, isFinite,
  String, Number, Boolean, Array, Object, RegExp, Error, Map, Set, WeakMap, WeakSet, Symbol,
  Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
  fs, path, os, crypto,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const replContext = vm.createContext(replSandbox);
async function runJs(code) {
  replSession.out = []; replSession.images = [];
  const wrapped = `(async () => {\n${code}\n})()`;
  let p;
  try { p = new vm.Script(wrapped, { filename: "repl-cell.js" }).runInContext(replContext); }
  catch (e) { return { content: [{ type: "text", text: "SyntaxError: " + (e.stack || e.message) }], isError: true }; }
  try {
    await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("js cell timed out after 120s")), 120000))]);
  } catch (e) {
    const text = (replSession.out.length ? replSession.out.join("\n") + "\n" : "") + (e.stack || e.message);
    return { content: [{ type: "text", text }], isError: true };
  }
  const content = [];
  if (replSession.out.length) content.push({ type: "text", text: replSession.out.join("\n") });
  for (const img of replSession.images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  if (!content.length) content.push({ type: "text", text: "(no output — use nodeRepl.write(x) or console.log(x) to print; bare expression values are not auto-printed)" });
  return { content, isError: false };
}

// ---- tool definitions (window2 + end_turn + close + js) ----
const W = { type: "object", properties: { app: { type: "string" }, id: { type: "number" } }, required: ["app", "id"] };
const TOOLS = [
  { name: "list_apps", desc: "List installed apps and their currently open targetable windows. Each app has windows[]. Choose the task-specific app+window before acting.", inputSchema: { type: "object", properties: {} } },
  { name: "list_windows", desc: "List open windows that can be targeted by the window2 API.", inputSchema: { type: "object", properties: {} } },
  { name: "get_window", desc: "Rehydrate a currently open window by id (after losing a window binding).", inputSchema: { type: "object", properties: { app: { type: "string" }, id: { type: "number" } }, required: ["id"] } },
  { name: "launch_app", desc: "Launch an app by id (from list_apps) or explicit .exe path. Its window appears in list_apps() afterwards.", inputSchema: { type: "object", properties: { app: { type: "string", description: "app id from list_apps() or a .exe process path" } }, required: ["app"] } },
  { name: "get_window_state", desc: "Capture accessibility tree (with element indexes) + screenshot for an open window. Returns screenshots as images and accessibility tree text with [N] element indexes used by click/set_value/etc.", inputSchema: { type: "object", properties: { window: W, include_screenshot: { type: "boolean", default: true }, include_text: { type: "boolean", default: true } }, required: ["window"] } },
  { name: "click", desc: "Click an indexed element (element_index from latest get_window_state) OR a coordinate (x,y) in the window screenshot.", inputSchema: { type: "object", properties: { window: W, element_index: { type: "number" }, x: { type: "number" }, y: { type: "number" }, mouse_button: { type: "string", enum: ["left", "right", "middle", "l", "r", "m"] }, click_count: { type: "number" }, screenshotId: { type: "string" } }, required: ["window"] } },
  { name: "press_key", desc: "Press a key or +-separated chord (e.g. 'Return', 'Control_L+a', 'Ctrl+s', 'space').", inputSchema: { type: "object", properties: { window: W, key: { type: "string" } }, required: ["window", "key"] } },
  { name: "type_text", desc: "Type text into the current focus in the window.", inputSchema: { type: "object", properties: { window: W, text: { type: "string" } }, required: ["window", "text"] } },
  { name: "scroll", desc: "Scroll by a delta from a coordinate in the window screenshot. scrollY: negative=up positive=down. scrollX: negative=left positive=right.", inputSchema: { type: "object", properties: { window: W, x: { type: "number" }, y: { type: "number" }, scrollX: { type: "number" }, scrollY: { type: "number" }, screenshotId: { type: "string" } }, required: ["window", "x", "y", "scrollX", "scrollY"] } },
  { name: "set_value", desc: "Replace the value of an indexed editable element.", inputSchema: { type: "object", properties: { window: W, element_index: { type: "number" }, value: { type: "string" } }, required: ["window", "element_index", "value"] } },
  { name: "drag", desc: "Drag from one window coordinate to another.", inputSchema: { type: "object", properties: { window: W, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" }, screenshotId: { type: "string" } }, required: ["window", "from_x", "from_y", "to_x", "to_y"] } },
  { name: "perform_secondary_action", desc: "Invoke a secondary accessibility action (e.g. 'Raise','Scroll Up','Expand','Collapse') on an indexed element.", inputSchema: { type: "object", properties: { window: W, element_index: { type: "number" }, action: { type: "string" } }, required: ["window", "element_index", "action"] } },
  { name: "activate_window", desc: "Bring an open window to the foreground. Input methods activate their target window automatically; use this only as an escape hatch.", inputSchema: { type: "object", properties: { window: W }, required: ["window"] } },
  { name: "end_turn", desc: "Signal end of the current computer-use turn (clears interrupt/turn scope). Call after a task's actions are verified, if you will keep doing more computer use this session.", inputSchema: { type: "object", properties: {} } },
  { name: "close", desc: "Disconnect this session from the shared computer-use daemon. Call when computer-use work is DONE for this session. The shared helper itself stays resident (other windows may use it) and auto-exits after 5 min idle.", inputSchema: { type: "object", properties: {} } },
  { name: "js", desc: "Run JavaScript in a persistent REPL with `sky` (the window2 API) and `nodeRepl` in scope. Top-level await supported. globalThis state persists across calls. Print with nodeRepl.write(x) / console.log(x); get_window_state screenshots auto-display as images. Use for multi-step/dependent logic, polling loops, tree filtering, batched actions. Example: globalThis.apps = await sky.list_apps(); nodeRepl.write(apps.length);", inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to execute. Use await for sky calls. Assign cross-cell state to globalThis." } }, required: ["code"] } },
];

function win(a) { return a && typeof a === "object" ? { app: a.app, id: a.id } : a; }
async function callTool(name, args) {
  const w = args.window ? win(args.window) : undefined;
  switch (name) {
    case "list_apps": return await sky.list_apps();
    case "list_windows": return await sky.list_windows();
    case "get_window": return await sky.get_window({ app: args.app, id: args.id });
    case "launch_app": return await sky.launch_app({ app: args.app });
    case "get_window_state": return await sky.get_window_state({ window: w, include_screenshot: args.include_screenshot ?? true, include_text: args.include_text ?? true });
    case "click": return await sky.click({ window: w, element_index: args.element_index, x: args.x, y: args.y, mouse_button: args.mouse_button, click_count: args.click_count, screenshotId: args.screenshotId });
    case "press_key": return await sky.press_key({ window: w, key: args.key });
    case "type_text": return await sky.type_text({ window: w, text: args.text });
    case "scroll": return await sky.scroll({ window: w, x: args.x, y: args.y, scrollX: args.scrollX, scrollY: args.scrollY, screenshotId: args.screenshotId });
    case "set_value": return await sky.set_value({ window: w, element_index: args.element_index, value: args.value });
    case "drag": return await sky.drag({ window: w, from_x: args.from_x, from_y: args.from_y, to_x: args.to_x, to_y: args.to_y, screenshotId: args.screenshotId });
    case "perform_secondary_action": return await sky.perform_secondary_action({ window: w, element_index: args.element_index, action: args.action });
    case "activate_window": return await sky.activate_window({ window: w });
    case "end_turn": return await sky.end_turn();
    case "close": return await sky.close();
    default: throw new Error("unknown tool: " + name);
  }
}
function stateToContent(state) {
  const content = [];
  if (state?.accessibility?.tree) content.push({ type: "text", text: "Accessibility tree (use [N] as element_index):\n" + state.accessibility.tree });
  if (state?.accessibility) {
    const a = state.accessibility;
    const parts = [];
    if (a.focused_element) parts.push("Focused: " + a.focused_element);
    if (a.selected_text) parts.push("Selected text: " + a.selected_text);
    if (a.document_text) parts.push("Document: " + a.document_text);
    if (parts.length) content.push({ type: "text", text: parts.join("\n") });
  }
  if (Array.isArray(state?.screenshots)) {
    const ids = [];
    for (const s of state.screenshots) {
      ids.push(s.id);
      const m = /^data:([^;]+);base64,(.*)$/s.exec(s.url || "");
      if (m) content.push({ type: "image", data: m[2], mimeType: m[1] });
      else content.push({ type: "text", text: "[screenshot id=" + s.id + " " + (s.width || "?") + "x" + (s.height || "?") + "]" });
    }
    if (ids.length) content.push({ type: "text", text: "screenshotIds: " + JSON.stringify(ids) });
  }
  if (state?.window) content.push({ type: "text", text: "window=" + JSON.stringify(state.window) });
  return content;
}

// ---- MCP stdio JSON-RPC 2.0 ----
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => { try { daemon.close(); } catch {} process.exit(0); });

async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fastcua", version: "0.3.0" } };
    } else if (method === "initialized" || method === "notifications/initialized") {
      return;
    } else if (method === "tools/list") {
      result = { tools: TOOLS.map(t => ({ name: t.name, description: t.desc, inputSchema: t.inputSchema })) };
    } else if (method === "tools/call") {
      const name = params.name;
      const args = params.arguments || {};
      log("call", name, JSON.stringify(args).slice(0, 200));
      if (name === "js") {
        result = await runJs(args.code || "");
      } else {
        const out = await callTool(name, args);
        const content = (name === "get_window_state" && out) ? stateToContent(out) : [{ type: "text", text: JSON.stringify(out, null, 2) }];
        result = { content, isError: false };
      }
    } else {
      sendError(id, -32601, "method not found: " + method);
      return;
    }
    send(id, { result });
  } catch (e) {
    log("error", method, e.message);
    if (method === "tools/call") send(id, { result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
    else sendError(id, -32603, e.message);
  }
}
function send(id, obj) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...obj }) + "\n"); }
function sendError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

log("fastcua MCP server ready (thin client -> daemon at", PIPE + ")");
