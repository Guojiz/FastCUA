// Office end-to-end suite — FastCUA issue #3, real-machine round.
//
// Full loop against REAL Microsoft Excel, all through the FastCUA daemon
// control plane (temp config via FASTCUA_CONFIG_PATH; repo config untouched):
//   1. RECORD:  start page -> 空白工作簿 -> 3 narration notes (Ctrl+Alt+N) ->
//      expense table 项目/金额 x3 rows -> =SUM(B2:B3) total -> F12 save-as
//      xlsx with a date-stamped filename -> Ctrl+Alt+X stop.
//   2. COMPILE: session.jsonl -> draft (DataItem cell anchors, departed
//      value snapshots, typed-text parameters).
//   3. DRY-RUN: kill + relaunch Excel, replay the draft with DIFFERENT
//      parameter values through the normal control plane.
//   4. ASSERT:  read the replayed xlsx with openpyxl (managed Python) and
//      verify the NEW values are really in the cells.
//
// Usage: node tests/office-demo-e2e.mjs
// Exit 0 = all checks passed. Artifacts stay under %TEMP%\fastcua-office-e2e-*.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CUA_BIN = path.join(ROOT, "native-host", "target", "release", "cua-native-host.exe");
const RECORDER = path.join(ROOT, "tools", "skill-recorder", "target", "release", "skill-recorder.exe");
const COMPILE = path.join(ROOT, "tools", "skill-recorder", "compile.mjs");
const DRYRUN = path.join(ROOT, "tools", "skill-recorder", "dryrun.mjs");
const EXCEL = "C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE";
const SAVE_DIR = "C:\\Users\\Administrator\\AppData\\Local\\Temp\\fastcua-office-demo";
const SAVE_DATE = "2026-07-23";
const SAVE_PATH = path.join(SAVE_DIR, `report-${SAVE_DATE}.xlsx`);
const REPLAY_DATE = "2026-08-01";
const REPLAY_PATH = path.join(SAVE_DIR, `report-${REPLAY_DATE}.xlsx`);
// recorded observed value -> replay value (cell-by-cell must stay consistent:
// the total replays as a literal because UIA exposes only the SUM's result).
const REPLAY_VALUES = new Map([
  ["项目", "用品"], ["金额", "费用"],
  ["差旅", "交通"], ["1200", "5600"],
  ["餐饮", "住宿"], ["340", "400"],
  ["合计", "总计"], ["1540", "6000"],
  [SAVE_DATE, REPLAY_DATE],
]);
const EXPECT_CELLS = { A1: "用品", B1: "费用", A2: "交通", B2: 5600, A3: "住宿", B3: 400, A4: "总计", B4: 6000 };
const stamp = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let DUMP_DIR = "";
let failures = 0;
function dumpTree(name, tree) { try { if (DUMP_DIR) fs.writeFileSync(path.join(DUMP_DIR, name), tree); } catch {} }
function taskkillImage(image) { try { execFileSync("taskkill.exe", ["/IM", image, "/F"], { stdio: "ignore" }); } catch {} }
function log(...args) { console.log(`[office-e2e ${new Date().toISOString().slice(11, 19)}]`, ...args); }
function check(name, condition, detail = "") {
  if (condition) { console.log(`PASS ${name}`, detail); return; }
  failures += 1;
  console.log(`FAIL ${name}`, detail);
}
// Wipe Excel's crash-recovery store so no 文档恢复 pane/dialog can appear.
// (Only AutoRecover caches + the Resiliency registry flag — no documents.)
function wipeExcelRecovery() {
  try {
    const xr = path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Excel");
    for (const e of fs.readdirSync(xr, { withFileTypes: true })) {
      const p = path.join(xr, e.name);
      if (e.isDirectory() && /unsaved|recovery/i.test(e.name)) fs.rmSync(p, { recursive: true, force: true });
      else if (e.isFile() && /\.(xlsb|ar|xlb)$/i.test(e.name)) fs.rmSync(p, { force: true });
    }
    try { execFileSync("reg.exe", ["delete", "HKCU\\Software\\Microsoft\\Office\\16.0\\Excel\\Resiliency", "/f"], { stdio: "ignore" }); } catch {}
    return true;
  } catch (e) { log("WARN: recovery store wipe failed:", String(e.message || e).slice(0, 120)); return false; }
}

class PipeClient {
  constructor(pipe) {
    this.nextId = 1; this.pending = new Map(); this.buffer = "";
    this.socket = net.connect(pipe); this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => {
      this.buffer += chunk; let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        const entry = this.pending.get(msg.id); if (!entry) continue;
        this.pending.delete(msg.id); clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error)); else entry.resolve(msg.result);
      }
    });
  }
  ready() { return new Promise((res, rej) => { this.socket.once("connect", res); this.socket.once("error", rej); }); }
  request(method, params = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`client-side timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() { try { this.socket.end(); } catch {} }
}
async function apiJson(base, route, body) {
  const response = await fetch(base + route, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const text = await response.text(); try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function waitForWindow(client, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await client.request("list_windows").catch(() => []);
    const found = (windows || []).find(predicate);
    if (found) return found;
    await sleep(400);
  }
  throw new Error(`window not found within ${timeoutMs}ms: ${label}`);
}

// Excel shows splash/loading titles before settling; require a stable title.
async function waitExcelWindow(client, predicate, label, timeoutMs = 30_000) {
  const cand = await waitForWindow(client, (w) => /excel/i.test(w.app || "") && predicate(w), label, timeoutMs);
  await sleep(1500);
  const windows = await client.request("list_windows");
  const settled = windows.find((w) => w.id === cand.id && predicate(w));
  if (!settled) return waitExcelWindow(client, predicate, label, 10_000);
  return settled;
}

async function getTree(client, win) {
  // Explicit 10s probe budget: the host's 1.5s default turns one slow
  // snapshot into a breaker strike, and two strikes session-disable UIA.
  const state = await client.request("get_window_state",
    { window: win, include_screenshot: false, include_text: true, uia_probe_ms: 10_000 }, 90_000);
  return state?.accessibility?.tree || "";
}

// Dismiss either Document Recovery surface:
//   * modal dialog ("Excel 已恢复下列文件…") -> pick "否，删除这些文件" + 确定
//     (deletes the recovery store so it never prompts again);
//   * task pane -> its 关闭 button.
// Retries until the tree is clean. Returns true when no recovery UI remains.
async function dismissRecovery(client, win, tag) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tree = await getTree(client, win);
    if (!/文档恢复|已自动恢复|Document Recovery/i.test(tree)) return true;
    const radioIdx = Number(/^\s*(\d+)\s+RadioButton[^\n]*删除这些文件/m.exec(tree)?.[1]);
    if (radioIdx) {
      await client.request("click", { window: win, element_index: radioIdx });
      await sleep(600);
      const tree2 = await getTree(client, win);
      const okIdx = Number(/^\s*(\d+)\s+Button[^\n]*确定/m.exec(tree2)?.[1]);
      if (okIdx) await client.request("click", { window: win, element_index: okIdx });
      await sleep(1500);
      log(`recovery modal dismissed (${tag}): 删除这些文件 + 确定`);
      continue;
    }
    const lines = tree.split("\n");
    const recIdx = lines.findIndex((l) => /文档恢复|Document Recovery/i.test(l));
    let clicked = false;
    for (let i = recIdx; i >= 0 && i < Math.min(lines.length, recIdx + 20); i++) {
      if (!/Button/.test(lines[i]) || !/关闭|Close/i.test(lines[i])) continue;
      const idx = Number(/^\s*(\d+)\s/.exec(lines[i])?.[1]);
      if (!idx) continue;
      await client.request("click", { window: win, element_index: idx });
      await sleep(1200);
      log(`recovery pane closed (${tag}) via element ${idx}`);
      clicked = true;
      break;
    }
    if (!clicked) {
      log(`WARN: recovery UI present (${tag}) but no dismiss control found; tolerated`);
      dumpTree(`tree-recovery-${tag}.txt`, tree);
      return false;
    }
  }
  const clean = !/文档恢复|已自动恢复|Document Recovery/i.test(await getTree(client, win));
  if (!clean) log(`WARN: recovery UI still present after 3 attempts (${tag})`);
  return clean;
}

async function type(client, win, text, settleMs = 800) {
  await client.request("type_text", { window: win, text });
  await sleep(settleMs);
}
async function key(client, win, k, settleMs = 500) {
  await client.request("press_key", { window: win, key: k });
  await sleep(settleMs);
}
async function note(client, anchorWindow, text) {
  await client.request("press_key", { window: anchorWindow, key: "Control_L+Alt_L+n" });
  const noteWindow = await waitForWindow(client, (w) => /skill recorder note/i.test(w.title || ""), "recorder note window", 6_000);
  await sleep(500);
  await client.request("type_text", { window: noteWindow, text });
  await sleep(400);
  await client.request("press_key", { window: noteWindow, key: "Return" });
  await sleep(700);
  log(`note recorded: ${text}`);
}

// One daemon = one native-host process = one UIA provider health table. The
// replay phase gets a FRESH daemon (like the fixture validation suite) so a
// provider timeout during recording cannot blind the replay. Each daemon also
// gets its OWN config directory: daemon.mjs persists the uia-profile
// (known-bad app list) next to the config file, so a shared config leaks
// recording-phase provider stalls into the replay.
const daemons = [];
async function startDaemon(homeDir, pipe, configObj) {
  fs.mkdirSync(homeDir, { recursive: true });
  const configPath = path.join(homeDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(configObj, null, 2));
  const portServer = net.createServer();
  await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
  const port = portServer.address().port;
  await new Promise((r) => portServer.close(r));
  const base = `http://127.0.0.1:${port}`;
  const daemon = spawn(process.execPath, [path.join(ROOT, "daemon.mjs")], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    env: { ...process.env, CUA_BIN, FASTCUA_PIPE: pipe, FASTCUA_HTTP_PORT: String(port), FASTCUA_CONFIG_PATH: configPath, FASTCUA_DISABLE_OVERLAY: "1", FASTCUA_HOME: homeDir },
  });
  let errBuf = "";
  daemon.stderr.on("data", (d) => { errBuf = (errBuf + d).slice(-2_000); });
  daemons.push(daemon);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { try { await apiJson(base, "/api/state"); ready = true; } catch { await sleep(100); } }
  if (!ready) throw new Error("daemon did not become ready");
  const client = new PipeClient(pipe);
  await client.ready();
  return { daemon, base, pipe, client, stderrTail: () => errBuf.trim() };
}

async function main() {
  if (!fs.existsSync(CUA_BIN)) throw new Error("native host not built: " + CUA_BIN);
  if (!fs.existsSync(RECORDER)) throw new Error("recorder not built: " + RECORDER);
  taskkillImage("EXCEL.EXE");
  taskkillImage("skill-recorder.exe");
  await sleep(800);
  wipeExcelRecovery();
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  try { fs.unlinkSync(SAVE_PATH); } catch {}
  try { fs.unlinkSync(REPLAY_PATH); } catch {}

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-office-demo-"));
  DUMP_DIR = temp;
  const recDir = path.join(temp, "session");
  const daemonConfig = {
    costartMode: "manual", idleTimeoutMin: 0, approvalPolicy: "safe",
    whitelist: ["EXCEL.EXE", "skill-recorder.exe"], port: 8425,
    bannerEnabled: false, overlayEnabled: false,
    overlayTitle: "office-demo", overlayLanguage: "auto", cuaBinPath: "",
  };

  const recorder = spawn(RECORDER, [
    "--out", recDir,
    "--duration-ms", "300000",
    "--keyframe-interval", "20",
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  let recOut = ""; let recErr = "";
  recorder.stdout.on("data", (d) => { recOut += d; });
  recorder.stderr.on("data", (d) => { recErr += d; });
  const recorderExit = new Promise((resolve) => recorder.once("exit", resolve));

  const cleanup = () => { for (const d of daemons) { try { d.kill(); } catch {} } try { recorder.kill(); } catch {} taskkillImage("skill-recorder.exe"); taskkillImage("EXCEL.EXE"); };

  try {
    const A = await startDaemon(path.join(temp, "home-a"), `\\\\.\\pipe\\fastcua-office-a-${stamp}`, daemonConfig);
    const client = A.client;
    await sleep(600); // let the recorder install hooks + hotkeys

    // ---- recording: expense-table workflow --------------------------
    log("--- recording expense-table workflow ---");
    await client.request("launch_app", { app: EXCEL }, 60_000);
    // Excel may open the start page ("Excel") or restore a workbook directly.
    let startWin = null;
    try {
      startWin = await waitExcelWindow(client,
        (w) => /^Excel$/.test((w.title || "").trim()) && !/正在打开|Starting/i.test(w.title || ""), "Excel start page", 45_000);
    } catch {
      log("start page not seen; checking for a directly-opened workbook");
    }
    if (startWin) await dismissRecovery(client, startWin, "start page");

    if (startWin) {
      let blankIdx = 0;
      for (let i = 0; i < 30 && !blankIdx; i++) {
        const tree0 = await getTree(client, startWin);
        blankIdx = Number(/^\s*(\d+)\s+ListItem 空白工作簿/m.exec(tree0)?.[1]);
        if (!blankIdx) await sleep(1_000);
        if (i === 29 && !blankIdx) dumpTree("tree-startpage.txt", tree0);
      }
      if (!blankIdx) throw new Error("空白工作簿 ListItem not found on start page (tree dumped to tree-startpage.txt)");
      await client.request("click", { window: startWin, element_index: blankIdx });
      log("clicked 空白工作簿");
    }
    const bookWin = await waitExcelWindow(client, (w) => /工作簿|Book/i.test(w.title || ""), "workbook window", 30_000);
    await sleep(2000);
    const cleanBook = await dismissRecovery(client, bookWin, "workbook");
    if (!cleanBook) log("WARN: proceeding with recovery UI possibly present");

    await note(client, bookWin, "意图：录入两列费用表（项目/金额）");

    // Row 1: headers. Tab from A1 -> B1, Return wraps to A2. Navigation
    // settles are deliberately slow: the recorder's focus poll must observe
    // the new cell BEFORE the next typed run starts, or compile misaligns
    // the typed text with the previous cell's anchor.
    await type(client, bookWin, "项目");
    await key(client, bookWin, "Tab", 1_200);
    await type(client, bookWin, "金额");
    await key(client, bookWin, "Return", 1_300);
    // Row 2.
    await type(client, bookWin, "差旅");
    await key(client, bookWin, "Tab", 1_200);
    await type(client, bookWin, "1200");
    await key(client, bookWin, "Return", 1_300);
    // Row 3.
    await type(client, bookWin, "餐饮");
    await key(client, bookWin, "Tab", 1_200);
    await type(client, bookWin, "340");
    await key(client, bookWin, "Return", 1_400);

    await note(client, bookWin, "金额列求和");

    // Row 4: total with a SUM formula.
    await type(client, bookWin, "合计");
    await key(client, bookWin, "Tab");
    await type(client, bookWin, "=SUM(B2:B3)");
    await key(client, bookWin, "Return", 2_200); // let the departed poll capture the computed value

    await note(client, bookWin, "另存为xlsx，文件名按日期参数化");

    // ---- save-as: F12 opens the classic dialog in this Excel build ----
    await dismissRecovery(client, bookWin, "before-save-as");
    await key(client, bookWin, "F12", 1_800);
    let saveDialog = null;
    try {
      saveDialog = await waitForWindow(client,
        (w) => /另存为|Save As/i.test(w.title || "") && /excel/i.test(w.app || ""), "classic save-as dialog", 8_000);
    } catch {
      // Backstage variant: click 浏览 (Browse) to reach the classic dialog.
      log("no classic dialog after F12; trying Backstage 浏览");
      const tree = await getTree(client, bookWin);
      fs.writeFileSync(path.join(temp, "tree-backstage.txt"), tree);
      const browseIdx = Number(/^\s*(\d+)\s+(?:Button|ListItem|Hyperlink)[^\n]*浏览/m.exec(tree)?.[1]);
      if (!browseIdx) throw new Error("save-as entry point not found (tree dumped to tree-backstage.txt)");
      await client.request("click", { window: bookWin, element_index: browseIdx });
      saveDialog = await waitForWindow(client,
        (w) => /另存为|Save As/i.test(w.title || "") && /excel/i.test(w.app || ""), "classic save-as dialog", 10_000);
    }
    await sleep(1_000);
    const dlgTree = await getTree(client, saveDialog);
    fs.writeFileSync(path.join(temp, "tree-saveas.txt"), dlgTree);
    const dlgLines = dlgTree.split("\n");
    let fileEditIdx = 0;
    for (const l of dlgLines) {
      if (!/^\s*\d+\s+Edit\s/.test(l)) continue;
      if (/#1001|文件名|File name/i.test(l)) { fileEditIdx = Number(/^\s*(\d+)\s/.exec(l)[1]); break; }
    }
    if (!fileEditIdx) fileEditIdx = Number(/^\s*(\d+)\s+Edit\s/m.exec(dlgTree)?.[1]) || 0;
    if (!fileEditIdx) throw new Error("filename Edit not found in save-as dialog (tree dumped to tree-saveas.txt)");
    await client.request("click", { window: saveDialog, element_index: fileEditIdx });
    await sleep(500);
    // ValuePattern SetValue can stall on the comdlg filename box (provider
    // timeout); select-all + plain caret typing is reliable here.
    await client.request("press_key", { window: saveDialog, key: "Control_L+a" });
    await sleep(300);
    await client.request("type_text", { window: saveDialog, text: SAVE_PATH, replace: false });
    // Long settle BEFORE Tab: the recorder's 1s focus heartbeat must snapshot
    // the COMPLETE path while the Edit is still focused. (The departed
    // re-read after Tab is best-effort — a comdlg provider stall can drop it.)
    await sleep(2_600);
    await client.request("press_key", { window: saveDialog, key: "Tab" });
    await sleep(1_600);
    // Click 保存 explicitly — Return could land on whatever control Tab chose.
    {
      const tree = await getTree(client, saveDialog);
      dumpTree("tree-saveas2.txt", tree);
      const saveIdx = Number(/^\s*(\d+)\s+Button[^\n]*保存\(/m.exec(tree)?.[1])
        || Number(/^\s*(\d+)\s+Button\s+保存\s*$/m.exec(tree)?.[1]);
      if (saveIdx) await client.request("click", { window: saveDialog, element_index: saveIdx });
      else await client.request("press_key", { window: saveDialog, key: "Return" });
    }
    log(`save-as submitted: ${SAVE_PATH}`);

    // The title flips to the saved file name once the save lands.
    let savedWin = null;
    for (let i = 0; i < 30 && !savedWin; i++) {
      await sleep(500);
      const windows = await client.request("list_windows").catch(() => []);
      savedWin = (windows || []).find((w) => /excel/i.test(w.app || "") && new RegExp(`report-${SAVE_DATE}`, "i").test(w.title || ""));
    }
    if (!savedWin) {
      const windows = await client.request("list_windows").catch(() => []);
      log("WARN: saved-title not observed; windows:", JSON.stringify((windows || []).map((w) => w.title)));
    } else {
      log(`saved workbook title observed: ${savedWin.title}`);
    }
    if (!fs.existsSync(SAVE_PATH)) throw new Error(`save-as did not produce ${SAVE_PATH}`);
    log("save-as file exists on disk ✓");

    // ---- stop recording via the injected emergency stop ---------------
    await client.request("press_key", { window: savedWin || bookWin, key: "Control_L+Alt_L+x" });
    await Promise.race([recorderExit, sleep(10_000)]);
    log("recorder stopped");

    // ---- session assertions -------------------------------------------
    const sessionFile = path.join(recDir, "session.jsonl");
    if (!fs.existsSync(sessionFile)) throw new Error("session.jsonl missing in " + recDir);
    const events = fs.readFileSync(sessionFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const notes = events.filter((e) => e.t === "note");
    const departed = events.filter((e) => e.t === "focus" && e.trigger === "departed" && e.uia?.value);
    const departedValues = departed.map((e) => e.uia.value);
    log(`session: events=${events.length} notes=${notes.length} departed-with-value=${departed.length}`);
    log("departed values:", JSON.stringify(departedValues));
    check("3 narration notes recorded", notes.length === 3, `notes=${notes.length}`);
    for (const want of ["项目", "金额", "差旅", "1200", "餐饮", "340", "合计", "1540"]) {
      check(`departed value captured: ${want}`, departedValues.includes(want));
    }
    const dupes = departedValues.filter((v, i) => v && departedValues.indexOf(v) !== i && v !== " ");
    check("no duplicate departed values (identity check holds)", dupes.length === 0, JSON.stringify(dupes));
    const mediaNote = events.find((e) => e.t === "media");
    if (mediaNote) log("media record:", JSON.stringify(mediaNote).slice(0, 300));
    if (recErr.trim()) log("recorder stderr tail:", recErr.trim().split("\n").slice(-3).join(" | "));

    // Recording done — shut daemon A down. The replay gets a FRESH daemon
    // (fresh native-host UIA provider-health table), mirroring the fixture
    // validation suite's restart-before-replay.
    client.close();
    await apiJson(A.base, "/api/action", { action: "shutdown" });
    await sleep(600);
    if (A.stderrTail()) log("daemon A stderr tail:", A.stderrTail().split("\n").slice(-4).join(" | "));

    // ---- compile ------------------------------------------------------
    log("--- compiling session to draft ---");
    const compiledDir = path.join(temp, "compiled");
    const comp = spawnSync(process.execPath, [COMPILE, sessionFile, "--skill", "excel-expense-report", "--out", compiledDir], { encoding: "utf8", timeout: 60_000 });
    process.stdout.write(comp.stdout || ""); if (comp.stderr) process.stderr.write(comp.stderr);
    check("compile exit 0", comp.status === 0, `status=${comp.status}`);
    const draftPath = path.join(compiledDir, "draft.json");
    const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
    const cellSteps = draft.steps.filter((s) => s.action === "type" && s.anchor?.role === "DataItem");
    const cellByAid = {};
    for (const s of cellSteps) {
      const param = draft.parameters.find((p) => `{{${p.name}}}` === s.text);
      cellByAid[s.anchor.automation_id] = param?.observed;
    }
    log("cell steps:", JSON.stringify(cellByAid));
    const EXPECT_CELLS_RECORDED = { A1: "项目", B1: "金额", A2: "差旅", B2: "1200", A3: "餐饮", B3: "340", A4: "合计", B4: "1540" };
    for (const [aid, want] of Object.entries(EXPECT_CELLS_RECORDED)) {
      check(`draft cell ${aid} = ${want}`, cellByAid[aid] === want, `got ${JSON.stringify(cellByAid[aid])}`);
    }
    const dateParam = draft.parameters.find((p) => p.kind === "date" || String(p.observed).includes(SAVE_DATE));
    check("save-date parameter inferred from the path", !!dateParam, JSON.stringify(dateParam || "").slice(0, 200));

    // ---- dry-run with DIFFERENT parameter values ----------------------
    log("--- dry-run with substituted parameters ---");
    taskkillImage("EXCEL.EXE");
    await sleep(1_000);
    wipeExcelRecovery();
    try { fs.unlinkSync(REPLAY_PATH); } catch {}
    const B = await startDaemon(path.join(temp, "home-b"), `\\\\.\\pipe\\fastcua-office-b-${stamp}`, daemonConfig);
    const clientB = B.client;
    await clientB.request("launch_app", { app: EXCEL }, 60_000);
    const dryStart = await waitExcelWindow(clientB,
      (w) => /^Excel$/.test((w.title || "").trim()) && !/正在打开|Starting/i.test(w.title || ""), "Excel start page (dry-run)", 45_000);
    // Wait until the start page has actually RENDERED its tiles — the window
    // title settles seconds before the UIA tree populates, and the replay's
    // first step clicks 空白工作簿.
    let startReady = false;
    for (let i = 0; i < 30 && !startReady; i++) {
      const tree = await getTree(clientB, dryStart);
      startReady = /ListItem 空白工作簿/.test(tree);
      if (!startReady) await sleep(1_000);
    }
    check("dry-run start page rendered (空白工作簿 in tree)", startReady);
    // No scratch-workbook warm-up: closing it would strand Excel on the
    // empty gray frame (no start page, step 1 can never resolve). The first
    // workbook snapshot is instead covered by the dry-run resolver's explicit
    // 20s per-request probe budget (daemon passthrough), which waits for UIA
    // materialization without tripping the host's default-timeout breaker —
    // proven by the warm-up experiment: one 20s probe, passive wait sufficed.
    const params = {};
    for (const p of draft.parameters) {
      if (REPLAY_VALUES.has(p.observed)) params[p.name] = REPLAY_VALUES.get(p.observed);
      else params[p.name] = p.observed;
    }
    log("replay params:", JSON.stringify(params));
    const paramsPath = path.join(temp, "params.json");
    const decisionsPath = path.join(temp, "decisions.json");
    const reportPath = path.join(temp, "dryrun-report.json");
    fs.writeFileSync(paramsPath, JSON.stringify(params, null, 2));
    // The session is 100% FastCUA-injected, so every step carries the
    // "injected input" ⚠ by design; acknowledge once, proceed everywhere.
    fs.writeFileSync(decisionsPath, JSON.stringify({ session: "acknowledge", default: "proceed" }, null, 2));
    const dry = spawnSync(process.execPath, [DRYRUN, draftPath, "--pipe", B.pipe, "--params", `@${paramsPath}`, "--decisions", decisionsPath, "--report", reportPath],
      { encoding: "utf8", timeout: 240_000 });
    process.stdout.write((dry.stdout || "").slice(-3000)); if (dry.stderr) process.stderr.write(dry.stderr.slice(-1500));
    check("dry-run exit 0 (all steps replayed)", dry.status === 0, `status=${dry.status}`);
    if (fs.existsSync(reportPath)) {
      const rep = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      log("dry-run report:", JSON.stringify(rep.summary || rep.outcome || rep).slice(0, 400));
      // Regression guard on the input-path selection (root-caused this
      // chunk): DataItem cell steps must replay via caret-typing (SetValue is
      // vacuous on Excel cells), and the save-as path Edit — whose recorded
      // flow has an explicit Ctrl+A — must also go caret, not set-value.
      const cellStep = (rep.steps || []).find((s) => s.expected?.automation_id === "A1" && s.action === "type");
      const pathStep = (rep.steps || []).find((s) => s.expected?.automation_id === "1001" && s.action === "type");
      check("cell steps replay via caret-typing (not SetValue)", /caret-typing/.test(cellStep?.detail || ""), (cellStep?.detail || "").slice(0, 120));
      check("save-path Edit replays via caret-typing (recorded Ctrl+A)", /caret-typing/.test(pathStep?.detail || ""), (pathStep?.detail || "").slice(0, 120));
    }
    // The save click is fire-and-forget for the runner: poll for the file,
    // and if it never lands, capture every Excel window tree so we can see
    // WHICH dialog ate the save (confirm-overwrite, error, backstage nag).
    let replaySaved = fs.existsSync(REPLAY_PATH);
    for (let i = 0; i < 15 && !replaySaved; i++) { await sleep(1_000); replaySaved = fs.existsSync(REPLAY_PATH); }
    if (!replaySaved) {
      const ws = await clientB.request("list_windows").catch(() => []);
      for (const w of (ws || []).filter((x) => /excel/i.test(x.app || ""))) {
        const st = await clientB.request("get_window_state",
          { window: w, include_screenshot: false, include_text: true, uia_probe_ms: 10_000 }, 30_000).catch(() => null);
        dumpTree(`tree-after-save-${w.id}.txt`, (st?.accessibility?.tree || "(no tree)"));
        log(`post-save window dump: ${w.id} "${w.title}"`);
      }
    }
    check("replayed xlsx saved under the NEW date name", replaySaved, REPLAY_PATH);

    // ---- assert the replayed document really holds the NEW values -----
    if (fs.existsSync(REPLAY_PATH)) {
      const pyScript = path.join(temp, "assert-xlsx.py");
      fs.writeFileSync(pyScript, [
        "import json, sys",
        "from openpyxl import load_workbook",
        `wb = load_workbook(r"${REPLAY_PATH}")`,
        "ws = wb.active",
        `expect = ${JSON.stringify(EXPECT_CELLS)}`,
        "got = {k: ws[k].value for k in expect}",
        "bad = {k: (got[k], v) for k, v in expect.items() if str(got[k]) != str(v)}",
        "print(json.dumps({'got': {k: str(v) for k, v in got.items()}, 'mismatches': {k: [str(a), str(b)] for k, (a, b) in bad.items()}}, ensure_ascii=False))",
        "sys.exit(1 if bad else 0)",
      ].join("\n"), "utf8");
      const py = spawnSync("python", [pyScript], { encoding: "utf8", timeout: 60_000 });
      process.stdout.write((py.stdout || "").trim() + "\n");
      check("replayed xlsx contains the NEW parameter values in A1:B4", py.status === 0, (py.stdout || py.stderr || "").trim().slice(0, 400));
    }

    clientB.close();
    await apiJson(B.base, "/api/action", { action: "shutdown" });
    await sleep(400);
    if (B.stderrTail()) log("daemon B stderr tail:", B.stderrTail().split("\n").slice(-4).join(" | "));
    log(`ARTIFACTS=${temp}`);
    if (failures) { log(`=== office-demo-e2e FAILED (${failures} checks) ===`); process.exitCode = 1; }
    else log("=== office-demo-e2e: all checks passed ===");
  } finally { cleanup(); }
}
main().catch((e) => { console.error("FATAL", e); process.exitCode = 1; });
