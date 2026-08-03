import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fastcua-identity-"));
const pipe = `\\\\.\\pipe\\fastcua-identity-${crypto.randomUUID()}`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connectWithRetry(target, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(target);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("daemon pipe did not become ready");
}

const port = await freePort();
const configPath = path.join(temp, "config.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    costartMode: "manual",
    port,
    overlayEnabled: false,
    checkForUpdates: false,
  }),
);
const nativeHostFixture = path.join(temp, "cua-native-host-fixture.exe");
fs.writeFileSync(nativeHostFixture, "");
const child = spawn(process.execPath, [path.join(root, "daemon.mjs")], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    FASTCUA_PIPE: pipe,
    FASTCUA_HTTP_PORT: String(port),
    FASTCUA_CONFIG_PATH: configPath,
    FASTCUA_HOME: path.join(temp, "data"),
    FASTCUA_DISABLE_OVERLAY: "1",
    CUA_BIN: nativeHostFixture,
  },
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  const socket = await connectWithRetry(pipe);
  socket.setEncoding("utf8");
  const result = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("runtime_info timed out")), 5_000);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("error", reject);
    socket.write(
      JSON.stringify({
        id: 1,
        method: "runtime_info",
        params: {},
        clientGroup: "runtime-identity-contract",
      }) + "\n",
    );
  });
  socket.destroy();
  assert.equal(result.error, undefined);
  assert.equal(result.result.version, "0.3.0");
  assert.equal(result.result.buildType, "development");
  assert.equal(path.resolve(result.result.root), root);
  assert.equal(result.result.pipe, pipe);
  assert.equal(result.result.httpPort, port);
  assert.equal(path.resolve(result.result.dataDir), path.join(temp, "data"));
  assert.equal(path.resolve(result.result.nativeHostPath), nativeHostFixture);
  console.log("PASS runtime identity integration: daemon reports one coherent root, version, pipe, port, data directory, and native host");
} catch (error) {
  error.message += `\ndaemon stderr:\n${stderr}`;
  throw error;
} finally {
  child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
