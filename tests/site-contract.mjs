// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
for (const relative of [
  "web.html",
  "card.xaml",
  "overlay.ps1",
  "scripts/console.ps1",
  "site/index.html",
]) {
  assert.equal(fs.existsSync(new URL(relative, root)), false, `${relative} must stay removed`);
}
for (const relative of ["daemon.mjs", "server.mjs", "lib/history.mjs", "config.json"]) {
  assert.equal(fs.existsSync(new URL(relative, root)), true, `${relative} must be packaged`);
}

console.log("PASS headless contract: deleted UI assets stay removed and history runtime files remain present");