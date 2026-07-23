// SPDX-License-Identifier: MIT
//
// Real-machine validation for FastCUA issue #3 stages 2-4 (skill-recorder).
//
// Records a REAL demonstration session on this machine:
//   FastCuaFixture: click edit -> type "report-2026-07-23" -> note via
//   Ctrl+Alt+N dialog -> type into password box (redaction) -> click button ->
//   second note -> Ctrl+Alt+X emergency stop.
// All demo input is FastCUA-injected (unattended machine): the recorder must
// LABEL it injected, the compiler must flag it ⚠ unresolved, and the narration
// notes (also injected, into the recorder's own dialog) must still be accepted
// while the dialog's own keystrokes stay OUT of the demo stream.
// Then compiles the session and asserts the draft + Skill folder contract.
//
// Usage: node tests/skill-recorder-validation.mjs
// Output: tests/_skillrec-validation-<yyyymmdd-HHmmss>.log

import { spawn, execFileSync, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CUA_BIN = path.join(ROOT, "native-host", "target", "release", "cua-native-host.exe");
const FIXTURE = path.join(HERE, "FastCuaFixture.exe");
const RECORDER = path.join(ROOT, "tools", "skill-recorder", "target", "release", "skill-recorder.exe");
const COMPILE = path.join(ROOT, "tools", "skill-recorder", "compile.mjs");

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17);
const LOG_PATH = path.join(HERE, `_skillrec-validation-${stamp}.log`);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function taskkillImage(image) {
  try { execFileSync("taskkill.exe", ["/IM", image, "/F"], { stdio: "ignore" }); } catch {}
}

class PipeClient {
  constructor(pipe) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.socket = net.connect(pipe);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => {
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
    });
    this.closed = new Promise((resolve) => this.socket.once("close", resolve));
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
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

function buildRecorder() {
  if (fs.existsSync(RECORDER)) return;
  log("building skill-recorder (cargo build --release --offline)...");
  const cargo = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
  execFileSync(cargo, ["build", "--release", "--offline"], {
    cwd: path.join(ROOT, "tools", "skill-recorder"),
    stdio: "inherit",
    env: { ...process.env, PATH: path.join(os.homedir(), ".cargo", "bin") + ";" + process.env.PATH },
  });
}

async function main() {
  if (!fs.existsSync(CUA_BIN)) throw new Error("native host not built: " + CUA_BIN);
  if (!fs.existsSync(FIXTURE)) throw new Error("fixture not built: " + FIXTURE);
  buildRecorder();
  taskkillImage("FastCuaFixture.exe");
  taskkillImage("skill-recorder.exe");

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-skillrec-"));
  const recDir = path.join(temp, "session");
  const configPath = path.join(temp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    costartMode: "manual",
    idleTimeoutMin: 0,
    approvalPolicy: "safe",
    whitelist: ["FastCuaFixture.exe", "skill-recorder.exe"],
    port: 8420,
    bannerEnabled: false,
    overlayEnabled: false,
    overlayTitle: "FastCUA skill-rec validation",
    overlayLanguage: "auto",
    cuaBinPath: "",
  }, null, 2));

  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const pipe = `\\\\.\\pipe\\fastcua-skillrec-${stamp}`;

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
  daemon.stderr.on("data", () => {});

  let recOut = "";
  let recErr = "";
  const recorder = spawn(RECORDER, [
    "--out", recDir,
    "--duration-ms", "240000",
    "--keyframe-interval", "20",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  recorder.stdout.on("data", (d) => { recOut += d; });
  recorder.stderr.on("data", (d) => { recErr += d; });
  const recorderExit = new Promise((resolve) => recorder.once("exit", resolve));

  const cleanup = () => {
    try { daemon.kill(); } catch {}
    try { recorder.kill(); } catch {}
    taskkillImage("FastCuaFixture.exe");
    taskkillImage("skill-recorder.exe");
  };

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      try { await apiJson(base, "/api/state"); ready = true; }
      catch { await sleep(100); }
    }
    if (!ready) throw new Error("daemon did not become ready");
    const client = new PipeClient(pipe);
    await client.ready();
    await sleep(600); // let the recorder install hooks + hotkeys

    // ---------------- demonstration (all FastCUA-injected) ----------------
    log("--- recording demonstration on FastCuaFixture ---");
    const r = await client.request("launch_app", { app: FIXTURE });
    check("launch fixture", !r.error);
    const fixtureWindow = await waitForWindow(client,
      (w) => w.title === "FastCUA Host Test Fixture", "fixture");
    const state = await client.request("get_window_state", {
      window: fixtureWindow, include_screenshot: false, include_text: true,
    });
    const tree = state?.accessibility?.tree || "";
    const editIndexes = [...tree.matchAll(/^\s*(\d+)\s+Edit\b/gm)].map((m) => Number(m[1]));
    check("fixture edits enumerated (writable, read-only, password)", editIndexes.length >= 3,
      `indexes=${editIndexes.join(",")}`);
    const buttonIndex = Number(/^\s*(\d+)\s+Button\b.*Increment/m.exec(tree)?.[1]);
    check("fixture button enumerated", buttonIndex > 0, `index=${buttonIndex}`);

    // Step 1: click writable edit + type date-stamped report name.
    await client.request("click", { window: fixtureWindow, element_index: editIndexes[0] });
    await sleep(400);
    await client.request("type_text", { window: fixtureWindow, text: "report-2026-07-23" });
    await sleep(1_600); // UIA heartbeat must snapshot the committed value

    // Note 1 via the Ctrl+Alt+N narration channel (injected hotkey + dialog).
    await client.request("press_key", { window: fixtureWindow, key: "Control_L+Alt_L+n" });
    const noteWindow = await waitForWindow(client,
      (w) => /skill recorder note/i.test(w.title), "recorder note window", 5_000);
    check("note dialog opened via injected Ctrl+Alt+N", noteWindow, JSON.stringify(noteWindow));
    await sleep(400);
    await client.request("type_text", { window: noteWindow, text: "intent: enter the report date" });
    await sleep(300);
    await client.request("press_key", { window: noteWindow, key: "Return" });
    await sleep(400);

    // Step 2: password box (must be redacted end-to-end).
    await client.request("click", { window: fixtureWindow, element_index: editIndexes[2] });
    await sleep(500);
    await client.request("type_text", { window: fixtureWindow, text: "s3cret!" });
    await sleep(800);

    // Step 3: click the Increment button.
    await client.request("click", { window: fixtureWindow, element_index: buttonIndex });
    await sleep(600);

    // Note 2: an exception rule.
    await client.request("press_key", { window: fixtureWindow, key: "Control_L+Alt_L+n" });
    const noteWindow2 = await waitForWindow(client,
      (w) => /skill recorder note/i.test(w.title), "recorder note window (2)", 5_000);
    await sleep(400);
    await client.request("type_text", { window: noteWindow2, text: "exception: if the button does not react, retry once" });
    await sleep(300);
    await client.request("press_key", { window: noteWindow2, key: "Return" });
    await sleep(1_200);

    // Emergency stop via injected Ctrl+Alt+X.
    await client.request("press_key", { window: fixtureWindow, key: "Control_L+Alt_L+x" });
    await Promise.race([recorderExit, sleep(8_000)]);
    check("recorder stopped via emergency hotkey", recorder.exitCode !== null || recOut.includes("done"),
      `exitCode=${recorder.exitCode}`);
    log("recorder output tail:", recOut.split("\n").slice(-3).join(" | "), recErr ? "ERR:" + recErr.slice(-200) : "");

    // ---------------- session assertions ----------------
    const sessionPath = path.join(recDir, "session.jsonl");
    check("session.jsonl exists", fs.existsSync(sessionPath), sessionPath);
    const raw = fs.readFileSync(sessionPath, "utf8");
    const events = raw.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
    check("every JSONL line parses", events.every(Boolean), `${events.filter(Boolean).length}/${raw.split(/\r?\n/).filter(Boolean).length}`);
    const header = events.find((e) => e?.t === "header");
    check("header declares fastcua-recording/1", header?.format === "fastcua-recording/1", header?.format);

    const notes = events.filter((e) => e?.t === "note");
    check("two narration notes recorded", notes.length === 2,
      notes.map((n) => n.text).join(" | "));
    check("note texts preserved", notes.some((n) => n.text.includes("report date"))
      && notes.some((n) => n.text.includes("retry once")), "");

    check("password probe never appears in session", !raw.includes("s3cret"), "");
    const redacted = events.filter((e) => e?.redacted === "password-field");
    check("password key events redacted (vk dropped)", redacted.length >= 1, `${redacted.length} records`);

    const hookEvents = events.filter((e) => ["key_down", "key_up", "mouse_down", "mouse_up"].includes(e?.t));
    check("recorder's own windows excluded from demo stream",
      !hookEvents.some((e) => /skill-recorder/i.test(e.fg?.app || "")), `${hookEvents.length} hook events`);
    check("recorder hotkey chords not recorded as demo input",
      !hookEvents.some((e) => e.t === "key_down" && e.mods?.ctrl && e.mods?.alt && [0x4e, 0x52, 0x58].includes(e.vk)), "");

    const injectedCount = hookEvents.filter((e) => e.injected).length;
    const physicalCount = hookEvents.length - injectedCount;
    log(`honesty: ${injectedCount} injected / ${physicalCount} physical hook events (unattended machine — physical path is identical hook code but cannot be exercised here)`);
    check("all demo input labeled injected:true", hookEvents.length > 0 && injectedCount === hookEvents.length,
      `${injectedCount}/${hookEvents.length}`);

    const anchoredClicks = hookEvents.filter((e) => e.t === "mouse_down" && e.anchor);
    check("clicks carry point anchors with numeric control-type IDs",
      anchoredClicks.length >= 2 && anchoredClicks.every((e) => typeof e.anchor.control_type === "number"),
      anchoredClicks.map((e) => `${e.anchor.role}(${e.anchor.control_type})`).join(", "));
    check("click anchors carry localized-name hint + automation id",
      anchoredClicks.some((e) => e.anchor.name_localized === true && e.anchor.control_type === 50004
        && e.anchor.automation_id === "1002"),
      JSON.stringify(anchoredClicks[0]?.anchor).slice(0, 200));
    const anchoredKeys = hookEvents.filter((e) => e.t === "key_down" && e.anchor && !e.redacted);
    check("keystrokes carry focus anchors", anchoredKeys.length > 0,
      `${anchoredKeys.length}/${hookEvents.filter((e) => e.t === "key_down" && !e.redacted).length}`);
    const buttonAnchor = anchoredClicks.find((e) => e.anchor.control_type === 50000);
    check("button click anchored on Button(50000)", buttonAnchor, JSON.stringify(buttonAnchor?.anchor).slice(0, 160));

    const keyframes = events.filter((e) => e?.t === "keyframe");
    const jpgDir = path.join(recDir, "keyframes");
    const jpgs = fs.existsSync(jpgDir) ? fs.readdirSync(jpgDir).filter((f) => f.endsWith(".jpg")) : [];
    const jpgBytes = jpgs.reduce((a, f) => a + fs.statSync(path.join(jpgDir, f)).size, 0);
    const first = events.find((e) => e?.ts)?.ts;
    const last = [...events].reverse().find((e) => e?.ts)?.ts;
    const minutes = Math.max((last - first) / 60_000, 1 / 60);
    const bytesPerMin = jpgBytes / minutes;
    check("JPEG keyframes captured", jpgs.length >= 2 && keyframes.every((k) => k.suppressed || k.path.endsWith(".jpg")),
      `${jpgs.length} files`);
    check("keyframe cost < 2 MB/min", bytesPerMin < 2_000_000,
      `${(bytesPerMin / 1_000_000).toFixed(3)} MB/min (${jpgs.length} frames, ${(jpgBytes / 1000).toFixed(0)} KB, ${(minutes).toFixed(2)} min)`);
    check("keyframe reasons include note/action/focus triggers",
      ["note", "action"].every((r) => keyframes.some((k) => k.reason === r)),
      [...new Set(keyframes.map((k) => k.reason))].join(","));

    const stats = events.filter((e) => e?.t === "stats").pop();
    check("zero dropped hook events", stats && stats.dropped === 0, `callbacks=${stats?.callbacks} avg=${stats?.cb_avg_us}us`);

    // ---------------- compile (stage 3) ----------------
    log("--- compiling session to draft + skill folder ---");
    const compileOut = execFileSync(process.execPath, [COMPILE, sessionPath, "--skill", "fixture-report"], { encoding: "utf8" });
    log(compileOut.trim().split("\n").join(" | "));
    const draft = JSON.parse(fs.readFileSync(path.join(recDir, "draft.json"), "utf8"));
    check("draft is non-executable and unverified", draft.executable === false && draft.verified === false, "");

    const typeStep = draft.steps.find((s) => s.action === "type" && (s.observed_text || "").includes("2026-07-23"));
    check("type step recovered text from UIA value (never from vk)", typeStep,
      JSON.stringify(typeStep?.observed_text));
    const redactedStep = draft.steps.find((s) => s.redacted === "password-field");
    check("redacted password step present, contentless", redactedStep && !redactedStep.observed_text && !redactedStep.text, "");
    const clickStep = draft.steps.find((s) => s.action === "click" && s.anchor?.control_type === 50000);
    check("button click step with Button(50000) anchor", clickStep, "");
    check("steps ordered: type < redacted < button click",
      typeStep && redactedStep && clickStep && typeStep.n < redactedStep.n && redactedStep.n < clickStep.n,
      `${typeStep?.n} < ${redactedStep?.n} < ${clickStep?.n}`);

    const dateParam = draft.parameters.find((p) => p.kind === "date");
    check("date inferred as parameter with provenance", dateParam && dateParam.observed === "2026-07-23"
      && dateParam.provenance?.step === typeStep?.n, JSON.stringify(dateParam));
    check("parameter placeholder substituted in step text", (typeStep?.text || "").includes(`{{${dateParam?.name}}}`),
      typeStep?.text);

    const draftText = JSON.stringify(draft);
    check("draft preserves redaction (no secret anywhere)", !draftText.includes("s3cret"), "");
    const unresolved = draft.warnings.filter((w) => w.includes("⚠ unresolved")).length
      + draft.steps.reduce((a, s) => a + s.warnings.filter((w) => w.includes("⚠ unresolved")).length, 0);
    check("⚠ unresolved markers present (injected spans etc.)", unresolved > 0, `${unresolved} markers`);
    check("session-level injected-span warning (all input was automation-driven)",
      draft.warnings.some((w) => w.includes("injected input")), "");
    check("narration attached as step intent or note step",
      draft.steps.some((s) => (s.intent || []).some((t) => t.includes("report date")) || (s.text || "").includes("report date")),
      "");

    // ---------------- skill folder (stage 4) ----------------
    const skillFile = path.join(recDir, "skill-draft", "fixture-report", "SKILL.md");
    check("SKILL.md generated", fs.existsSync(skillFile), skillFile);
    const skill = fs.readFileSync(skillFile, "utf8");
    check("frontmatter: name + description + verified:false",
      /^---\nname: fixture-report\ndescription: .+\nverified: false\n---/.test(skill), "");
    check("prominent unverified banner (EN+ZH)", skill.includes("草稿未验证") && skill.includes("UNVERIFIED DRAFT"), "");
    check("safety boundaries section present", skill.includes("Safety boundaries") && skill.includes("whitelist"), "");
    check("raw session reference preserved", skill.includes("fastcua-recording/1") && skill.includes("session.jsonl"), "");
    check("parameters table includes the date param", skill.includes(`{{${dateParam?.name}}}`), "");
    check("skill file contains no secret", !skill.includes("s3cret"), "");
    check("skill draft folder is inert (no runnable code files)",
      fs.readdirSync(path.dirname(skillFile)).every((f) => f === "SKILL.md"),
      fs.readdirSync(path.dirname(skillFile)).join(","));

    // ---------------- dry-run (stage 5) ----------------
    log("--- stage 5: dry-run through the normal control plane ---");
    const DRYRUN = path.join(ROOT, "tools", "skill-recorder", "dryrun.mjs");
    const draftPath = path.join(recDir, "draft.json");
    const draftObj = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    check("draft carries recorded app scope",
      draftObj.scope?.apps?.some((a) => /FastCuaFixture\.exe$/i.test(a)), JSON.stringify(draftObj.scope));
    check("actionable steps carry per-step app identity",
      draftObj.steps.filter((s) => ["click", "type"].includes(s.action)).every((s) => /FastCuaFixture\.exe$/i.test(s.app || "")),
      draftObj.steps.filter((s) => ["click", "type"].includes(s.action)).map((s) => `${s.n}:${(s.app || "?").split("\\").pop()}`).join(","));

    const runDry = (label, draftFile, extraArgs, reportName) => {
      const reportPath = path.join(temp, reportName);
      const r = spawnSync(process.execPath, [DRYRUN, draftFile, "--pipe", pipe, "--report", reportPath, ...extraArgs],
        { encoding: "utf8", timeout: 120_000 });
      const tail = (r.stdout || "").trim().split("\n").slice(-2).join(" | ");
      log(`dryrun[${label}] exit=${r.status} ${tail}${r.stderr ? " ERR:" + String(r.stderr).slice(-160) : ""}`);
      const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
      return { status: r.status, report };
    };
    const PARAMS = JSON.stringify({ date: "2026-08-01" }); // different from the recorded 2026-07-23
    const decisionsPath = path.join(temp, "decisions.json");
    fs.writeFileSync(decisionsPath, JSON.stringify({ session: "acknowledge", default: "proceed" }));

    // 5.0 Restart the fixture: anchors must re-resolve against NEW hwnds.
    taskkillImage("FastCuaFixture.exe");
    await sleep(400);
    await client.request("launch_app", { app: FIXTURE });
    let liveWindow = await waitForWindow(client, (w) => w.title === "FastCUA Host Test Fixture", "fixture (restarted)");
    check("fixture restarted with a fresh hwnd", liveWindow.id !== fixtureWindow.id, `${fixtureWindow.id} -> ${liveWindow.id}`);
    const liveTree = async () =>
      (await client.request("get_window_state", { window: liveWindow, include_screenshot: false, include_text: true }))?.accessibility?.tree || "";

    // 5.1 No decisions => pre-flight pause; nothing executes.
    const pre = runDry("pre-flight", draftPath, ["--params", PARAMS], "dryrun-pre.json");
    check("dry-run pauses without explicit decisions (exit 3)", pre.status === 3, `exit=${pre.status}`);
    check("pre-flight lists needed decisions and executes nothing",
      pre.report?.needs_decision?.length >= 1 && (pre.report?.steps || []).length === 0,
      `${pre.report?.needs_decision?.length} decision(s) needed`);
    const treeAfterPre = await liveTree();
    check("fixture untouched by refused dry-run",
      treeAfterPre.includes("Clicks: 0") && treeAfterPre.includes("Text: initial-value"), "");

    // 5.2 Happy path: explicit decisions + NEW parameter value, fresh app instance.
    const ok = runDry("happy", draftPath, ["--params", PARAMS, "--decisions", decisionsPath], "dryrun-ok.json");
    check("dry-run replays with explicit decisions (exit 0)", ok.status === 0, `exit=${ok.status}`);
    const okSteps = ok.report?.steps || [];
    const executed = okSteps.filter((s) => s.status === "ok");
    check("every executed step logs expected-vs-actual",
      executed.length >= 3 && executed.every((s) => s.expected && s.actual), `${executed.length} executed`);
    check("anchors re-resolved after app restart via automation_id",
      executed.filter((s) => s.actual?.matched_by === "automation_id").length >= 2,
      executed.map((s) => `${s.n}:${s.actual?.matched_by}`).join(","));
    const typed = okSteps.find((s) => s.action === "type" && s.status === "ok");
    check("parameter substitution replayed a NEW value (value assertion passed)",
      typed?.expected?.value === "initial-valuereport-2026-08-01" && typed?.actual?.value === "initial-valuereport-2026-08-01"
        && !JSON.stringify(typed).includes("2026-07-23"), JSON.stringify(typed?.actual));
    check("redacted password step skipped and never executed",
      okSteps.some((s) => s.status === "skipped-redacted"), "");
    // App-side final state: re-read the field value through the daemon.
    const treeNow = await liveTree();
    const editIndex = Number(/^\s*(\d+)\s+Edit #1002\b/m.exec(treeNow)?.[1]);
    check("tree exposes automation ids (restart-stable keys)", editIndex > 0, `index=${editIndex}`);
    await client.request("click", { window: liveWindow, element_index: editIndex });
    await sleep(300);
    const finalState = await client.request("get_window_state", { window: liveWindow, include_screenshot: false, include_text: true });
    check("final state correct: substituted value committed in the app",
      finalState?.accessibility?.focused_value === "initial-valuereport-2026-08-01",
      JSON.stringify(finalState?.accessibility?.focused_value));
    check("final state correct: button step clicked (Clicks: 1)",
      (finalState?.accessibility?.tree || "").includes("Clicks: 1"), "");

    // 5.3 Scope drill: a step outside the recorded app scope is refused outright.
    const scopeDraft = path.join(temp, "draft-scope.json");
    const scopeObj = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    scopeObj.steps.push({
      n: 99, ts: Date.now(), action: "click", app: "C:\\Windows\\System32\\notepad.exe",
      button: "left", x: 1, y: 1,
      anchor: { role: "Button", control_type: 50000, name: "whatever", value_class: "action" }, warnings: [],
    });
    fs.writeFileSync(scopeDraft, JSON.stringify(scopeObj, null, 2));
    const scoped = runDry("scope", scopeDraft, ["--params", PARAMS, "--decisions", decisionsPath], "dryrun-scope.json");
    check("out-of-scope step refused before any execution (exit 4)",
      scoped.status === 4 && scoped.report?.steps?.some((s) => s.status === "scope-violation"), `exit=${scoped.status}`);
    check("scope refusal is pre-execution (no step ran)",
      (scoped.report?.steps || []).every((s) => s.status === "scope-violation"), "");
    const windowsAfterScope = await client.request("list_windows");
    check("no out-of-scope app was launched or touched",
      !windowsAfterScope.some((w) => /notepad/i.test(w.app || "")), "");

    // 5.4 Negative drill: an anchor that cannot resolve must fail safe, never click wrong.
    taskkillImage("FastCuaFixture.exe");
    await sleep(400);
    await client.request("launch_app", { app: FIXTURE });
    liveWindow = await waitForWindow(client, (w) => w.title === "FastCUA Host Test Fixture", "fixture (fresh for negative drill)");
    const badDraft = path.join(temp, "draft-badanchor.json");
    const badObj = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    const buttonStep = badObj.steps.find((s) => s.action === "click" && s.anchor?.control_type === 50000);
    buttonStep.anchor.role = "CheckBox"; // role the fixture simply does not have
    buttonStep.anchor.control_type = 50002;
    buttonStep.anchor.automation_id = "9999";
    fs.writeFileSync(badDraft, JSON.stringify(badObj, null, 2));
    const bad = runDry("bad-anchor", badDraft, ["--params", PARAMS, "--decisions", decisionsPath], "dryrun-bad.json");
    check("unresolvable anchor fails safe (exit 4)",
      bad.status === 4 && bad.report?.steps?.some((s) => s.status === "anchor-unresolved" && /FAIL SAFE/.test(s.detail || "")),
      `exit=${bad.status}`);
    check("run aborted at the broken step (later steps never ran)",
      bad.report.steps.every((s) => s.status !== "ok" || s.n < buttonStep.n), "");
    const treeAfterBad = await liveTree();
    check("corrupted step did NOT click anywhere (Clicks stays 0)", treeAfterBad.includes("Clicks: 0"), "");

    // 5.5 Control-plane drill: pause must halt a replay mid-run, never retried.
    // NOTE: daemon pause kills the helper process tree as the cancellation
    // boundary — and the fixture is the helper's launch_app child, so it dies
    // with it. State-unchanged is therefore proven by the replay report
    // itself (zero executed steps), not by a post-pause tree read.
    await apiJson(base, "/api/action", { action: "pause" });
    const paused = runDry("paused", draftPath, ["--params", PARAMS, "--decisions", decisionsPath], "dryrun-paused.json");
    check("control-plane pause halts replay without retry (exit 5)",
      paused.status === 5 && paused.report?.outcome === "control-plane"
        && JSON.stringify(paused.report).includes("control_plane:paused"), `exit=${paused.status}`);
    check("paused replay executed zero steps (no state change possible)",
      paused.report?.summary?.executed_ok === 0, JSON.stringify(paused.report?.summary));
    await apiJson(base, "/api/action", { action: "resume" });

    // ---------------- packaging ----------------
    log("--- packaging: standalone skill + docs ---");
    const pkgSkillPath = path.join(ROOT, "skills", "skill-recorder", "SKILL.md");
    check("packaged skill exists", fs.existsSync(pkgSkillPath), pkgSkillPath);
    const pkg = fs.readFileSync(pkgSkillPath, "utf8");
    check("packaged skill frontmatter (name + description)",
      /^---\r?\nname: skill-recorder\r?\ndescription: .+\r?\n---/.test(pkg), "");
    check("packaged skill carries safety invariants",
      ["secure desktop", "never installs itself", "scope", "unresolved", "Ctrl+Alt+N"].every((t) => pkg.toLowerCase().includes(t.toLowerCase())), "");
    check("skill cli reference exists", fs.existsSync(path.join(ROOT, "skills", "skill-recorder", "docs", "cli.md")), "");
    const readmeText = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const readmeZhText = fs.readFileSync(path.join(ROOT, "README_zh.md"), "utf8");
    check("README documents Record a Skill (EN+ZH synced)",
      /Record a Skill/i.test(readmeText) && /录制技能/.test(readmeZhText), "");
    const issueDraft = fs.readFileSync(path.join(ROOT, "docs", "issue-3-comment-draft.md"), "utf8");
    check("issue #3 comment draft reports stages 2-5", /stages 2-5/i.test(issueDraft) && /dry-run/i.test(issueDraft), "");

    const failed = results.filter((entry) => !entry.ok);
    log(`=== ${results.length - failed.length}/${results.length} skill-recorder validation checks passed ===`);
    if (failed.length) throw new Error("validation failures: " + failed.map((f) => f.name).join("; "));
    client.close();
    await apiJson(base, "/api/action", { action: "shutdown" });
    await sleep(500);
    log("session kept at:", recDir);
    log("log:", LOG_PATH);
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  log("FATAL", error.stack || error.message);
  log("=== validation FAILED ===");
  process.exitCode = 1;
});
