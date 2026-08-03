import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FALLBACK_MANIFEST = Object.freeze({
  schemaVersion: 1,
  name: "FastCUA",
  version: "0.0.0",
  channel: "development",
  buildType: "development",
  commit: "unknown",
  buildTime: null,
  platform: "win32-x64",
  releaseApi: "https://api.github.com/repos/Guojiz/FastCUA/releases/latest",
});

function canonicalRoot(root) {
  let resolved = path.resolve(root);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function readRuntimeManifest(root) {
  const manifestPath = path.join(root, "runtime-manifest.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return { ...FALLBACK_MANIFEST, ...parsed };
  } catch {
    return { ...FALLBACK_MANIFEST };
  }
}

export function runtimeRootHash(root) {
  return crypto.createHash("sha256").update(canonicalRoot(root)).digest("hex").slice(0, 12);
}

export function runtimePipe(root) {
  if (process.env.FASTCUA_PIPE) return process.env.FASTCUA_PIPE;
  return `\\\\.\\pipe\\fastcua-${runtimeRootHash(root)}`;
}

export function runtimeDataDir(root, manifest = readRuntimeManifest(root)) {
  if (process.env.FASTCUA_HOME) return path.resolve(process.env.FASTCUA_HOME);
  if (process.env.FASTCUA_CACHE_DIR) return path.resolve(process.env.FASTCUA_CACHE_DIR);
  if (manifest.buildType === "development") return path.join(root, ".fastcua");
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "FastCUA", "data");
}

export function runtimeConfigPath(root, manifest = readRuntimeManifest(root)) {
  return (
    process.env.FASTCUA_CONFIG_PATH ||
    path.join(runtimeDataDir(root, manifest), "config.json")
  );
}

export function runtimeDefaultPort(root, manifest = readRuntimeManifest(root)) {
  if (process.env.FASTCUA_HTTP_PORT) {
    const requested = Number(process.env.FASTCUA_HTTP_PORT);
    if (Number.isInteger(requested) && requested >= 1024 && requested <= 65535) {
      return requested;
    }
  }
  if (manifest.buildType !== "development") return 8420;
  return 18000 + (Number.parseInt(runtimeRootHash(root).slice(0, 4), 16) % 1000);
}

export function runtimeInfo(root, extra = {}) {
  const manifest = readRuntimeManifest(root);
  return {
    ...manifest,
    root: path.resolve(root),
    rootHash: runtimeRootHash(root),
    pipe: runtimePipe(root),
    dataDir: runtimeDataDir(root, manifest),
    configPath: runtimeConfigPath(root, manifest),
    defaultPort: runtimeDefaultPort(root, manifest),
    node: process.execPath,
    pid: process.pid,
    ...extra,
  };
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || "")
      .trim()
      .replace(/^v/i, "")
      .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return {
      parts: match.slice(1, 4).map(Number),
      prerelease: match[4] || "",
    };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}
