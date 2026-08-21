// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
const daemon = fs.readFileSync(new URL("../daemon.mjs", import.meta.url), "utf8");

assert.match(server, /name: "list_history"[\s\S]*?include_screenshots: \{ type: "boolean", default: false \}/);
assert.match(server, /name: "get_history"[\s\S]*?include_screenshots: \{ type: "boolean", default: true \}/);
assert.match(
  server,
  /case "list_history": return await sky\.list_history\(\{[^\n]*includeScreenshots: args\.include_screenshots === true \}\);/,
  "list_history must include screenshots only when explicitly requested",
);
assert.match(
  server,
  /case "get_history": return await sky\.get_history\(\{ id: args\.id, includeScreenshots: args\.include_screenshots !== false \}\);/,
  "get_history must include screenshots unless explicitly disabled",
);
assert.match(daemon, /params\?\.includeScreenshots === true \|\| params\?\.include_screenshots === true/);
assert.match(daemon, /params\?\.includeScreenshots !== false && params\?\.include_screenshots !== false/);

console.log("PASS history parameter contract: MCP snake_case translation and screenshot defaults are stable");
