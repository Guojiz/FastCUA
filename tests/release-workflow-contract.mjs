// SPDX-License-Identifier: MIT
//
// Release workflow contract: guards the exact failure mode that broke the
// v0.3.0 release (assignment to the read-only PowerShell automatic variable
// $Host silently skipped every later build/publish step) plus the version and
// asset wiring that a trustworthy release depends on.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const yamlPath = path.join(root, ".github", "workflows", "release.yml");
const yaml = fs.readFileSync(yamlPath, "utf8");

// PowerShell automatic/read-only variables that a script must never assign.
// $Host and $host are the same variable (case-insensitive); $hostPath is not.
const automaticVars = new Set([
  "host",
  "input",
  "args",
  "matches",
  "error",
  "psversiontable",
  "pwd",
  "home",
  "pid",
  "myinvocation",
  "foreach",
  "switch",
  "true",
  "false",
  "null",
  "script",
  "function",
  "shellid",
  "stacktrace",
  "executioncontext",
  "psboundparameters",
  "pscommandpath",
  "psscriptroot",
  "pssenderinfo",
  "psculture",
  "pshome",
  "pswindowstitle",
  "islinux",
  "ismacos",
  "iswindows",
  "iscoreclr",
  "iseditor",
  "nestedpromptlevel",
  "maximumaliascount",
  "maximumdrivecount",
  "maximumerrorcount",
  "maximumfunctioncount",
  "maximumhistorycount",
  "maximumvariablecount",
]);

function pwshRunBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const shell = /^\s*shell:\s*(\S+)\s*$/.exec(lines[i]);
    if (!shell || !/pwsh|powershell/i.test(shell[1])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*- (?:name|uses):/.test(lines[j])) break;
      const run = /^(\s*)run:\s*\|?\s*$/.exec(lines[j]);
      if (!run) continue;
      const indent = run[1].length;
      const block = [];
      for (let k = j + 1; k < lines.length; k++) {
        const line = lines[k];
        if (!line.trim()) {
          block.push(line);
          continue;
        }
        if (/^\s*/.exec(line)[0].length <= indent) break;
        block.push(line);
      }
      blocks.push(block.join("\n"));
      break;
    }
  }
  return blocks;
}

// 1. No pwsh run block may assign to a PowerShell automatic variable.
for (const block of pwshRunBlocks(yaml)) {
  for (const line of block.split(/\r?\n/)) {
    const match = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && automaticVars.has(match[1].toLowerCase())) {
      throw new Error(
        `release workflow assigns to PowerShell automatic variable \$${match[1]} (case-insensitive): ${line.trim()}`,
      );
    }
  }
}

// 2. Every versioned component must agree with runtime-manifest.json.
const manifestVersion = JSON.parse(
  fs.readFileSync(path.join(root, "runtime-manifest.json"), "utf8"),
).version;
assert.match(manifestVersion, /^\d+\.\d+\.\d+$/, "runtime-manifest.json version must be semver");

function cargoVersion(relativePath) {
  const text = fs.readFileSync(path.join(root, relativePath), "utf8");
  const match = /^version = "([^"]+)"$/m.exec(text);
  assert.ok(match, `${relativePath} must declare a version`);
  return match[1];
}

function lockVersion(relativePath, packageName) {
  const text = fs.readFileSync(path.join(root, relativePath), "utf8");
  const match = new RegExp(`name = "${packageName}"\\r?\\nversion = "([^"]+)"`).exec(text);
  assert.ok(match, `${relativePath} must list ${packageName}`);
  return match[1];
}

assert.equal(cargoVersion("native-host/Cargo.toml"), manifestVersion, "native-host/Cargo.toml version");
assert.equal(cargoVersion("tools/skill-recorder/Cargo.toml"), manifestVersion, "skill-recorder/Cargo.toml version");
assert.equal(lockVersion("native-host/Cargo.lock", "cua-native-host"), manifestVersion, "native-host/Cargo.lock version");
assert.equal(lockVersion("tools/skill-recorder/Cargo.lock", "skill-recorder"), manifestVersion, "skill-recorder/Cargo.lock version");

// 3. The tag-confirmation step must validate every versioned component.
assert.match(
  yaml,
  /manifest=\$manifest;\s*nativeHost=\$nativeHost;\s*recorder=\$recorder/,
  "tag confirmation must check manifest, nativeHost, and recorder versions",
);

// 4. The build must embed the exact tag commit so the shipped manifest matches
//    the tag (this was broken for v0.3.0: the ZIP claimed commit 74c15bc).
assert.ok(
  yaml.includes("./scripts/build-release.ps1 -Version '${{ github.ref_name }}' -Commit '${{ github.sha }}'"),
  "build step must pass -Version and -Commit from the tag",
);

// 5. The release must publish every asset the current installer requires:
//    runtime ZIP, SHA256SUMS.txt, runtime-manifest.json, and install.ps1.
for (const asset of [
  "dist/fastcua-runtime-win-x64.zip",
  "dist/SHA256SUMS.txt",
  "dist/runtime-manifest.json",
  "dist/install.ps1",
]) {
  assert.ok(yaml.includes(asset), `release workflow must publish ${asset}`);
}

console.log("PASS release workflow contract: no automatic-variable assignment, coherent versions, and complete tag-verified assets");
