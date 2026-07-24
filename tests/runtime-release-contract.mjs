import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  readRuntimeManifest,
  runtimeDataDir,
  runtimeDefaultPort,
  runtimeInfo,
  runtimePipe,
} from "../lib/runtime.mjs";
import { checkForUpdates } from "../lib/update-check.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-runtime-contract-"));

try {
  const devRoot = path.join(temp, "dev");
  const releaseRoot = path.join(temp, "release");
  fs.mkdirSync(devRoot);
  fs.mkdirSync(releaseRoot);
  fs.writeFileSync(
    path.join(devRoot, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "FastCUA",
      version: "0.3.0",
      buildType: "development",
      platform: "win32-x64",
    }),
  );
  fs.writeFileSync(
    path.join(releaseRoot, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "FastCUA",
      version: "0.3.0",
      buildType: "release",
      platform: "win32-x64",
    }),
  );

  const devManifest = readRuntimeManifest(devRoot);
  const releaseManifest = readRuntimeManifest(releaseRoot);
  assert.equal(devManifest.buildType, "development");
  assert.equal(releaseManifest.buildType, "release");
  assert.notEqual(runtimePipe(devRoot), runtimePipe(releaseRoot));
  assert.match(runtimePipe(devRoot), /^\\\\\.\\pipe\\fastcua-[a-f0-9]{12}$/);
  assert.equal(runtimeDataDir(devRoot, devManifest), path.join(devRoot, ".fastcua"));
  assert.equal(runtimeDefaultPort(releaseRoot, releaseManifest), 8420);
  assert.notEqual(runtimeDefaultPort(devRoot, devManifest), 8420);
  assert.equal(runtimeInfo(devRoot).root, path.resolve(devRoot));

  assert.equal(compareVersions("0.3.0", "0.2.1"), 1);
  assert.equal(compareVersions("v0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.3.0-beta.1", "0.3.0"), -1);
  assert.equal(compareVersions("invalid", "0.3.0"), null);

  let fetched = false;
  const devUpdate = await checkForUpdates(devRoot, {
    force: true,
    fetchImpl: async () => {
      fetched = true;
      throw new Error("development check must not call the network");
    },
  });
  assert.equal(devUpdate.status, "development");
  assert.equal(fetched, false);

  const previousFastCuaHome = process.env.FASTCUA_HOME;
  process.env.FASTCUA_HOME = path.join(temp, "release-data");
  try {
    let releaseFetches = 0;
    const available = await checkForUpdates(releaseRoot, {
      force: true,
      fetchImpl: async () => {
        releaseFetches += 1;
        return {
          ok: true,
          json: async () => ({
            tag_name: "v0.4.0",
            html_url: "https://github.com/Guojiz/FastCUA/releases/tag/v0.4.0",
            name: "FastCUA v0.4.0",
          }),
        };
      },
    });
    assert.equal(available.status, "available");
    assert.equal(available.latestVersion, "0.4.0");
    const cached = await checkForUpdates(releaseRoot, {
      fetchImpl: async () => {
        throw new Error("cached update checks must not call the network");
      },
    });
    assert.equal(cached.status, "available");
    assert.equal(releaseFetches, 1);
  } finally {
    if (previousFastCuaHome === undefined) delete process.env.FASTCUA_HOME;
    else process.env.FASTCUA_HOME = previousFastCuaHome;
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runtimeManifest = JSON.parse(
    fs.readFileSync(path.join(root, "runtime-manifest.json"), "utf8"),
  );
  const nativeCargo = fs.readFileSync(path.join(root, "native-host", "Cargo.toml"), "utf8");
  const recorderCargo = fs.readFileSync(
    path.join(root, "tools", "skill-recorder", "Cargo.toml"),
    "utf8",
  );
  assert.equal(packageJson.version, runtimeManifest.version);
  assert.match(nativeCargo, new RegExp(`^version = "${runtimeManifest.version}"$`, "m"));
  assert.match(recorderCargo, new RegExp(`^version = "${runtimeManifest.version}"$`, "m"));
  assert.equal(runtimeManifest.buildType, "development");

  console.log(
    "PASS runtime release contract: path-scoped daemon, dev/release isolation, coherent versions, and dev-safe update checks",
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
