import fs from "node:fs";
import path from "node:path";
import {
  compareVersions,
  readRuntimeManifest,
  runtimeDataDir,
} from "./runtime.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

export async function checkForUpdates(root, options = {}) {
  const manifest = readRuntimeManifest(root);
  const statePath = path.join(runtimeDataDir(root, manifest), "update-state.json");
  const previous = readJson(statePath);
  const now = options.now ?? Date.now();

  if (manifest.buildType === "development") {
    return {
      status: "development",
      checkedAt: null,
      currentVersion: manifest.version,
      message: "Automatic release updates are disabled for a development checkout.",
    };
  }
  if (options.enabled === false) {
    return {
      status: "disabled",
      checkedAt: previous?.checkedAt || null,
      currentVersion: manifest.version,
    };
  }
  if (
    !options.force &&
    previous?.checkedAt &&
    now - Date.parse(previous.checkedAt) < (options.intervalMs || DAY_MS)
  ) {
    return previous;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8_000);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(manifest.releaseApi, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `FastCUA/${manifest.version}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`release API returned HTTP ${response.status}`);
    const release = await response.json();
    const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
    const comparison = compareVersions(latestVersion, manifest.version);
    if (comparison == null) throw new Error("release API returned an invalid version");
    const state = {
      status: comparison > 0 ? "available" : "current",
      checkedAt: new Date(now).toISOString(),
      currentVersion: manifest.version,
      latestVersion,
      releaseUrl: release.html_url || null,
      releaseName: release.name || release.tag_name || null,
    };
    writeJson(statePath, state);
    return state;
  } catch (error) {
    const state = {
      status: "error",
      checkedAt: new Date(now).toISOString(),
      currentVersion: manifest.version,
      latestVersion: previous?.latestVersion || null,
      releaseUrl: previous?.releaseUrl || null,
      error: error.name === "AbortError" ? "update check timed out" : error.message,
    };
    writeJson(statePath, state);
    return state;
  } finally {
    clearTimeout(timer);
  }
}
