#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Evidence-aware lint gate for model-written Skill drafts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

function cited(markdown, kind) {
  const values = new Set();
  const re = new RegExp(`\\[evidence:${kind}:([^\\]]+)\\]`, "g");
  for (const match of markdown.matchAll(re)) values.add(match[1]);
  return values;
}

function difference(expected, actual) {
  return [...expected].filter((value) => !actual.has(value));
}

export function lintSkill({ markdown, evidence, expectedName }) {
  const errors = [];
  const warnings = [];
  if (evidence?.format !== "fastcua-skill-evidence/1") errors.push("unsupported evidence format");
  const fm = parseFrontmatter(markdown);
  if (!fm) errors.push("missing YAML frontmatter");
  if (fm && fm.name !== expectedName) errors.push(`frontmatter name must be ${expectedName}`);
  if (!fm?.description || fm.description.length < 12) {
    errors.push("frontmatter description must explain when the Skill should be used");
  }
  if (fm?.verified !== "false") errors.push("model-written drafts must declare verified: false");

  const lines = markdown.split(/\r?\n/).length;
  if (lines > 200) errors.push(`Skill is ${lines} lines; keep it at or below 200`);
  if (!/^##\s+.*(?:safety|安全)/im.test(markdown)) errors.push("missing a Safety section");
  if (!/^##\s+.*(?:scope|范围)/im.test(markdown)) errors.push("missing an App scope section");
  if (/base64|data:audio|data:image/i.test(markdown)) errors.push("media bytes must not be embedded");

  const expectedSteps = new Set((evidence.steps || []).map((step) => String(step.n)));
  const expectedParams = new Set((evidence.parameters || []).map((param) => String(param.name)));
  const expectedWarnings = new Set((evidence.warnings || []).map((_, index) => String(index + 1)));
  const expectedStepWarnings = new Set((evidence.steps || []).flatMap((step) =>
    (step.warnings || []).map((_, index) => `${step.n}:${index + 1}`)));
  const actualSteps = cited(markdown, "step");
  const actualParams = cited(markdown, "param");
  const actualWarnings = cited(markdown, "warning");
  const actualStepWarnings = cited(markdown, "step-warning");

  const missingSteps = difference(expectedSteps, actualSteps);
  const unknownSteps = difference(actualSteps, expectedSteps);
  if (missingSteps.length) errors.push(`missing step evidence citations: ${missingSteps.join(", ")}`);
  if (unknownSteps.length) errors.push(`unknown step evidence citations: ${unknownSteps.join(", ")}`);

  const missingParams = difference(expectedParams, actualParams);
  const unknownParams = difference(actualParams, expectedParams);
  if (missingParams.length) errors.push(`missing parameter provenance citations: ${missingParams.join(", ")}`);
  if (unknownParams.length) errors.push(`unknown parameter evidence citations: ${unknownParams.join(", ")}`);

  const placeholders = new Set([...markdown.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((match) => match[1]));
  const unknownPlaceholders = difference(placeholders, expectedParams);
  if (unknownPlaceholders.length) errors.push(`invented parameter placeholders: ${unknownPlaceholders.join(", ")}`);
  for (const name of placeholders) {
    if (!actualParams.has(name)) errors.push(`parameter {{${name}}} lacks [evidence:param:${name}]`);
  }

  const missingStepWarnings = difference(expectedStepWarnings, actualStepWarnings);
  const unknownStepWarnings = difference(actualStepWarnings, expectedStepWarnings);
  if (missingStepWarnings.length) errors.push(`missing step-warning evidence citations: ${missingStepWarnings.join(", ")}`);
  if (unknownStepWarnings.length) errors.push(`unknown step-warning evidence citations: ${unknownStepWarnings.join(", ")}`);

  const numberedInstructions = markdown.split(/\r?\n/).filter((line) => /^\s*\d+[.)]\s+\S/.test(line));
  const uncitedInstructions = numberedInstructions.filter((line) => !/\[evidence:step:\d+\]/.test(line));
  if (uncitedInstructions.length) {
    errors.push(`numbered instructions without step evidence: ${uncitedInstructions.map((line) => line.trim()).join(" | ")}`);
  }
  for (const app of evidence.scope?.apps || []) {
    const basename = path.basename(String(app).replace(/\\/g, "/"));
    if (basename && !markdown.toLowerCase().includes(basename.toLowerCase())) {
      errors.push(`recorded app scope is missing from Skill: ${basename}`);
    }
  }

  const missingWarnings = difference(expectedWarnings, actualWarnings);
  const unknownWarnings = difference(actualWarnings, expectedWarnings);
  if (missingWarnings.length) errors.push(`missing warning evidence citations: ${missingWarnings.join(", ")}`);
  if (unknownWarnings.length) errors.push(`unknown warning evidence citations: ${unknownWarnings.join(", ")}`);

  if (!/explicit user approval|用户明确批准/i.test(markdown)) {
    errors.push("missing the explicit-user-approval boundary");
  }
  return {
    ok: errors.length === 0,
    format: "fastcua-skill-lint/1",
    skill: expectedName,
    evidence: evidence.format,
    lines,
    errors,
    warnings,
    cited: {
      steps: [...actualSteps],
      parameters: [...actualParams],
      warnings: [...actualWarnings],
      stepWarnings: [...actualStepWarnings],
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const skillPath = args.find((arg) => !arg.startsWith("--"));
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const evidencePath = option("--evidence");
  if (!skillPath || !evidencePath) {
    console.error("usage: node lint-skill.mjs <SKILL.md> --evidence <evidence.json> [--name NAME]");
    process.exit(2);
  }
  try {
    const markdown = fs.readFileSync(path.resolve(skillPath), "utf8");
    const evidence = JSON.parse(fs.readFileSync(path.resolve(evidencePath), "utf8"));
    const expectedName = option("--name") || path.basename(path.dirname(path.resolve(skillPath)));
    const result = lintSkill({ markdown, evidence, expectedName });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(4);
  } catch (error) {
    console.error(`lint-skill: ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
