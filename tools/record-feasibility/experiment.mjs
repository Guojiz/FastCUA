// SPDX-License-Identifier: MIT
//
// Orchestrates stage-1 experiments for tools/record-feasibility against a live
// FastCUA daemon + Notepad + the test fixture. All artifacts go to %TEMP%;
// the printed summary is the input for docs/demonstration-recorder-feasibility.md.
//
// IMPORTANT honest limitation: on an unattended machine every programmatic
// input source (SendInput/keybd_event/mouse_event/journal playback) is flagged
// injected by Windows. We therefore validate the capture path with injected
// input and validate the injected-vs-physical flag semantics exhaustively;
// flag-clear ("physical") events traverse the identical callback code path.
//
// Usage: node tools/record-feasibility/experiment.mjs [--skip-cost] [--only-cost]

import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RECORDER = path.join(HERE, "target", "release", "record-feasibility.exe");
const CUA_BIN = path.join(ROOT, "native-host", "target", "release", "cua-native-host.exe");
const FIXTURE = path.join(ROOT, "tests", "FastCuaFixture.exe");
const SKIP_COST = process.argv.includes("--skip-cost");
const ONLY_COST = process.argv.includes("--only-cost");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function taskkillImage(image) {
  try { execFileSync("taskkill.exe", ["/IM", image, "/F"], { stdio: "ignore" }); } catch {}
}

// ---- daemon plumbing (same shape as tests/real-machine-validation.mjs) ----
class PipeClient {
  constructor(pipe) {
    this.pipe = pipe;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }
  ready() {
    return new Promise((resolve) => {
      const attempt = () => {
        const s = net.connect(this.pipe);
        s.once("connect", () => { this.socket = s; s.setEncoding("utf8"); s.on("data", (c) => this.onData(c)); resolve(); });
        s.once("error", () => setTimeout(attempt, 200));
      };
      attempt();
    });
  }
  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const e = this.pending.get(m.id);
      if (!e) continue;
      this.pending.delete(m.id);
      m.error ? e.reject(new Error(m.error)) : e.resolve(m.result);
    }
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
}

async function startDaemon(temp) {
  const configPath = path.join(temp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    costartMode: "manual", idleTimeoutMin: 0, approvalPolicy: "safe",
    whitelist: ["notepad.exe", "FastCuaFixture.exe"], port: 8420, bannerEnabled: false,
    overlayEnabled: false, overlayTitle: "", overlayLanguage: "auto", cuaBinPath: "",
  }));
  const portServer = net.createServer();
  await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  const pipe = `\\\\.\\pipe\\fastcua-rec-${Date.now()}`;
  const daemon = spawn(process.execPath, [path.join(ROOT, "daemon.mjs")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
    env: { ...process.env, CUA_BIN, FASTCUA_PIPE: pipe, FASTCUA_HTTP_PORT: String(port),
      FASTCUA_CONFIG_PATH: configPath, FASTCUA_DISABLE_OVERLAY: "1", FASTCUA_HOME: path.join(temp, "home") },
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + "/api/state"); break; } catch { await sleep(100); }
  }
  const client = new PipeClient(pipe);
  await client.ready();
  return { daemon, client, base };
}

function startRecorder(outDir, extra = []) {
  const proc = spawn(RECORDER, ["--out", outDir, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
  let banner = "";
  proc.stdout.on("data", (d) => { banner += d; });
  proc.stderr.on("data", (d) => { banner += d; });
  return { proc, banner: () => banner };
}

function analyze(sessionPath) {
  const lines = fs.readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
  const records = [];
  let parseErrors = 0;
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { parseErrors++; }
  }
  const byType = {};
  for (const r of records) byType[r.t] = (byType[r.t] || 0) + 1;
  const keyMouse = records.filter((r) => /^(key_|mouse_|wheel_)/.test(r.t));
  const injected = keyMouse.filter((r) => r.injected === true).length;
  const physical = keyMouse.filter((r) => r.injected === false).length;
  const stats = records.filter((r) => r.t === "stats");
  const redacted = records.filter((r) => r.redacted === "password-field");
  const keyframes = records.filter((r) => r.t === "keyframe");
  const focus = records.filter((r) => r.t === "focus" && r.uia && !r.uia.error);
  // Alignment: key/mouse events whose nearest focus record within ±600ms names
  // a text-ish role (Edit/Document) while typing into Notepad.
  const notepadKeys = records.filter((r) => /^key_down$/.test(r.t) && /notepad/i.test(r.fg?.app || ""));
  let aligned = 0;
  for (const k of notepadKeys) {
    const near = focus.filter((f) => Math.abs(f.ts - k.ts) <= 600 && /notepad/i.test(f.app || ""));
    if (near.some((f) => ["Edit", "Document"].includes(f.uia.role))) aligned++;
  }
  return {
    lines: lines.length,
    parseErrors,
    byType,
    keyMouse: keyMouse.length,
    injected,
    physical,
    redacted: redacted.length,
    keyframes: keyframes.length,
    keyframesSuppressed: keyframes.filter((k) => k.suppressed).length,
    focusRecords: focus.length,
    notepadKeyEvents: notepadKeys.length,
    notepadAligned: aligned,
    stats: stats.map((s) => ({
      callbacks: s.callbacks, cb_avg_us: s.cb_avg_us, cb_max_us: s.cb_max_us,
      dropped: s.dropped, coalesced: s.coalesced_moves,
      ws_mb: s.working_set_mb, cpu_ms: s.cpu_kernel_ms + s.cpu_user_ms,
    })),
    raw: records,
  };
}

async function waitForWindow(client, predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await client.request("list_windows")).find(predicate);
    if (found) return found;
    await sleep(150);
  }
  throw new Error("window not found: " + label);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-rec-exp-"));
  log("temp dir:", temp);
  const summary = {};

  const notepadExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe");

  if (!ONLY_COST) {
  // ---------------- Run 1: labeling + alignment + redaction (~70s) ----------------
  const run1Dir = path.join(temp, "run1");
  const rec1 = startRecorder(run1Dir, ["--duration-ms", "70000", "--screenshots", "5"]);
  await sleep(1500);
  const { daemon, client, base } = await startDaemon(temp);
  log("daemon + recorder up; generating FastCUA-routed input...");

  await client.request("launch_app", { app: notepadExe });
  const notepad = await waitForWindow(client, (w) => /notepad\.exe/i.test(w.app), "notepad");
  let state = await client.request("get_window_state", { window: notepad, include_screenshot: false, include_text: true });
  const edit = /^\s*(\d+)\s+(?:Edit|Document)\b/m.exec(state.accessibility?.tree || "");
  if (edit) await client.request("click", { window: notepad, element_index: Number(edit[1]) });
  await client.request("type_text", { window: notepad, text: "Hello FastCUA 123" });
  await client.request("press_key", { window: notepad, key: "Return" });
  await client.request("scroll", { window: notepad, x: 200, y: 200, scrollX: 0, scrollY: -120 });
  await sleep(500);

  // Fixture: password box (3rd Edit) then writable edit (1st Edit).
  await client.request("launch_app", { app: FIXTURE });
  const fixture = await waitForWindow(client, (w) => w.title === "FastCUA Host Test Fixture", "fixture");
  state = await client.request("get_window_state", { window: fixture, include_screenshot: false, include_text: true });
  const edits = (state.accessibility?.tree || "").split("\n")
    .filter((l) => /^\s*\d+\s+Edit\b/.test(l))
    .map((l) => Number(/^\s*(\d+)/.exec(l)[1]));
  log("fixture edit indexes:", JSON.stringify(edits));
  const passwordEdit = edits.at(-1); // created last
  await client.request("click", { window: fixture, element_index: passwordEdit });
  await sleep(600); // let the UIA poller observe password focus before typing
  await client.request("type_text", { window: fixture, text: "s3cret!" });
  await sleep(600);
  await client.request("click", { window: fixture, element_index: edits[0] });
  await client.request("type_text", { window: fixture, text: "normal text" });
  await client.request("click", { window: fixture, x: 100, y: 200 });
  await client.request("drag", { window: fixture, from_x: 380, from_y: 180, to_x: 550, to_y: 180 });
  await sleep(1000);

  // Undo the probe text so Notepad session state stays clean, then stop.
  await client.request("click", { window: notepad, element_index: Number(edit?.[1] || 0) }).catch(() => {});
  await client.request("press_key", { window: notepad, key: "Control_L+z" }).catch(() => {});
  await client.request("press_key", { window: notepad, key: "Control_L+z" }).catch(() => {});
  await fetch(base + "/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"shutdown"}' }).catch(() => {});
  taskkillImage("notepad.exe");
  taskkillImage("FastCuaFixture.exe");
  await new Promise((r) => rec1.proc.once("exit", r));
  log("run 1 recorder banner:\n" + rec1.banner().trim());

  const session1 = path.join(run1Dir, "session.jsonl");
  const a1 = analyze(session1);
  const rawText = fs.readFileSync(session1, "utf8");
  summary.run1 = {
    ...a1,
    stats: a1.stats,
    leakedSecrets: ["Hello FastCUA 123", "s3cret!", "normal text"].filter((s) => rawText.includes(s)),
  };
  delete summary.run1.raw;
  const keyframeFiles = fs.readdirSync(path.join(run1Dir, "keyframes"));
  summary.run1.keyframeFiles = keyframeFiles.length;
  summary.run1.keyframeBytes = keyframeFiles.reduce((n, f) => n + fs.statSync(path.join(run1Dir, "keyframes", f)).size, 0);

  // ---------------- Run 2: crash mid-recording ----------------
  const run2Dir = path.join(temp, "run2");
  const rec2 = startRecorder(run2Dir, ["--duration-ms", "120000", "--screenshots", "4"]);
  await sleep(4000);
  const d2dir = path.join(temp, "d2"); fs.mkdirSync(d2dir, { recursive: true });
  const { daemon: d2, client: c2, base: b2 } = await startDaemon(d2dir);
  await c2.request("launch_app", { app: notepadExe });
  const np2 = await waitForWindow(c2, (w) => /notepad\.exe/i.test(w.app), "notepad");
  await c2.request("type_text", { window: np2, text: "typing while about to crash" });
  await sleep(4000);
  execFileSync("taskkill.exe", ["/PID", String(rec2.proc.pid), "/F"], { stdio: "ignore" });
  await sleep(800);
  await c2.request("press_key", { window: np2, key: "Control_L+z" }).catch(() => {});
  await fetch(b2 + "/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"shutdown"}' }).catch(() => {});
  taskkillImage("notepad.exe");
  try { d2.kill(); } catch {}
  const session2 = path.join(run2Dir, "session.jsonl");
  const a2 = analyze(session2);
  summary.run2 = {
    linesAfterKill: a2.lines,
    parseErrorsAfterKill: a2.parseErrors,
    byType: a2.byType,
    lastRecordComplete: a2.parseErrors === 0,
  };
  delete summary.run2.raw;
  // Re-run 5s to prove hooks from the killed process left nothing behind.
  const run2bDir = path.join(temp, "run2b");
  const rec2b = startRecorder(run2bDir, ["--duration-ms", "5000"]);
  await new Promise((r) => rec2b.proc.once("exit", r));
  summary.run2.rerunOk = fs.existsSync(path.join(run2bDir, "session.jsonl"))
    && analyze(path.join(run2bDir, "session.jsonl")).parseErrors === 0;

  } // end if (!ONLY_COST)

  // ---------------- Run 3: 3-minute cost measurement ----------------
  if (!SKIP_COST) {
    const run3Dir = path.join(temp, "run3");
    const rec3 = startRecorder(run3Dir, ["--duration-ms", "180000", "--screenshots", "10"]);
    await sleep(1500);
    const d3dir = path.join(temp, "d3"); fs.mkdirSync(d3dir, { recursive: true });
    const { daemon: d3, client: c3, base: b3 } = await startDaemon(d3dir);
    await c3.request("launch_app", { app: notepadExe });
    const np3 = await waitForWindow(c3, (w) => /notepad\.exe/i.test(w.app), "notepad");
    const st3 = await c3.request("get_window_state", { window: np3, include_screenshot: false, include_text: true });
    const ed3 = /^\s*(\d+)\s+(?:Edit|Document)\b/m.exec(st3.accessibility?.tree || "");
    const end = Date.now() + 170_000;
    let strokes = 0;
    while (Date.now() < end) {
      try {
        if (ed3) await c3.request("click", { window: np3, element_index: Number(ed3[1]) });
        await c3.request("type_text", { window: np3, text: "cost probe line " });
        await c3.request("press_key", { window: np3, key: "Return" });
        await c3.request("scroll", { window: np3, x: 150, y: 150, scrollX: 0, scrollY: -60 });
        strokes++;
        await sleep(1200);
      } catch { await sleep(500); }
    }
    // Clean the accumulated probe text: select all + delete inside the doc we made.
    if (ed3) await c3.request("click", { window: np3, element_index: Number(ed3[1]) }).catch(() => {});
    await c3.request("press_key", { window: np3, key: "Control_L+a" }).catch(() => {});
    await c3.request("press_key", { window: np3, key: "Delete" }).catch(() => {});
    await sleep(400);
    await fetch(b3 + "/api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"shutdown"}' }).catch(() => {});
    taskkillImage("notepad.exe");
    try { d3.kill(); } catch {}
    await new Promise((r) => rec3.proc.once("exit", r));
    const a3 = analyze(path.join(run3Dir, "session.jsonl"));
    summary.run3 = {
      durationSec: 180,
      inputStrokesIssued: strokes,
      totalLines: a3.lines,
      parseErrors: a3.parseErrors,
      byType: a3.byType,
      injected: a3.injected,
      physical: a3.physical,
      fileBytes: fs.statSync(path.join(run3Dir, "session.jsonl")).size,
      keyframeBytes: fs.readdirSync(path.join(run3Dir, "keyframes"))
        .reduce((n, f) => n + fs.statSync(path.join(run3Dir, "keyframes", f)).size, 0),
      statsTimeline: a3.stats,
    };
  }

  const outPath = path.join(temp, "summary.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  log("SUMMARY\n" + JSON.stringify(summary, null, 2));
  log("summary written:", outPath);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
