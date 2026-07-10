// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const binary = path.resolve(process.argv[2] || "target/release/cua-native-host.exe");
const fixture = path.resolve(process.argv[3] || "tests/FastCuaFixture.exe");
const host = spawn(binary, ["--parent-pid", String(process.pid)], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let buffer = "";
let nextId = 1;
const pending = new Map();
host.stdout.setEncoding("utf8");
host.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});

function request(method, params, meta = {}) {
  const id = nextId++;
  host.stdin.write(`${JSON.stringify({ id, method, params, meta })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 10_000);
  });
}

try {
  const approval = await request("launch_app", { app: fixture });
  assert.equal(approval.ok, false);
  assert.equal(approval.approvalRequest?.app, fixture);

  const launched = await request("launch_app", { app: fixture }, {
    "x-oai-cua-approved-app": fixture,
  });
  assert.equal(launched.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const closed = await request("close", {});
  assert.deepEqual(closed.result, { ok: true });
  const exitCode = await new Promise((resolve) => host.once("exit", resolve));
  assert.equal(exitCode, 0);
  console.log("PASS approval retry and close lifecycle");
} finally {
  if (host.exitCode === null) host.kill();
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process FastCuaFixture -ErrorAction SilentlyContinue | Stop-Process -Force",
    ], { stdio: "ignore" });
  } catch {}
}
