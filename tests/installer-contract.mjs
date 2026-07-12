import assert from "node:assert/strict";
import fs from "node:fs";

const installer = fs.readFileSync(new URL("../install.ps1", import.meta.url), "utf8");
const uninstaller = fs.readFileSync(new URL("../uninstall.ps1", import.meta.url), "utf8");

assert.match(installer, /\$Version\s*=\s*'v0\.1\.1'/);
assert.match(installer, /archive\/refs\/tags\/\$Version\.zip/);
assert.match(installer, /releases\/download\/\$Version/);
assert.doesNotMatch(installer, /refs\/heads\/main|releases\/latest/);
assert.match(installer, /Get-FileHash[^\r\n]+SHA256/);
assert.match(installer, /\$savedConfig/);
assert.match(installer, /FastCUA Console\.url/);
assert.match(installer, /URL=http:\/\/127\.0\.0\.1:8420/);
assert.match(uninstaller, /FastCUA Console\.url/);

console.log("PASS installer contract: v0.1.1 sources, checksum, config preservation, desktop shortcut");
