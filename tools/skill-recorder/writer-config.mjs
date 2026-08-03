// SPDX-License-Identifier: MIT
// Shared public/secret configuration for the dedicated Skill-writing subagent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_SKILL_WRITER = Object.freeze({
  enabled: false,
  provider: "openai-compatible",
  baseUrl: "",
  model: "",
  transcriptionModel: "",
  audioMode: "auto",
  timeoutMs: 120_000,
});

function boundedString(value, max = 4096) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizeSkillWriter(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const timeout = Number(source.timeoutMs);
  return {
    enabled: source.enabled === true,
    provider: source.provider === "openai-compatible" ? source.provider : DEFAULT_SKILL_WRITER.provider,
    baseUrl: boundedString(source.baseUrl),
    model: boundedString(source.model, 200),
    transcriptionModel: boundedString(source.transcriptionModel, 200),
    audioMode: ["auto", "direct", "transcribe", "typed"].includes(source.audioMode)
      ? source.audioMode
      : DEFAULT_SKILL_WRITER.audioMode,
    timeoutMs: Number.isFinite(timeout)
      ? Math.min(600_000, Math.max(10_000, Math.round(timeout)))
      : DEFAULT_SKILL_WRITER.timeoutMs,
  };
}

export function validateSkillWriter(value, { requireReady = false } = {}) {
  const config = normalizeSkillWriter(value);
  if (config.baseUrl) {
    let parsed;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      throw new Error("Skill writer API base URL is invalid");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Skill writer API base URL must use http or https");
    }
  }
  if (requireReady || config.enabled) {
    if (!config.baseUrl) throw new Error("Skill writer API base URL is required");
    if (!config.model) throw new Error("Skill writer model is required");
  }
  if (config.audioMode === "transcribe" && !config.transcriptionModel) {
    throw new Error("A transcription model is required for transcribe audio mode");
  }
  return config;
}

export function skillWriterAuthPath() {
  if (process.env.FASTCUA_SKILL_WRITER_AUTH_PATH) {
    return path.resolve(process.env.FASTCUA_SKILL_WRITER_AUTH_PATH);
  }
  const home = process.env.FASTCUA_HOME
    || process.env.FASTCUA_CACHE_DIR
    || path.join(os.homedir(), ".fastcua");
  return path.join(home, "skill-writer-auth.json");
}

export function readSkillWriterAuth() {
  if (process.env.FASTCUA_SKILL_WRITER_API_KEY) {
    return { apiKey: process.env.FASTCUA_SKILL_WRITER_API_KEY, source: "environment" };
  }
  const file = skillWriterAuthPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { apiKey: boundedString(parsed.apiKey, 16_384), source: "secret-file" };
  } catch {
    return { apiKey: "", source: "none" };
  }
}

export function writeSkillWriterAuth(apiKey) {
  const key = boundedString(apiKey, 16_384);
  const file = skillWriterAuthPath();
  if (!key) {
    try { fs.rmSync(file, { force: true }); } catch {}
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ apiKey: key }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function skillWriterPublicView(config) {
  const auth = readSkillWriterAuth();
  const key = auth.apiKey;
  return {
    ...normalizeSkillWriter(config),
    hasApiKey: Boolean(key),
    apiKeyHint: key ? `…${key.slice(-4)}` : "",
    credentialSource: auth.source,
  };
}
