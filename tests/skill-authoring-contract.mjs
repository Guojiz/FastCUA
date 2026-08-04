import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintSkill } from "../tools/skill-recorder/lint-skill.mjs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const evidence = {
  format: "fastcua-skill-evidence/1",
  scope: { apps: ["C:\\Windows\\System32\\notepad.exe"] },
  parameters: [{ name: "message", value: "hello" }],
  warnings: ["Review the destination before promotion."],
  steps: [
    { n: 1, kind: "type", warnings: [] },
    { n: 2, kind: "click", warnings: ["Target may move after resize."] },
  ],
};

const validSkill = `---
name: recorded-notepad
verified: false
description: Replay the reviewed Notepad workflow with a supplied message.
---

# Recorded Notepad workflow

## App scope

Only operate Notepad.exe.

## Workflow

1. Type {{message}} in the demonstrated editor. [evidence:step:1] [evidence:param:message]
2. Click the demonstrated target after re-observing it. [evidence:step:2] [evidence:step-warning:2:1]

Review the recorded warning before use. [evidence:warning:1]

## Safety

Require explicit user approval before promoting this Skill.
`;

const accepted = lintSkill({
  markdown: validSkill,
  evidence,
  expectedName: "recorded-notepad",
});
assert.equal(accepted.ok, true, accepted.errors.join("; "));

const fabricated = validSkill
  .replace(" [evidence:param:message]", "")
  .replace("## Safety", "Invent {{invented}}. [evidence:param:invented]\n\n## Safety");
const rejected = lintSkill({
  markdown: fabricated,
  evidence,
  expectedName: "recorded-notepad",
});
assert.equal(rejected.ok, false);
assert.ok(rejected.errors.some((error) => /lacks \[evidence:param:message\]/.test(error)));
assert.ok(rejected.errors.some((error) => /invented parameter placeholders: invented/.test(error)));
assert.ok(rejected.errors.some((error) => /unknown parameter evidence citations: invented/.test(error)));

const compile = read("tools/skill-recorder/compile.mjs");
const promote = read("tools/skill-recorder/promote.mjs");
const daemon = read("daemon.mjs");
const web = read("web.html");
const config = JSON.parse(read("config.json"));
const releaseBuilder = read("scripts/build-release.ps1");
const manager = read("scripts/manage.ps1");
const releaseWorkflow = read(".github/workflows/release.yml");

assert.match(compile, /writer:\s*"current-primary-agent"/);
assert.match(compile, /current primary agent writes/);
assert.doesNotMatch(compile, /synthesize\.mjs|dedicated-subagent/);
assert.match(promote, /current primary agent must write it from evidence/);
assert.doesNotMatch(promote, /synthesize\.mjs/);
assert.equal(Object.hasOwn(config, "skillWriter"), false);
assert.doesNotMatch(daemon, /skill-writer|SKILL_WRITER|writer-config/);
assert.doesNotMatch(web, /writer-|skill-writer|transcription API|OpenAI-compatible API/);
assert.doesNotMatch(releaseBuilder, /synthesize\.mjs|writer-config\.mjs/);
assert.doesNotMatch(manager, /synthesize\.mjs|writer-config\.mjs/);
assert.doesNotMatch(releaseWorkflow, new RegExp("N" + "PM_TOKEN|n" + "pm publish|package\\.json"));

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-authoring-contract-"));
try {
  const session = path.join(temp, "session.jsonl");
  fs.writeFileSync(session, "");
  const compileRun = spawnSync(process.execPath, [
    path.join(root, "tools", "skill-recorder", "compile.mjs"),
    session,
    "--skill",
    "empty-demo",
    "--out",
    temp,
  ], { encoding: "utf8" });
  assert.equal(compileRun.status, 0, compileRun.stderr || compileRun.stdout);
  const request = JSON.parse(fs.readFileSync(
    path.join(temp, "skill-draft", "empty-demo", "synthesis-request.json"),
    "utf8",
  ));
  assert.equal(request.writer, "current-primary-agent");
  for (const key of ["evidence_json", "evidence_markdown", "replay_draft"]) {
    assert.ok(fs.existsSync(request.inputs[key]), `${key} must resolve to a generated artifact`);
  }
  assert.equal(fs.existsSync(request.output), false, "compiler must leave SKILL.md for the primary agent");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

for (const removed of [
  "package.json",
  "bin/fastcua.mjs",
  "tools/skill-recorder/synthesize.mjs",
  "tools/skill-recorder/writer-config.mjs",
]) {
  assert.equal(fs.existsSync(new URL(`../${removed}`, import.meta.url)), false, `${removed} must stay removed`);
}

console.log("PASS Skill authoring contract: current primary agent, evidence citations, deterministic rejection, no second-model or alternate package-manager path");
