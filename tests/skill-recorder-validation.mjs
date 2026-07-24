// SPDX-License-Identifier: MIT
//
// Real-machine validation for FastCUA issue #3 stages 2-5 (skill-recorder).
//
// Records a REAL demonstration session on this machine:
//   FastCuaFixture: click edit -> type "report-2026-07-23" -> note via
//   Ctrl+Alt+N dialog -> type into password box (redaction) -> click button ->
//   second note -> Ctrl+Alt+X emergency stop.
// All demo input is FastCUA-injected (unattended machine): the recorder must
// LABEL it injected, the compiler must flag it ⚠ unresolved, and the narration
// notes (also injected, into the recorder's own dialog) must still be accepted
// while the dialog's own keystrokes stay OUT of the demo stream.
// Then compiles the session and asserts evidence + dedicated-writer contracts,
// the media tracks (MJPEG AVI + frame index + best-effort WAV), the
// frame-extract review aid (including the redaction gate), and the gated
// promotion tool (refusals, forced unverified copy, overwrite).
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

function buildCargoRelease(label, cwd) {
  log(`building ${label} from the authoritative repo source (cargo build --release --offline)...`);
  const cargo = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
  execFileSync(cargo, ["build", "--release", "--offline"], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PATH: path.join(os.homedir(), ".cargo", "bin") + ";" + process.env.PATH },
  });
}

function buildRecorder() {
  buildCargoRelease("skill-recorder", path.join(ROOT, "tools", "skill-recorder"));
}

function buildNativeHost() {
  buildCargoRelease("native host", path.join(ROOT, "native-host"));
}

async function main() {
  if (!fs.existsSync(FIXTURE)) throw new Error("fixture not built: " + FIXTURE);
  buildNativeHost();
  buildRecorder();
  if (!fs.existsSync(CUA_BIN)) throw new Error("native host not built: " + CUA_BIN);
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
    const pwStart = Date.now();
    await client.request("click", { window: fixtureWindow, element_index: editIndexes[2] });
    await sleep(500);
    await client.request("type_text", { window: fixtureWindow, text: "s3cret!" });
    await sleep(800);
    const pwEnd = Date.now();

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

    // ---------------- media tracks: video (stage 5) ----------------
    log("--- media: MJPEG video track + frame index ---");
    check("header declares media layout", header?.media?.video === "video/video.avi"
      && header?.media?.video_index === "video/index.jsonl"
      && "audio" in (header?.media || {}), JSON.stringify(header?.media));
    check("stats carry media counters",
      stats && typeof stats.video_frames === "number" && typeof stats.video_bytes === "number"
        && typeof stats.video_gaps === "number" && typeof stats.audio_bytes === "number",
      `video_frames=${stats?.video_frames} video_bytes=${stats?.video_bytes} video_gaps=${stats?.video_gaps} audio_bytes=${stats?.audio_bytes}`);

    const aviPath = path.join(recDir, "video", "video.avi");
    const indexPath = path.join(recDir, "video", "index.jsonl");
    check("video.avi + index.jsonl exist", fs.existsSync(aviPath) && fs.existsSync(indexPath), "");
    const avi = fs.readFileSync(aviPath);
    const indexLines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } });
    check("every index line parses", indexLines.every(Boolean), `${indexLines.filter(Boolean).length}/${indexLines.length}`);
    const idxHeader = indexLines.find((e) => e?.t === "video-index");
    const idxFooter = indexLines.find((e) => e?.t === "video-footer");
    const idxFrames = indexLines.filter((e) => e?.kind === "frame");
    const idxGaps = indexLines.filter((e) => (e?.kind || "").startsWith("redacted-gap"));
    check("video index header (format + geometry, long edge <= 1568, even)",
      idxHeader?.format === "fastcua-video-index/1" && idxHeader.width > 0 && idxHeader.height > 0
        && Math.max(idxHeader.width, idxHeader.height) <= 1568
        && idxHeader.width % 2 === 0 && idxHeader.height % 2 === 0,
      JSON.stringify(idxHeader));
    check("video index footer frame total matches entries",
      idxFooter && idxFooter.frames === idxFrames.length + idxGaps.length,
      `footer=${idxFooter?.frames} entries=${idxFrames.length + idxGaps.length}`);
    check("video captured a useful number of frames",
      idxFrames.length >= 20, `${idxFrames.length} frames + ${idxGaps.length} gaps over ${(minutes).toFixed(2)} min`);

    // AVI structure: RIFF/AVI, hdrl/movi lists, MJPG stream, idx1 == AVI frames.
    const asciiAt = (buf, off, n) => buf.subarray(off, off + n).toString("latin1");
    const findChunk = (buf, fourcc) => buf.indexOf(fourcc, 0, "latin1");
    check("AVI RIFF container", asciiAt(avi, 0, 4) === "RIFF" && asciiAt(avi, 8, 4) === "AVI ", `${avi.length} bytes`);
    check("AVI has hdrl/movi/idx1 structure",
      findChunk(avi, "hdrl") > 0 && findChunk(avi, "movi") > 0 && findChunk(avi, "idx1") > 0, "");
    check("AVI stream is MJPG", findChunk(avi, "MJPG") > 0, "");
    const avihPos = findChunk(avi, "avih");
    const avihTotal = avihPos > 0 ? avi.readUInt32LE(avihPos + 8 + 16) : 0;
    const idx1Pos = findChunk(avi, "idx1");
    const idx1Count = idx1Pos > 0 ? avi.readUInt32LE(idx1Pos + 4) / 16 : 0;
    const aviFrameEntries = idxFrames.length + idxGaps.filter((g) => g.kind === "redacted-gap").length;
    check("avih total frames == idx1 entries == indexed AVI frames",
      avihTotal > 0 && idx1Count === avihTotal && avihTotal === aviFrameEntries,
      `avih=${avihTotal} idx1=${idx1Count} indexed=${aviFrameEntries}`);
    const videoBytesPerMin = (stats?.video_bytes || 0) / minutes;
    check("video cost < 30 MB/min (MJPEG sanity budget)", videoBytesPerMin > 0 && videoBytesPerMin < 30_000_000,
      `${(videoBytesPerMin / 1_000_000).toFixed(2)} MB/min (${(stats?.video_bytes / 1000 || 0).toFixed(0)} KB total, ${idxHeader?.width}x${idxHeader?.height})`);

    // Redaction gaps: password focus produced marked gaps inside the window.
    const pwGaps = idxGaps.filter((g) => g.reason === "password-focus"
      && g.ts >= pwStart - 2_000 && g.ts <= pwEnd + 4_000);
    check("password focus produced marked video gaps (never pixels)",
      pwGaps.length >= 1 && idxGaps.every((g) => ["password-focus", "secure-desktop"].includes(g.reason)),
      `${pwGaps.length} password-focus gap(s) in window, ${idxGaps.length} total`);
    check("gap stats counter consistent", (stats?.video_gaps || 0) >= pwGaps.length, `video_gaps=${stats?.video_gaps}`);

    // ---------------- media tracks: audio (stage 5) ----------------
    log("--- media: WAV narration track (best-effort) ---");
    const wavPath = path.join(recDir, "audio", "narration.wav");
    const mediaRecs = events.filter((e) => e?.t === "media");
    const audioRec = mediaRecs.find((e) => e.kind === "audio");
    check("audio availability declared via t:media record", audioRec && ["ok", "unavailable"].includes(audioRec.status),
      JSON.stringify(audioRec));
    if (fs.existsSync(wavPath)) {
      const wav = fs.readFileSync(wavPath);
      const fmtPos = wav.indexOf("fmt ", 0, "latin1");
      const dataPos = wav.indexOf("data", 0, "latin1");
      const channels = fmtPos > 0 ? wav.readUInt16LE(fmtPos + 10) : 0;
      const sampleRate = fmtPos > 0 ? wav.readUInt32LE(fmtPos + 12) : 0;
      const bits = fmtPos > 0 ? wav.readUInt16LE(fmtPos + 22) : 0;
      const dataBytes = dataPos > 0 ? wav.readUInt32LE(dataPos + 4) : 0;
      const wavSeconds = dataBytes / (sampleRate * channels * (bits / 8));
      const sessionSeconds = (last - first) / 1000;
      check("WAV is RIFF/WAVE PCM 16kHz mono 16-bit",
        asciiAt(wav, 0, 4) === "RIFF" && asciiAt(wav, 8, 4) === "WAVE"
          && wav.readUInt16LE(fmtPos + 8) === 1 && channels === 1 && sampleRate === 16000 && bits === 16,
        `fmt=${wav.readUInt16LE(fmtPos + 8)} ch=${channels} rate=${sampleRate} bits=${bits}`);
      check("WAV duration tracks the session (±3s)", Math.abs(wavSeconds - sessionSeconds) <= 3,
        `wav=${wavSeconds.toFixed(1)}s session=${sessionSeconds.toFixed(1)}s`);
      check("audio bytes counter consistent", (stats?.audio_bytes || 0) > 0, `audio_bytes=${stats?.audio_bytes}`);
      log("audio path validated: microphone present, real WAV captured");
    } else {
      check("no microphone: graceful degradation (unavailable record + no WAV, session intact)",
        audioRec?.status === "unavailable" && typeof audioRec?.detail === "string" && audioRec.detail.length > 0,
        audioRec?.detail || "");
      check("audio bytes counter zero on unavailable path", (stats?.audio_bytes || 0) === 0, `audio_bytes=${stats?.audio_bytes}`);
      log("audio path validated: NO microphone on this machine — graceful-degradation path");
    }

    // ---------------- compile (stage 3) ----------------
    log("--- compiling session to evidence + synthesis request ---");
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

    // ---------------- evidence -> dedicated writer contract (stage 4) ----------------
    const evidencePath = path.join(recDir, "evidence.json");
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    check("canonical evidence package generated",
      evidence.format === "fastcua-skill-evidence/1" && evidence.executable === false, evidence.format);
    const requestFile = path.join(recDir, "skill-draft", "fixture-report", "synthesis-request.json");
    check("--skill writes a dedicated-subagent synthesis request", fs.existsSync(requestFile), requestFile);
    const request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
    check("synthesis request points to evidence and future SKILL.md",
      request.writer === "dedicated-subagent" && /evidence\.json$/i.test(request.evidence)
        && /SKILL\.md$/i.test(request.output), JSON.stringify(request));
    const skillFile = path.join(recDir, "skill-draft", "fixture-report", "SKILL.md");
    check("mechanical compiler does not write SKILL.md", !fs.existsSync(skillFile), skillFile);

    // A deterministic local candidate exercises the same lint/promotion gates;
    // tests/skill-writer-contract.mjs separately mocks the real subagent API.
    const skillLines = [
      "---",
      "name: fixture-report",
      "description: Use when the user wants to repeat the recorded Fixture report workflow.",
      "verified: false",
      "---",
      "",
      "# Fixture report",
      "",
      "## Procedure",
      "",
      ...evidence.steps.flatMap((step) => [
        `${step.n}. Follow the recorded ${step.action} step. [evidence:step:${step.n}]`,
        ...(step.warnings || []).map((warning, index) =>
          `   - ${warning} [evidence:step-warning:${step.n}:${index + 1}]`),
      ]),
      "",
      "## Parameters",
      "",
      ...(evidence.parameters.length
        ? evidence.parameters.map((param) => `- Use {{${param.name}}} from its recorded provenance. [evidence:param:${param.name}]`)
        : ["- No parameters were inferred."]),
      "",
      "## Warnings",
      "",
      ...(evidence.warnings.length
        ? evidence.warnings.map((warning, index) => `- ${warning} [evidence:warning:${index + 1}]`)
        : ["- No session warnings were recorded."]),
      "",
      "## App scope",
      "",
      ...evidence.scope.apps.map((app) => `- ${app}`),
      "",
      "## Safety",
      "",
      "Require explicit user approval before promotion. Never widen app scope or reconstruct redacted input.",
      "",
    ];
    fs.writeFileSync(skillFile, skillLines.join("\n"));
    const LINT = path.join(ROOT, "tools", "skill-recorder", "lint-skill.mjs");
    const lint = spawnSync(process.execPath, [LINT, skillFile, "--evidence", evidencePath], { encoding: "utf8" });
    check("dedicated-writer Skill passes evidence provenance lint", lint.status === 0, lint.stderr || lint.stdout);
    const skill = fs.readFileSync(skillFile, "utf8");
    check("frontmatter: name + trigger description + verified:false",
      /^---\nname: fixture-report\ndescription: .+\nverified: false\n---/.test(skill), "");
    check("parameters retain evidence citations",
      skill.includes(`{{${dateParam?.name}}}`) && skill.includes(`[evidence:param:${dateParam?.name}]`), "");
    check("skill file contains no secret", !skill.includes("s3cret"), "");
    // ---------------- compile: media references (stage 5) ----------------
    check("draft.media carries session-relative paths",
      draft.media?.video === "video/video.avi" && draft.media?.video_index === "video/index.jsonl"
        && draft.media?.keyframes === "keyframes", JSON.stringify(draft.media));
    check("draft.media audio reflects runtime availability",
      fs.existsSync(wavPath)
        ? draft.media?.audio === "audio/narration.wav"
        : draft.media?.audio === null && /unavailable/.test(draft.media?.audio_note || ""),
      `audio=${draft.media?.audio} note=${draft.media?.audio_note}`);
    check("draft references media but never embeds it",
      !draftText.includes("base64") && !draftText.includes("RIFF") && draftText.length < 200_000,
      `draft.json ${(draftText.length / 1000).toFixed(0)} KB`);
    const evidenceMd = fs.readFileSync(path.join(recDir, "evidence.md"), "utf8");
    check("evidence.md documents media and citations",
      /## Media/.test(evidenceMd) && evidenceMd.includes("video/video.avi") && /evidence:step:/.test(evidenceMd), "");
    check("natural-language Skill carries provenance citations without embedded media",
      /evidence:step:/.test(skill) && !skill.includes("base64"), "");
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

    // ---------------- frame extraction (stage 5 review aid) ----------------
    log("--- frame-extract.mjs: agent can look at a chosen moment ---");
    const EXTRACT = path.join(ROOT, "tools", "skill-recorder", "frame-extract.mjs");
    const runExtract = (args) => spawnSync(process.execPath, [EXTRACT, recDir, ...args], { encoding: "utf8", timeout: 30_000 });

    const byNote = runExtract(["--note", "1"]);
    log(`extract[--note 1] exit=${byNote.status} ${(byNote.stdout || "").trim().split("\n").pop()}`);
    check("frame extraction by narration note succeeds (exit 0)", byNote.status === 0, `exit=${byNote.status}`);
    const noteResult = JSON.parse(byNote.stdout);
    const noteJpg = fs.readFileSync(noteResult.out);
    check("extracted bytes are a well-formed JPEG (SOI/EOI)",
      noteJpg[0] === 0xff && noteJpg[1] === 0xd8 && noteJpg[noteJpg.length - 2] === 0xff && noteJpg[noteJpg.length - 1] === 0xd9,
      `${noteJpg.length} bytes at ${noteResult.out}`);

    const atMs = runExtract(["--at-ms", String(notes[1].ts + 3_000)]);
    check("frame extraction by timestamp succeeds (exit 0)", atMs.status === 0 && JSON.parse(atMs.stdout).ok === true,
      `exit=${atMs.status}`);

    const pwMoment = runExtract(["--at-ms", String(pwEnd)]);
    log(`extract[password moment] exit=${pwMoment.status}`);
    check("extracting a password-focus moment reports redaction (exit 4)",
      pwMoment.status === 4 && JSON.parse(pwMoment.stdout).redacted === true
        && JSON.parse(pwMoment.stdout).reason === "password-focus",
      `exit=${pwMoment.status} ${(pwMoment.stdout || "").slice(0, 160)}`);
    check("redacted extraction writes no file",
      !(JSON.parse(pwMoment.stdout).out), "no out path in response");

    const tooEarly = runExtract(["--at-ms", String(first - 60_000)]);
    check("moment before the first frame is a clean error (exit 3)", tooEarly.status === 3, `exit=${tooEarly.status}`);

    // ---------------- promotion gates (stage 5) ----------------
    log("--- promote.mjs: gated, agent-executed, never silent ---");
    const PROMOTE = path.join(ROOT, "tools", "skill-recorder", "promote.mjs");
    const runPromote = (args) => spawnSync(process.execPath, [PROMOTE, ...args], { encoding: "utf8", timeout: 30_000 });

    const detect = runPromote(["--detect-host"]);
    check("--detect-host lists candidates in priority order (exit 0)", detect.status === 0, `exit=${detect.status}`);
    const hosts = JSON.parse(detect.stdout);
    check("detection includes the Kimi Work skills directory",
      hosts.candidates?.some((h) => h.id === "kimi" && /kimi-desktop[/\\]daimon-share[/\\]daimon[/\\]skills$/.test(h.dir)),
      hosts.candidates?.map((h) => `${h.id}:${h.exists}`).join(", "));
    check("detection includes Claude Code and opencode fallbacks",
      ["claude-code", "opencode"].every((id) => hosts.candidates?.some((h) => h.id === id)), "");

    const draftDir = path.join(recDir, "skill-draft", "fixture-report");
    const targetRoot = path.join(temp, "host-skills");
    const gateReview = runPromote([draftDir, "--to", targetRoot]);
    check("promotion refused without --yes-i-reviewed (exit 3)", gateReview.status === 3, `exit=${gateReview.status}`);
    check("refusal created nothing", !fs.existsSync(path.join(targetRoot, "fixture-report")), "");

    const gateVerified = runPromote([draftDir, "--to", targetRoot, "--yes-i-reviewed"]);
    check("verified:false draft refused without --force-unverified (exit 4)", gateVerified.status === 4, `exit=${gateVerified.status}`);

    const forced = runPromote([draftDir, "--to", targetRoot, "--yes-i-reviewed", "--force-unverified"]);
    check("forced promotion succeeds after attestation (exit 0)", forced.status === 0, `exit=${forced.status} ${(forced.stderr || "").slice(-120)}`);
    const promotedFile = path.join(targetRoot, "fixture-report", "SKILL.md");
    check("promoted SKILL.md exists at the target", fs.existsSync(promotedFile), promotedFile);
    check("forced promotion appends an explicit warning to the copy",
      fs.readFileSync(promotedFile, "utf8").includes("--force-unverified")
        && fs.readFileSync(promotedFile, "utf8").includes("never dry-run"), "");
    const promoteSummary = JSON.parse(forced.stdout);
    check("promotion prints discovery + reload guidance",
      promoteSummary.ok === true && typeof promoteSummary.next_step === "string" && /reload|restart/i.test(promoteSummary.next_step), "");

    const clobber = runPromote([draftDir, "--to", targetRoot, "--yes-i-reviewed", "--force-unverified"]);
    check("existing target refused without --overwrite (exit 5)", clobber.status === 5, `exit=${clobber.status}`);
    const over = runPromote([draftDir, "--to", targetRoot, "--yes-i-reviewed", "--force-unverified", "--overwrite"]);
    check("--overwrite replaces the target (exit 0)", over.status === 0, `exit=${over.status}`);

    // ---------------- packaging ----------------
    log("--- packaging: standalone skill + docs ---");
    const pkgSkillPath = path.join(ROOT, "skills", "skill-recorder", "SKILL.md");
    check("packaged skill exists", fs.existsSync(pkgSkillPath), pkgSkillPath);
    const pkg = fs.readFileSync(pkgSkillPath, "utf8");
    check("packaged skill frontmatter (name + description)",
      /^---\r?\nname: skill-recorder\r?\ndescription: .+\r?\n---/.test(pkg), "");
    check("packaged skill carries safety invariants",
      ["secure desktop", "never promote silently", "scope", "unresolved", "Ctrl+Alt+N"].every((t) => pkg.toLowerCase().includes(t.toLowerCase())), "");
    check("packaged skill is the agent playbook (record -> review -> dry-run -> gated promotion)",
      ["agent playbook", "promote.mjs", "frame-extract.mjs", "--detect-host", "Ctrl+Alt+X"].every((t) => pkg.includes(t)), "");
    const cliDoc = path.join(ROOT, "skills", "skill-recorder", "docs", "cli.md");
    check("skill cli reference exists", fs.existsSync(cliDoc), "");
    const cliText = fs.existsSync(cliDoc) ? fs.readFileSync(cliDoc, "utf8") : "";
    check("cli reference documents media flags + frame-extract + promote",
      ["--no-video", "--video-fps", "frame-extract.mjs", "promote.mjs", "--yes-i-reviewed", "redaction gap"].every((t) => cliText.includes(t)), "");
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
