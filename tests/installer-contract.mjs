import assert from "node:assert/strict";
import fs from "node:fs";

const installer = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const uninstaller = fs.readFileSync(new URL("../uninstall.ps1", import.meta.url), "utf8");
const web = fs.readFileSync(new URL("../web.html", import.meta.url), "utf8");
const selfHosting = fs.readFileSync(new URL("../docs/SELF_HOSTING.md", import.meta.url), "utf8");

assert.match(installer, /\$Version\s*=\s*'v0\.1\.3'/);
assert.match(installer, /archive\/refs\/tags\/\$Version\.zip/);
assert.match(installer, /releases\/download\/\$Version/);
assert.doesNotMatch(installer, /refs\/heads\/main|releases\/latest/);
assert.match(installer, /Get-FileHash[^\r\n]+SHA256/);
assert.match(installer, /\$savedConfig/);
assert.match(installer, /FastCUA Console\.url/);
assert.match(installer, /URL=http:\/\/127\.0\.0\.1:8420/);
assert.doesNotMatch(installer, /claude(?:\.exe)?|Anthropic|\.claude/i);
assert.match(installer, /FastCUA Agent Setup\.txt/);
assert.match(installer, /MCP server named sky-computer-use/);
assert.match(installer, /skills\\computer-use\\SKILL\.md/);
assert.match(installer, /server\.mjs/);
assert.match(installer, /Reading the Skill file alone is not a successful installation/);
assert.match(installer, /Do not substitute PowerShell/);
assert.match(uninstaller, /FastCUA Console\.url/);
assert.match(uninstaller, /FastCUA Agent Setup\.txt/);
assert.match(uninstaller, /Get-CimInstance Win32_Process/);
assert.match(uninstaller, /Remove-ItemProperty[^\r\n]+FastCUA/);
assert.doesNotMatch(uninstaller, /claude(?:\.exe)?|Anthropic|\.claude/i);
assert.match(web, /\\native-host\\build\.ps1/);
assert.match(web, /"sky-computer-use"/);
assert.match(selfHosting, /"sky-computer-use"/);

console.log("PASS installer contract: v0.1.3 pin, verified host, MCP handoff, self-host docs, scoped uninstall");
