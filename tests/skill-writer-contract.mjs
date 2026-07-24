// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSkillWriterAuth,
  skillWriterPublicView,
  writeSkillWriterAuth,
} from "../tools/skill-recorder/writer-config.mjs";
import { lintSkill } from "../tools/skill-recorder/lint-skill.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const SYNTHESIZE = path.join(ROOT, "tools", "skill-recorder", "synthesize.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-skill-writer-"));
const authPath = path.join(temp, "auth.json");
process.env.FASTCUA_SKILL_WRITER_AUTH_PATH = authPath;

const evidence = {
  format: "fastcua-skill-evidence/1",
  source: path.join(temp, "session.jsonl"),
  executable: false,
  verified: false,
  scope: { apps: ["C:\\Fixture.exe"] },
  steps: [
    { n: 1, action: "click", anchor: { role: "Button", automation_id: "save" }, warnings: ["anchor low confidence"] },
    { n: 2, action: "type", text: "{{date}}", anchor: { role: "Edit" }, warnings: [] },
  ],
  parameters: [
    { name: "date", kind: "date", observed: "2026-07-24", provenance: { step: 2, source: "typed-value" } },
  ],
  warnings: ["unverified demonstration"],
  media: { audio: "audio/narration.wav" },
  stats: { steps: 2 },
};

const validSkill = `---
name: fixture-report
description: Use when the user wants to save a dated report in Fixture.
verified: false
---

# Fixture report

## Procedure

1. Activate Save by its recorded anchor; its confidence was low. [evidence:step:1] [evidence:step-warning:1:1]
2. Enter {{date}} in the recorded editor. [evidence:step:2] [evidence:param:date]

Keep the unverified-demonstration warning visible. [evidence:warning:1]

## App scope

Operate only in Fixture.exe.

## Safety

Require explicit user approval before promotion and never widen app scope.
`;

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

let daemonChild = null;
let directCalls = 0;
let transcriptionCalls = 0;
let textCalls = 0;
const server = http.createServer((req, res) => {
  let body = Buffer.alloc(0);
  req.on("data", chunk => body = Buffer.concat([body, chunk]));
  req.on("end", () => {
    assert.equal(req.headers.authorization, "Bearer test-secret-key");
    if (req.url === "/v1/audio/transcriptions") {
      transcriptionCalls++;
      assert.match(req.headers["content-type"] || "", /multipart\/form-data/);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "Save the report with the chosen date." }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      const parsed = JSON.parse(body.toString("utf8"));
      const content = parsed.messages[1].content;
      if (Array.isArray(content)) {
        directCalls++;
        assert.equal(content[1].type, "input_audio");
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model does not accept audio" } }));
      } else {
        textCalls++;
        assert.match(content, /Audio transcript/);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: validSkill } }] }));
      }
      return;
    }
    res.writeHead(404).end();
  });
});

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  fs.mkdirSync(path.join(temp, "audio"), { recursive: true });
  fs.writeFileSync(path.join(temp, "audio", "narration.wav"), Buffer.from("RIFF-test"));
  const evidencePath = path.join(temp, "evidence.json");
  const configPath = path.join(temp, "config.json");
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  fs.writeFileSync(configPath, JSON.stringify({
    costartMode: "manual",
    overlayEnabled: false,
    skillWriter: {
      enabled: true,
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "writer-model",
      transcriptionModel: "transcribe-model",
      audioMode: "auto",
      timeoutMs: 10_000,
    },
  }, null, 2));

  const compileDir = path.join(temp, "compile-smoke");
  fs.mkdirSync(compileDir, { recursive: true });
  const compileSession = path.join(compileDir, "session.jsonl");
  const gestureTs = Date.now();
  const gestureWindow = {
    hwnd: 101,
    app: "C:\\Fixture.exe",
    title: "Fixture",
    bounds: [100, 200, 900, 800],
  };
  const canvasAnchor = {
    role: "Pane",
    control_type: 50033,
    automation_id: "canvas",
    name: "Canvas",
    hwnd: 102,
    bounds: [120, 220, 850, 750],
    value_class: "action",
    alignment: "point",
    confidence: "high",
  };
  const buttonAnchor = {
    role: "Button",
    control_type: 50000,
    automation_id: "save",
    name: "Save",
    hwnd: 103,
    bounds: [700, 720, 780, 760],
    value_class: "action",
    alignment: "point",
    confidence: "high",
  };
  fs.writeFileSync(compileSession, [
    JSON.stringify({ t: "header", format: "fastcua-recording/1", media: { video: null, audio: null } }),
    JSON.stringify({ t: "mouse_down", ts: gestureTs, button: 1, x: 140, y: 240, injected: false, fg: gestureWindow, anchor: canvasAnchor }),
    JSON.stringify({ t: "mouse_move", ts: gestureTs + 40, button: 0, x: 170, y: 260, injected: false, fg: gestureWindow }),
    JSON.stringify({ t: "mouse_up", ts: gestureTs + 90, button: 1, x: 220, y: 300, injected: false, fg: gestureWindow, anchor: canvasAnchor }),
    JSON.stringify({ t: "wheel_v", ts: gestureTs + 120, button: 0, x: 300, y: 400, wheel: -120, injected: false, fg: gestureWindow }),
    JSON.stringify({ t: "mouse_down", ts: gestureTs + 160, button: 1, x: 740, y: 740, injected: false, fg: gestureWindow, anchor: buttonAnchor }),
    JSON.stringify({ t: "mouse_move", ts: gestureTs + 180, button: 0, x: 742, y: 741, injected: false, fg: gestureWindow }),
    JSON.stringify({ t: "mouse_up", ts: gestureTs + 200, button: 1, x: 742, y: 741, injected: false, fg: gestureWindow, anchor: buttonAnchor }),
    JSON.stringify({ t: "stats", ts: gestureTs + 250 }),
  ].join("\n") + "\n");
  const compiled = await runNode([
    path.join(ROOT, "tools", "skill-recorder", "compile.mjs"),
    compileSession,
    "--skill", "compile-smoke",
    "--out", compileDir,
  ]);
  assert.equal(compiled.status, 0, compiled.stderr);
  const compiledEvidence = JSON.parse(fs.readFileSync(path.join(compileDir, "evidence.json"), "utf8"));
  assert.equal(compiledEvidence.format, "fastcua-skill-evidence/1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(compileDir, "draft.json"), "utf8")).format, "fastcua-skill-draft/1");
  assert.deepEqual(compiledEvidence.steps.map(step => step.action), ["drag", "scroll", "click"]);
  const [dragStep, wheelStep, clickStep] = compiledEvidence.steps;
  assert.equal(dragStep.button, "left");
  assert.equal(dragStep.anchor.automation_id, "canvas");
  assert.equal(dragStep.end_anchor.automation_id, "canvas");
  assert.equal(dragStep.from.inside_window, true);
  assert.equal(dragStep.to.inside_window, true);
  assert.ok(dragStep.path.length >= 3);
  assert.equal(wheelStep.input, "wheel");
  assert.equal(wheelStep.axis, "vertical");
  assert.equal(wheelStep.delta, -120);
  assert.equal(wheelStep.point.inside_window, true);
  assert.equal(clickStep.anchor.automation_id, "save");
  assert.equal(fs.existsSync(path.join(compileDir, "skill-draft", "compile-smoke", "synthesis-request.json")), true);
  assert.equal(fs.existsSync(path.join(compileDir, "skill-draft", "compile-smoke", "SKILL.md")), false);
  const decisionsPath = path.join(compileDir, "decisions.json");
  fs.writeFileSync(decisionsPath, JSON.stringify({ session: "acknowledge", default: "proceed" }));
  const dryCompatibility = await runNode([
    path.join(ROOT, "tools", "skill-recorder", "dryrun.mjs"),
    path.join(compileDir, "draft.json"), "--dry", "--decisions", decisionsPath,
  ]);
  assert.equal(dryCompatibility.status, 0, dryCompatibility.stderr || dryCompatibility.stdout);

  const replayPipe = `\\\\.\\pipe\\fastcua-pointer-contract-${process.pid}`;
  const replayCalls = [];
  const replayServer = net.createServer(socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        replayCalls.push({ method: request.method, params: request.params });
        let result;
        if (request.method === "list_windows") {
          result = [{ app: "C:\\Fixture.exe", id: 9001, title: "Fixture" }];
        } else if (request.method === "get_window_state") {
          result = {
            viewport: { width: 800, height: 600 },
            accessibility: {
              tree: "\t0 Window Fixture\n\t1 Pane #canvas Canvas\n",
            },
          };
        } else if (request.method === "drag" || request.method === "scroll") {
          result = {};
        } else {
          socket.write(JSON.stringify({ id: request.id, error: `unexpected method ${request.method}` }) + "\n");
          continue;
        }
        socket.write(JSON.stringify({ id: request.id, result }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    replayServer.once("error", reject);
    replayServer.listen(replayPipe, resolve);
  });
  const replayDecisions = path.join(compileDir, "replay-decisions.json");
  fs.writeFileSync(replayDecisions, JSON.stringify({
    session: "acknowledge",
    default: "proceed",
    steps: { "3": "skip" },
  }));
  try {
    const replay = await runNode([
      path.join(ROOT, "tools", "skill-recorder", "dryrun.mjs"),
      path.join(compileDir, "draft.json"),
      "--pipe", replayPipe,
      "--decisions", replayDecisions,
    ]);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  } finally {
    await new Promise(resolve => replayServer.close(resolve));
  }
  const dragCall = replayCalls.find(call => call.method === "drag");
  const wheelCall = replayCalls.find(call => call.method === "scroll");
  assert.deepEqual(
    { from_x: dragCall.params.from_x, from_y: dragCall.params.from_y, to_x: dragCall.params.to_x, to_y: dragCall.params.to_y },
    { from_x: 40, from_y: 40, to_x: 120, to_y: 100 },
  );
  assert.deepEqual(
    { x: wheelCall.params.x, y: wheelCall.params.y, scrollX: wheelCall.params.scrollX, scrollY: wheelCall.params.scrollY },
    { x: 200, y: 200, scrollX: 0, scrollY: 120 },
  );
  console.log("PASS compiler separates drag, wheel, and click; dry-run sends distinct normal-control-plane calls");

  writeSkillWriterAuth("test-secret-key");
  assert.equal(readSkillWriterAuth().apiKey, "test-secret-key");
  const publicView = skillWriterPublicView(JSON.parse(fs.readFileSync(configPath, "utf8")).skillWriter);
  assert.equal(publicView.hasApiKey, true);
  assert.equal(publicView.apiKeyHint, "…-key");
  assert.doesNotMatch(JSON.stringify(publicView), /test-secret-key/);
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /test-secret-key/);
  console.log("PASS API key is stored separately and masked in public config");

  const outDir = path.join(temp, "skill-draft", "fixture-report");
  const result = await runNode([
    SYNTHESIZE,
    evidencePath,
    "--skill", "fixture-report",
    "--config", configPath,
    "--out", outDir,
  ], { FASTCUA_SKILL_WRITER_AUTH_PATH: authPath });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.audioSource, "transcription-api");
  assert.equal(report.model, "writer-model");
  assert.equal(directCalls, 1);
  assert.equal(transcriptionCalls, 1);
  assert.equal(textCalls, 1);
  assert.equal(report.lint.ok, true);
  assert.equal(fs.readFileSync(path.join(outDir, "SKILL.md"), "utf8"), validSkill);
  console.log("PASS auto narration falls back direct audio -> transcription API -> evidence-bound writer");

  const fabricated = validSkill.replace("[evidence:step:1]", "[evidence:step:99]");
  const badLint = lintSkill({ markdown: fabricated, evidence, expectedName: "fixture-report" });
  assert.equal(badLint.ok, false);
  assert.ok(badLint.errors.some(error => /unknown step/.test(error)));
  assert.ok(badLint.errors.some(error => /missing step/.test(error)));
  console.log("PASS provenance lint rejects missing and fabricated evidence");

  const daemon = fs.readFileSync(path.join(ROOT, "daemon.mjs"), "utf8");
  const web = fs.readFileSync(path.join(ROOT, "web.html"), "utf8");
  const trackedConfig = fs.readFileSync(path.join(ROOT, "config.json"), "utf8");
  assert.match(daemon, /\/api\/skill-writer\/config/);
  assert.match(web, /id="writer-api-key" type="password"/);
  assert.match(web, /direct audio → transcription API → typed notes/);
  assert.doesNotMatch(trackedConfig, /apiKey/i);
  console.log("PASS control-console contract exposes dedicated settings without a tracked secret");

  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const daemonPort = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  daemonChild = spawn(process.execPath, [path.join(ROOT, "daemon.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      FASTCUA_CONFIG_PATH: configPath,
      FASTCUA_SKILL_WRITER_AUTH_PATH: authPath,
      FASTCUA_HTTP_PORT: String(daemonPort),
      FASTCUA_PIPE: `\\\\.\\pipe\\fastcua-writer-test-${process.pid}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const consoleBase = `http://127.0.0.1:${daemonPort}`;
  let consoleReady = false;
  for (let attempt = 0; attempt < 60 && !consoleReady; attempt++) {
    try {
      const response = await fetch(consoleBase + "/api/skill-writer/config");
      consoleReady = response.ok;
    } catch {}
    if (!consoleReady) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(consoleReady, true, "daemon console did not start");
  const rejectedOrigin = await fetch(consoleBase + "/api/skill-writer/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.com" },
    body: JSON.stringify({ enabled: false, clearApiKey: true }),
  });
  assert.equal(rejectedOrigin.status, 403);
  assert.equal(readSkillWriterAuth().apiKey, "test-secret-key");
  const saved = await fetch(consoleBase + "/api/skill-writer/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "console-writer",
      transcriptionModel: "console-transcriber",
      audioMode: "auto",
      timeoutMs: 20_000,
      apiKey: "console-secret-key",
    }),
  });
  assert.equal(saved.status, 200, await saved.text());
  const publicSaved = await (await fetch(consoleBase + "/api/skill-writer/config")).json();
  assert.equal(publicSaved.hasApiKey, true);
  assert.equal(publicSaved.model, "console-writer");
  assert.doesNotMatch(JSON.stringify(publicSaved), /console-secret-key/);
  assert.match(fs.readFileSync(authPath, "utf8"), /console-secret-key/);
  assert.doesNotMatch(fs.readFileSync(configPath, "utf8"), /console-secret-key/);
  const genericConfig = await (await fetch(consoleBase + "/api/config")).json();
  assert.doesNotMatch(JSON.stringify(genericConfig), /console-secret-key/);
  const cleared = await fetch(consoleBase + "/api/skill-writer/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false, clearApiKey: true }),
  });
  assert.equal(cleared.status, 200, await cleared.text());
  assert.equal(fs.existsSync(authPath), false);
  console.log("PASS live control console rejects cross-origin mutation, isolates, masks, and clears credentials");
  daemonChild.kill();
  await new Promise(resolve => daemonChild.once("close", resolve));
  daemonChild = null;
} finally {
  if (daemonChild) {
    daemonChild.kill();
    await new Promise(resolve => daemonChild.once("close", resolve));
  }
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("6 Skill-writer contract checks passed.");
