// Thin MCP server: connects to the resident FastCUA daemon over a named pipe
// (spawns the daemon detached if it isn't running yet), and exposes the window2
// API + a persistent js REPL. The daemon owns ONE shared helper subprocess (one
// cursor) across all clients. The helper binary is a runtime dependency — this
// project does not include or redistribute it.
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

const log = (...a) => process.stderr.write("[fastcua] " + a.join(" ") + "\n");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const DAEMON = path.join(HERE, "daemon.mjs");
const PIPE = process.env.FASTCUA_PIPE || "\\\\.\\pipe\\fastcua";
// read co-start config: "manual" means don't auto-spawn the daemon (user runs it themselves)
function readCostart() { if (process.env.FASTCUA_COSTART_MODE) return process.env.FASTCUA_COSTART_MODE; try { return JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8")).costartMode || "claude"; } catch { return "claude"; } }

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
          // Cold-start budget: the daemon (esp. spawning the WPF overlay + bundled
          // node cold start) can take several seconds to open the pipe. Retry for
          // up to ~14s so the first call after a cold start succeeds instead of
          // failing with "daemon unavailable".
          if (attempt < 40) { attempt++; setTimeout(tryConn, 350); }
          else { log("daemon unavailable after retries"); resolve(); } // requests will reject "daemon unavailable"
        });
      };
      tryConn();
    });
  }
  spawnDaemon() {
    try {
      log("spawning daemon (detached for this agent session)");
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
  async request(method, params) {
    await this.ensure();
    return new Promise((resolve, reject) => {
      if (!this.sock || !this.sock.writable || this.sock.destroyed) { reject(new Error("daemon unavailable")); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("request timed out: " + method)); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, method, params }) + "\n", (e) => { if (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } });
    });
  }
  async close() {
    const socket = this.sock;
    if (socket && socket.writable && !socket.destroyed) {
      try { await this.request("close", {}); } catch {}
    }
    this.failAll("computer-use client closed");
    try { socket && socket.end(); } catch {}
  }
}
const daemon = new DaemonClient();

// Apple Voice Control–style number grid (screenshot/window pixel space = click x,y).
// - Cells are SQUARES (not viewport-aspect rectangles).
// - First pass: pack squares in 3 rows (fallback 2 rows if width is tight).
// - Refine: always 3×3 squares inside the chosen cell only (not the whole window).
// - Selecting a cell does NOT click; only sky.click_cell / sky.click commits input.
function pushCells(cells, { originLeft, originTop, cols, rows, side, startId = 1 }) {
  let n = startId;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const L = originLeft + c * side;
      const T = originTop + r * side;
      const R = L + side;
      const B = T + side;
      cells.push({
        id: String(n++),
        row: r,
        col: c,
        left: Math.round(L),
        top: Math.round(T),
        right: Math.round(R),
        bottom: Math.round(B),
        cx: Math.round(L + side / 2),
        cy: Math.round(T + side / 2),
        width: Math.round(side),
        height: Math.round(side),
        square: true,
      });
    }
  }
  return n;
}

/** Fill a rectangle with an equal rows×cols of squares using side = min(rw,rh)/n for refine, or row-based packing for initial. */
function buildGrid(input = {}) {
  const width = Math.max(1, Math.round(Number(input.width) || 0));
  const height = Math.max(1, Math.round(Number(input.height) || 0));
  const left = Math.max(0, Math.round(Number(input.left) || 0));
  const top = Math.max(0, Math.round(Number(input.top) || 0));
  const right = Math.min(width, Math.round(input.right != null ? Number(input.right) : width));
  const bottom = Math.min(height, Math.round(input.bottom != null ? Number(input.bottom) : height));
  if (right <= left || bottom <= top) throw new Error("invalid grid region");

  const rw = right - left;
  const rh = bottom - top;
  const refine = input.refine === true || input.phase === "refine";
  const cells = [];

  // Square-only packing (Apple Voice Control style). No stretched rect mode.
  let cols;
  let rows;
  let side;
  let originLeft = left;
  let originTop = top;

  if (refine) {
    // Always 3×3 squares inside the selected cell (cell is already a square).
    rows = 3;
    cols = 3;
    side = Math.min(rw, rh) / 3;
    // Center the 3×3 block if region is slightly non-square due to rounding.
    originLeft = left + (rw - side * 3) / 2;
    originTop = top + (rh - side * 3) / 2;
  } else if (input.cols != null || input.rows != null) {
    // Explicit dims: still force square cells using the limiting side.
    rows = Math.min(10, Math.max(1, Math.round(Number(input.rows) || 3)));
    cols = Math.min(10, Math.max(1, Math.round(Number(input.cols) || 3)));
    side = Math.min(rw / cols, rh / rows);
    originLeft = left + (rw - side * cols) / 2;
    originTop = top + (rh - side * rows) / 2;
  } else {
    // Initial pass (Apple-like): prefer 3 rows of squares; if width too tight, 2 rows.
    rows = 3;
    side = rh / 3;
    cols = Math.floor(rw / side + 1e-6);
    if (cols < 2) {
      rows = 2;
      side = rh / 2;
      cols = Math.floor(rw / side + 1e-6);
    }
    if (cols < 1) {
      rows = 1;
      cols = 1;
      side = Math.min(rw, rh);
    }
    // Center leftover horizontal/vertical margins (letterbox), do not stretch cells.
    originLeft = left + (rw - side * cols) / 2;
    originTop = top + (rh - side * rows) / 2;
  }

  pushCells(cells, { originLeft, originTop, cols, rows, side, startId: 1 });

  return {
    width,
    height,
    cols,
    rows,
    side: Math.round(side),
    mode: "square",
    phase: refine ? "refine" : "initial",
    region: { left, top, right, bottom },
    pack: {
      originLeft: Math.round(originLeft),
      originTop: Math.round(originTop),
      gridWidth: Math.round(side * cols),
      gridHeight: Math.round(side * rows),
    },
    cells,
    select_only: true,
    howto: [
      "Prefer sky.grid_view({window}) for ONE image with square outlines + numbers (semi-transparent).",
      "SELECT a number only — does NOT click.",
      "Refine: await sky.grid_refine({window, grid, cell:id}) → crops to that cell, draws 3×3 squares only.",
      "Click only: sky.click_cell({window, grid, cell:id}).",
    ].join(" "),
  };
}
function cellById(grid, id) {
  const want = String(id).trim();
  const cell = (grid?.cells || []).find((c) => String(c.id) === want || String(c.id).toUpperCase() === want.toUpperCase());
  if (!cell) throw new Error("unknown grid cell id: " + id + " (valid: " + (grid?.cells || []).map((c) => c.id).join(",") + ")");
  return cell;
}
function viewportFromState(state) {
  if (state?.viewport) return state.viewport;
  const s = state?.screenshots?.[0];
  if (s?.width && s?.height) {
    return {
      width: s.width,
      height: s.height,
      originX: s.originX,
      originY: s.originY,
      coordinate_space: "window_screenshot_pixels",
      origin: "top_left",
    };
  }
  throw new Error("no viewport: call get_window_state with include_screenshot:true first");
}

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
  close: async () => { await daemon.close(); return { ok: true }; },
  // Coordinate helpers
  viewport: viewportFromState,
  grid: buildGrid,
  grid_cell: cellById,
  /**
   * Capture ONCE with visual square-grid overlay (semi-transparent lines + outlined numbers).
   * path: string[] of selected cell ids to drill in; each refine crops to that cell (one image, fewer tokens).
   * Does NOT click. Prefer this over get_window_state + separate raw screenshots for targeting.
   */
  grid_view: async (input = {}) => {
    const window = input.window;
    const path = Array.isArray(input.path) ? input.path.map(String) : [];
    return daemon.request("grid_view", { window, path });
  },
  /**
   * Drill into a cell: appends id to path and returns a NEW grid_view (single cropped annotated image).
   * Does NOT click.
   */
  grid_refine: async (input) => {
    const { window, grid, cell: cellId } = input || {};
    if (!window) throw new Error("grid_refine requires { window, grid, cell }");
    cellById(grid, cellId); // validate
    const path = [...(grid.path || []), String(cellId)];
    return daemon.request("grid_view", { window, path });
  },
  /** Explicit click at cell center — only when ready (select ≠ click). */
  click_cell: async (input) => {
    const { window, grid, cell: cellId, mouse_button, click_count, screenshotId } = input || {};
    const cell = cellById(grid, cellId);
    return daemon.request("click", {
      window,
      x: cell.cx,
      y: cell.cy,
      mouse_button,
      click_count,
      screenshotId: screenshotId || "grid-0",
    });
  },
};

// ---- persistent JS REPL (independent `js` tool) ----
let replSession = { out: [], images: [] };
const cellStorage = new AsyncLocalStorage();
const JS_TIMEOUT_MS = Number(process.env.FASTCUA_JS_TIMEOUT_MS) > 0 ? Number(process.env.FASTCUA_JS_TIMEOUT_MS) : 120000;
let nextCellId = 1;
function currentCell() { return cellStorage.getStore(); }
function assertActiveCell() {
  const cell = currentCell();
  if (cell && !cell.active) throw new Error("js cell is no longer active");
  return cell;
}
function trackedSetTimeout(callback, delay, ...args) {
  const cell = currentCell();
  const handle = setTimeout(() => {
    if (cell) cell.timeouts.delete(handle);
    if (!cell || cell.active) callback(...args);
  }, delay);
  if (cell) cell.timeouts.add(handle);
  return handle;
}
function trackedClearTimeout(handle) {
  const cell = currentCell();
  if (cell) cell.timeouts.delete(handle);
  clearTimeout(handle);
}
function trackedSetInterval(callback, delay, ...args) {
  const cell = currentCell();
  const handle = setInterval(() => { if (!cell || cell.active) callback(...args); }, delay);
  if (cell) cell.intervals.add(handle);
  return handle;
}
function trackedClearInterval(handle) {
  const cell = currentCell();
  if (cell) cell.intervals.delete(handle);
  clearInterval(handle);
}
function deactivateCell(cell) {
  cell.active = false;
  for (const handle of cell.timeouts) clearTimeout(handle);
  for (const handle of cell.intervals) clearInterval(handle);
  cell.timeouts.clear();
  cell.intervals.clear();
}
const fmtRepl = (a) => (a === null ? "null" : a === undefined ? "undefined" : typeof a === "string" ? a : (() => { try { return JSON.stringify(a, null, 2); } catch { return String(a); } })());
const skyProxy = new Proxy(sky, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (typeof v !== "function") return v;
    return async (input) => {
      const cell = assertActiveCell();
      const r = await Reflect.apply(v, target, [input]);
      if (prop === "close" && cell) {
        cell.closeRequested = true;
        deactivateCell(cell);
        return r;
      }
      if (cell && !cell.active) throw new Error("js cell is no longer active");
      // Emit images: grid_view = single annotated frame only (save tokens).
      // get_window_state still emits screenshots as before.
      if ((prop === "get_window_state" || prop === "grid_view" || prop === "grid_refine") && r && Array.isArray(r.screenshots)) {
        // Prefer annotated grid image only when present.
        const shots = prop === "grid_view" || prop === "grid_refine"
          ? r.screenshots.filter((s) => s.annotated || s.id === "grid-0").slice(0, 1)
          : r.screenshots;
        const use = shots.length ? shots : r.screenshots.slice(0, 1);
        for (const s of use) {
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
  setTimeout: trackedSetTimeout, clearTimeout: trackedClearTimeout, setInterval: trackedSetInterval, clearInterval: trackedClearInterval,
  Promise, JSON, Math, Date, parseInt, parseFloat, isNaN, isFinite,
  String, Number, Boolean, Array, Object, RegExp, Error, Map, Set, WeakMap, WeakSet, Symbol,
  Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
  fs, path, os, crypto,
  sleep: (ms) => new Promise((r) => trackedSetTimeout(r, ms)),
};
const replContext = vm.createContext(replSandbox);
async function runJs(code) {
  replSession.out = []; replSession.images = [];
  const cell = { id: nextCellId++, active: true, closeRequested: false, timeouts: new Set(), intervals: new Set() };
  const wrapped = `(async () => {\n${code}\n})()`;
  let p;
  try { p = cellStorage.run(cell, () => new vm.Script(wrapped, { filename: "repl-cell.js" }).runInContext(replContext)); }
  catch (e) { return { content: [{ type: "text", text: "SyntaxError: " + (e.stack || e.message) }], isError: true, closeRequested: false }; }
  let timeoutHandle;
  try {
    await Promise.race([p, new Promise((_, rej) => { timeoutHandle = setTimeout(() => rej(new Error(`js cell timed out after ${JS_TIMEOUT_MS}ms`)), JS_TIMEOUT_MS); })]);
  } catch (e) {
    deactivateCell(cell);
    Promise.resolve(p).catch(() => {});
    const text = (replSession.out.length ? replSession.out.join("\n") + "\n" : "") + (e.stack || e.message);
    return { content: [{ type: "text", text }], isError: true, closeRequested: cell.closeRequested };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  deactivateCell(cell);
  const content = [];
  if (replSession.out.length) content.push({ type: "text", text: replSession.out.join("\n") });
  for (const img of replSession.images) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  if (!content.length) content.push({ type: "text", text: "(no output — use nodeRepl.write(x) or console.log(x) to print; bare expression values are not auto-printed)" });
  return { content, isError: false, closeRequested: cell.closeRequested };
}

// ---- tool definitions (window2 + close + js) ----
const W = { type: "object", properties: { app: { type: "string" }, id: { type: "number" } }, required: ["app", "id"] };
const TOOLS = [
  { name: "list_apps", desc: "List running apps that currently have visible targetable windows. Each app has windows[]. Choose the task-specific app+window before acting.", inputSchema: { type: "object", properties: {} } },
  { name: "list_windows", desc: "List open windows that can be targeted by the window2 API.", inputSchema: { type: "object", properties: {} } },
  { name: "get_window", desc: "Rehydrate a currently open window by id (after losing a window binding).", inputSchema: { type: "object", properties: { app: { type: "string" }, id: { type: "number" } }, required: ["id"] } },
  { name: "launch_app", desc: "Launch an app by id from list_apps, an explicit .exe path, the `paint` alias, or a shell:AppsFolder\\<AUMID> packaged-app target. Its window appears in list_apps() afterwards.", inputSchema: { type: "object", properties: { app: { type: "string", description: "app id, .exe process path, `paint`, or shell:AppsFolder\\<AUMID>" } }, required: ["app"] } },
  { name: "get_window_state", desc: "Capture accessibility tree and/or screenshot. Returns viewport {width,height,coordinate_space} — click x,y use that pixel space (origin top-left). Also focused_value when include_text. Prefer element_index; if UIA is empty use sky.grid letter-grid refine then click cell center.", inputSchema: { type: "object", properties: { window: W, include_screenshot: { type: "boolean", default: true }, include_text: { type: "boolean", default: true } }, required: ["window"] } },
  { name: "click", desc: "Click element_index from latest tree OR screenshot pixel x,y (same units as viewport/screenshot width×height; or both in 0..1 as fractions). Out-of-bounds returns an error with viewport size.", inputSchema: { type: "object", properties: { window: W, element_index: { type: "number" }, x: { type: "number" }, y: { type: "number" }, mouse_button: { type: "string", enum: ["left", "right", "middle", "l", "r", "m"] }, click_count: { type: "number" }, screenshotId: { type: "string" } }, required: ["window"] } },
  { name: "press_key", desc: "Press a key or +-separated chord (e.g. 'Return', 'Control_L+a', 'Ctrl+s', 'space').", inputSchema: { type: "object", properties: { window: W, key: { type: "string" } }, required: ["window", "key"] } },
  { name: "type_text", desc: "Write into the focused control AFTER the model has read focused_value via get_window_state and decided to edit. replace:true (default) clears the field then types; replace:false appends. Host does not decide whether to edit.", inputSchema: { type: "object", properties: { window: W, text: { type: "string" }, replace: { type: "boolean", default: true, description: "When true (default), clear focused field then type. When false, append." } }, required: ["window", "text"] } },
  { name: "scroll", desc: "Scroll by a delta from a coordinate in the window screenshot. scrollY: negative=up positive=down. scrollX: negative=left positive=right.", inputSchema: { type: "object", properties: { window: W, x: { type: "number" }, y: { type: "number" }, scrollX: { type: "number" }, scrollY: { type: "number" }, screenshotId: { type: "string" } }, required: ["window", "x", "y", "scrollX", "scrollY"] } },
  { name: "drag", desc: "Drag from one window coordinate to another.", inputSchema: { type: "object", properties: { window: W, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" }, screenshotId: { type: "string" } }, required: ["window", "from_x", "from_y", "to_x", "to_y"] } },
  { name: "perform_secondary_action", desc: "Raise the target window. This release supports only action='Raise' on the root element_index 0.", inputSchema: { type: "object", properties: { window: W, element_index: { type: "number", enum: [0] }, action: { type: "string", enum: ["Raise"] } }, required: ["window", "element_index", "action"] } },
  { name: "activate_window", desc: "Bring an open window to the foreground. Input methods activate their target window automatically; use this only as an escape hatch.", inputSchema: { type: "object", properties: { window: W }, required: ["window"] } },
  { name: "close", desc: "Finish the current computer-use turn and close this MCP client connection. Call once after the task is verified. The shared FastCUA daemon and helper remain available to other clients.", inputSchema: { type: "object", properties: {} } },
  { name: "js", desc: "Persistent JS REPL with sky + nodeRepl. Prefer sky.grid_view({window}) for ONE annotated square-grid image (semi-transparent outlines + outlined numbers). Refine: sky.grid_refine({window,grid,cell}). Click only: sky.click_cell. Example: let gv=await sky.grid_view({window}); gv=await sky.grid_refine({window,grid:gv.grid,cell:'4'}); await sky.click_cell({window,grid:gv.grid,cell:'5'});", inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript to execute. Use await for sky calls. Assign cross-cell state to globalThis." } }, required: ["code"] } },
  { name: "grid_view", desc: "Capture window once with visual SQUARE number grid overlaid (semi-transparent cell outlines + outlined digits). Optional path drills into prior cell ids (crops + 3x3). Returns one annotated image only. Does not click.", inputSchema: { type: "object", properties: { window: W, path: { type: "array", items: { type: "string" }, description: "Prior selected cell ids for drill-down" } }, required: ["window"] } },
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
    case "grid_view": return await sky.grid_view({ window: w, path: args.path || [] });
    case "click": return await sky.click({ window: w, element_index: args.element_index, x: args.x, y: args.y, mouse_button: args.mouse_button, click_count: args.click_count, screenshotId: args.screenshotId });
    case "press_key": return await sky.press_key({ window: w, key: args.key });
    case "type_text": return await sky.type_text({ window: w, text: args.text, replace: args.replace });
    case "scroll": return await sky.scroll({ window: w, x: args.x, y: args.y, scrollX: args.scrollX, scrollY: args.scrollY, screenshotId: args.screenshotId });
    case "set_value": return await sky.set_value({ window: w, element_index: args.element_index, value: args.value });
    case "drag": return await sky.drag({ window: w, from_x: args.from_x, from_y: args.from_y, to_x: args.to_x, to_y: args.to_y, screenshotId: args.screenshotId });
    case "perform_secondary_action": return await sky.perform_secondary_action({ window: w, element_index: args.element_index, action: args.action });
    case "activate_window": return await sky.activate_window({ window: w });
    case "close": return await sky.close();
    default: throw new Error("unknown tool: " + name);
  }
}
function stateToContent(state) {
  const content = [];
  // grid_view result: one annotated image + compact text (no raw duplicate shot).
  if (state?.grid && Array.isArray(state?.screenshots)) {
    const g = state.grid;
    const ids = (g.cells || []).map((c) => c.id).join(",");
    content.push({
      type: "text",
      text: [
        `GRID ${g.phase || "initial"} mode=square ${g.rows}x${g.cols} side=${g.side} path=${JSON.stringify(g.path || state.path || [])}`,
        `viewport ${state.viewport?.width}x${state.viewport?.height}  crop=${state.view?.width}x${state.view?.height}`,
        `cells: ${ids}`,
        "SELECT a number only (no click). Refine: grid_view with path+[id]. Click: click_cell when ready.",
        "Overlay: semi-transparent square outlines + small outlined digits (UI still visible underneath).",
      ].join("\n"),
    });
    const s = state.screenshots.find((x) => x.annotated || x.id === "grid-0") || state.screenshots[0];
    if (s) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(s.url || "");
      if (m) content.push({ type: "image", data: m[2], mimeType: m[1] });
    }
    content.push({ type: "text", text: "grid=" + JSON.stringify({ path: g.path, cells: g.cells, select_only: true }) });
    return content;
  }
  if (state?.viewport) {
    const v = state.viewport;
    content.push({
      type: "text",
      text: [
        "Coordinate space (required for pixel clicks):",
        `  viewport: ${v.width}x${v.height}  origin=top_left  space=${v.coordinate_space || "window_screenshot_pixels"}`,
        `  screen origin: (${v.screenLeft ?? v.originX},${v.screenTop ?? v.originY})`,
        "  Prefer grid_view for targeting (one annotated square-grid image).",
      ].join("\n"),
    });
  }
  if (state?.accessibility?.tree) content.push({ type: "text", text: "Accessibility tree (use [N] as element_index):\n" + state.accessibility.tree });
  if (state?.accessibility) {
    const a = state.accessibility;
    const parts = [];
    if (a.focused_element) parts.push("Focused: " + a.focused_element);
    if (a.focused_value != null && a.focused_value !== "") parts.push("Focused value: " + a.focused_value);
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
      content.push({
        type: "text",
        text: `screenshot ${s.id}: ${s.width}x${s.height} (click x,y are in this size; pass screenshotId when clicking)`,
      });
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
process.stdin.on("end", () => { daemon.failAll("MCP stdin closed"); try { daemon.sock && daemon.sock.end(); } catch {} process.exit(0); });

async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    let result;
    let closeAfterResponse = false;
    if (method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sky-computer-use", version: "0.2.0" } };
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
        closeAfterResponse = result.closeRequested;
        delete result.closeRequested;
      } else {
        const out = await callTool(name, args);
        const content = ((name === "get_window_state" || name === "grid_view") && out)
          ? stateToContent(out)
          : [{ type: "text", text: JSON.stringify(out, null, 2) }];
        result = { content, isError: false };
        closeAfterResponse = name === "close";
      }
    } else {
      sendError(id, -32601, "method not found: " + method);
      return;
    }
    send(id, { result }, closeAfterResponse ? closeMcpClient : undefined);
  } catch (e) {
    log("error", method, e.message);
    if (method === "tools/call") send(id, { result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
    else sendError(id, -32603, e.message);
  }
}
function closeMcpClient() {
  process.stdin.pause();
  setImmediate(() => process.exit(0));
}
function send(id, obj, onFlushed) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...obj }) + "\n", onFlushed); }
function sendError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

log("fastcua MCP server ready (thin client -> daemon at", PIPE + ")");
