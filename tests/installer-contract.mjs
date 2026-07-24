import assert from "node:assert/strict";
import fs from "node:fs";

const installer = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const manager = fs.readFileSync(new URL("../scripts/manage.ps1", import.meta.url), "utf8");
const releaseBuilder = fs.readFileSync(new URL("../scripts/build-release.ps1", import.meta.url), "utf8");
const uninstaller = fs.readFileSync(new URL("../uninstall.ps1", import.meta.url), "utf8");
const web = fs.readFileSync(new URL("../web.html", import.meta.url), "utf8");
const configText = fs.readFileSync(new URL("../config.json", import.meta.url), "utf8");
const config = JSON.parse(configText);

assert.match(installer, /ValidateSet\('Install', 'Update', 'Check', 'Doctor'\)/);
assert.match(installer, /scripts\\manage\.ps1/);
assert.match(installer, /FASTCUA_MANAGER_URL/);
assert.match(manager, /releases\/latest/);
assert.match(manager, /fastcua-runtime-win-x64\.zip/);
assert.match(manager, /SHA256SUMS\.txt/);
assert.match(manager, /Get-FileHash[^\r\n]+SHA256/);
assert.match(manager, /runtime-manifest\.json/);
assert.match(manager, /Assert-Runtime/);
assert.match(manager, /app\.previous/);
assert.match(manager, /Rollback copy retained/);
assert.match(manager, /Stop-InstalledRuntime/);
assert.match(manager, /Update available/);
assert.match(manager, /FastCUA doctor passed/);
assert.match(manager, /Configured MCP server paths/);
assert.match(manager, /another FastCUA root/);
assert.match(manager, /skills\\computer-use/);
assert.match(manager, /call runtime_info and list_apps/i);
assert.match(manager, /Do not substitute another Computer Use implementation/i);
assert.match(releaseBuilder, /cargo build --release --locked/);
assert.match(releaseBuilder, /helper\\cua-native-host\.exe/);
assert.match(releaseBuilder, /skill-recorder\.exe/);
assert.match(releaseBuilder, /Compress-Archive/);
assert.match(releaseBuilder, /files -NotePropertyValue/);

assert.match(uninstaller, /FastCUA Console\.url/);
assert.match(uninstaller, /FastCUA Agent Setup\.txt/);
assert.match(uninstaller, /Get-CimInstance Win32_Process/);
assert.match(uninstaller, /Remove-ItemProperty[^\r\n]+FastCUA/);

assert.match(web, /id="version-pill"/);
assert.match(web, /state\.update\?\.status === 'available'/);
assert.doesNotMatch(configText, /^\uFEFF/, "config.json must remain directly JSON.parse-compatible");
assert.equal(config.approvalPolicy, "safe");
assert.equal(config.checkForUpdates, true);
assert.equal(config.skillWriter?.enabled, false);
assert.equal(Object.hasOwn(config.skillWriter || {}, "apiKey"), false);
assert.ok(
  !config.whitelist.some((entry) =>
    /^(?:windowsterminal|cmd|powershell|pwsh|claude|chatgpt)\.exe$/i.test(entry),
  ),
  "safe defaults must not pre-approve terminals or AI assistants",
);

console.log(
  "PASS installer contract: one runtime package, checksum + manifest verification, update/check/doctor, staged rollback, and visible update status",
);
