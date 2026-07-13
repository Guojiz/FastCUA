import assert from "node:assert/strict";
import fs from "node:fs";

const installer = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const uninstaller = fs.readFileSync(new URL("../uninstall.ps1", import.meta.url), "utf8");

assert.match(installer, /\$Version\s*=\s*'v0\.1\.2'/);
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
assert.match(uninstaller, /FastCUA Console\.url/);
assert.match(uninstaller, /FastCUA Agent Setup\.txt/);
assert.doesNotMatch(uninstaller, /claude(?:\.exe)?|Anthropic|\.claude/i);

console.log("PASS installer contract: agent-neutral install, pinned sources, checksum, config, desktop handoff");
