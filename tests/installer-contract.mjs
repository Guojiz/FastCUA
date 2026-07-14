import assert from "node:assert/strict";
import fs from "node:fs";

const installer = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const uninstaller = fs.readFileSync(new URL("../uninstall.ps1", import.meta.url), "utf8");
const web = fs.readFileSync(new URL("../web.html", import.meta.url), "utf8");
const selfHosting = fs.readFileSync(new URL("../docs/SELF_HOSTING.md", import.meta.url), "utf8");
const selfHostingZh = fs.readFileSync(new URL("../docs/SELF_HOSTING_zh.md", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const readmeZh = fs.readFileSync(new URL("../README_zh.md", import.meta.url), "utf8");

assert.match(installer, /\$Version\s*=\s*'v0\.1\.9'/);
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
assert.match(installer, /skills\\computer-use/);
assert.match(installer, /A successful FastCUA setup requires BOTH the Skill and the MCP server/i);
assert.match(installer, /configure this agent's own active Skill system and MCP configuration/i);
assert.match(installer, /Install the complete FastCUA Skill folder/i);
assert.match(installer, /Do not merely read SKILL\.md/i);
assert.match(installer, /Do not create a forwarding, wrapper, summary, or shortened SKILL\.md/i);
assert.match(installer, /recursively compare the installed relative file list and SHA-256 hashes/i);
assert.match(installer, /Partial installation is a failure/i);
assert.match(installer, /active computer-use Skill resolves to the complete installed folder, not a forwarding stub/i);
assert.match(installer, /call list_windows through sky-computer-use/i);
assert.match(installer, /If this AI client cannot install or register local Skills/i);
assert.match(installer, /Do not substitute PowerShell/);

assert.match(uninstaller, /FastCUA Console\.url/);
assert.match(uninstaller, /FastCUA Agent Setup\.txt/);
assert.match(uninstaller, /Get-CimInstance Win32_Process/);
assert.match(uninstaller, /Remove-ItemProperty[^\r\n]+FastCUA/);
assert.doesNotMatch(uninstaller, /claude(?:\.exe)?|Anthropic|\.claude/i);

assert.match(web, /\\native-host\\build\.ps1/);
assert.match(web, /"sky-computer-use"/);
assert.match(selfHosting, /default installation target is \*\*the agent currently executing the setup instructions\*\*/i);
assert.match(selfHosting, /complete installation requires both the Skill and the MCP server/i);
assert.match(selfHosting, /copy, link, or register the entire `computer-use` folder/i);
assert.match(selfHosting, /forwarding, wrapper, summary, or shortened `SKILL\.md`/i);
assert.match(selfHosting, /installed relative file list and SHA-256 hashes/i);
assert.match(selfHosting, /`list_windows` called through `sky-computer-use`/i);
assert.match(selfHostingZh, /默认安装目标是\*\*当前执行部署指令的 Agent 自己\*\*/);
assert.match(selfHostingZh, /完整安装必须同时包含 Skill 和 MCP/);
assert.match(readme, /install both the complete `computer-use` Skill and the `sky-computer-use` MCP server/i);
assert.match(readmeZh, /必须把完整 `computer-use` Skill 和 `sky-computer-use` MCP Server 都安装到自己的活动配置中/);

console.log("PASS installer contract: v0.1.9 pin, verified host, mandatory self Skill + MCP setup prompt, scoped uninstall");
