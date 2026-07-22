// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import net from "node:net";
import path from "node:path";

const base = process.argv[2] || "http://127.0.0.1:8420";
const fixture = path.resolve(process.argv[3] || "tests/FastCuaFixture.exe");

async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(parsed.error || text || response.statusText);
  return parsed;
}

async function waitFor(predicate, message, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await api("/api/state");
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${message}`);
}

class PipeClient {
  constructor(clientGroup = null) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.clientGroup = clientGroup;
    this.socket = net.connect(process.env.FASTCUA_PIPE || "\\\\.\\pipe\\fastcua");
    this.socket.setEncoding("utf8");
    this.socket.on("data", chunk => this.onData(chunk));
    this.closed = new Promise(resolve => this.socket.once("close", () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("pipe client closed"));
      }
      this.pending.clear();
      resolve();
    }));
  }

  async ready() {
    if (!this.socket.connecting) return;
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params, clientGroup: this.clientGroup }) + "\n");
    });
  }

  close() {
    this.socket.end();
  }
}

const originalConfig = await api("/api/config");
const client = new PipeClient();
await client.ready();

try {
  const crossOrigin = await fetch(base + "/api/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.com" },
    body: JSON.stringify({ action: "pause" }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await api("/api/state")).controlState, "running");
  console.log("PASS cross-origin mutations are rejected");

  assert.ok(Array.isArray(await client.request("list_windows")));
  const beforePause = await api("/api/state");
  assert.ok(beforePause.binaryPid, "native host should be resident before pause");
  await api("/api/action", { action: "pause" });
  assert.equal((await api("/api/state")).controlState, "paused_by_user");
  assert.equal((await api("/api/state")).binaryPid, null);
  await assert.rejects(client.request("list_windows"), /paused by the user/i);
  console.log("PASS manual pause aborts in-flight native work and blocks pipe requests");

  await api("/api/action", { action: "resume" });
  assert.equal((await api("/api/state")).controlState, "running");
  assert.ok(Array.isArray(await client.request("list_windows")));
  assert.ok((await api("/api/state")).binaryPid, "native host should restart lazily after resume");
  console.log("PASS one-action resume restores requests");

  await api("/api/config", { ...originalConfig, approvalPolicy: "full" });
  await client.request("launch_app", { app: fixture });
  let activeWindow;
  for (let attempt = 0; attempt < 40 && !activeWindow; attempt++) {
    activeWindow = (await client.request("list_windows")).find(window => window.title === "FastCUA Host Test Fixture");
    if (!activeWindow) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(activeWindow, "fixture window should exist for disconnect cancellation");
  const disconnecting = new PipeClient();
  await disconnecting.ready();
  const burst = Array.from({ length: 16 }, () => disconnecting.request("get_window_state", {
    window: activeWindow,
    include_screenshot: false,
    include_text: true,
  }).then(
    () => null,
    error => error,
  ));
  await new Promise((resolve, reject) => disconnecting.socket.write("", error => error ? reject(error) : resolve()));
  disconnecting.close();
  await disconnecting.closed;
  assert.ok((await Promise.all(burst)).some(Boolean), "disconnect should cancel at least one active native request");
  assert.ok(Array.isArray(await client.request("list_windows")));
  const replacementPid = (await api("/api/state")).binaryPid;
  assert.ok(replacementPid, "native host should recover after active-client disconnect");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await api("/api/state")).binaryPid, replacementPid);
  assert.ok(Array.isArray(await client.request("list_windows")));
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  console.log("PASS retired helper exit cannot clobber its replacement");

  await api("/api/config", { ...originalConfig, approvalPolicy: "safe", whitelist: originalConfig.whitelist.filter(entry => entry.toLowerCase() !== "fastcuafixture.exe") });
  const deniedRequest = client.request("launch_app", { app: fixture }).then(
    () => null,
    error => error,
  );
  const deniedState = await waitFor(state => state.controlState === "awaiting_approval", "approval state");
  assert.equal(deniedState.pendingApprovals.length, 1);
  await api("/api/action", { action: "denyApproval", token: deniedState.pendingApprovals[0].token });
  assert.match((await deniedRequest)?.message || "", /denied by user/i);
  console.log("PASS unknown app enters machine pause and can be denied");

  const allowedRequest = client.request("launch_app", { app: fixture });
  const allowedState = await waitFor(state => state.controlState === "awaiting_approval", "second approval state");
  await api("/api/action", { action: "allowOnce", token: allowedState.pendingApprovals[0].token });
  await allowedRequest;
  assert.equal((await api("/api/state")).controlState, "running");
  console.log("PASS allow-once resumes and completes the action");

  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  const orphan = new PipeClient();
  await orphan.ready();
  const orphanRequest = orphan.request("launch_app", { app: fixture }).then(
    () => null,
    error => error,
  );
  const orphanState = await waitFor(state => state.controlState === "awaiting_approval", "orphan approval state");
  const orphanToken = orphanState.pendingApprovals[0].token;
  orphan.close();
  await orphan.closed;
  await waitFor(state => state.pendingApprovals.length === 0, "orphan approval cancellation");
  assert.match((await orphanRequest)?.message || "", /closed|disconnected/i);
  await assert.rejects(
    api("/api/action", { action: "allowOnce", token: orphanToken }),
    /no longer pending/i,
  );
  console.log("PASS client disconnect revokes its pending approval");

  const trustedRequest = client.request("launch_app", { app: fixture });
  const trustedState = await waitFor(state => state.controlState === "awaiting_approval", "trusted approval state");
  await api("/api/action", { action: "allowAndWhitelist", token: trustedState.pendingApprovals[0].token });
  await trustedRequest;
  assert.ok((await api("/api/config")).whitelist.some(entry => entry.toLowerCase() === "fastcuafixture.exe"));
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  await client.request("launch_app", { app: fixture });
  assert.equal((await api("/api/state")).pendingApprovals.length, 0);
  console.log("PASS add-to-trusted persists and skips the next prompt");

  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
  await api("/api/config", { ...originalConfig, approvalPolicy: "full", whitelist: originalConfig.whitelist.filter(entry => entry.toLowerCase() !== "fastcuafixture.exe") });
  await client.request("launch_app", { app: fixture });
  const fullState = await api("/api/state");
  assert.equal(fullState.approvalPolicy, "full");
  assert.equal(fullState.pendingApprovals.length, 0);
  console.log("PASS full access runs an unknown app without prompting");

  const groupId = `control-plane-group-${Date.now()}`;
  const groupedA = new PipeClient(groupId);
  const groupedB = new PipeClient(groupId);
  await Promise.all([groupedA.ready(), groupedB.ready()]);
  await Promise.all([groupedA.request("list_windows"), groupedB.request("list_windows")]);
  await api("/api/interject", { text: "integration redirect" });
  // Interjection is a one-shot redirect instruction and auto-resumes control.
  assert.equal((await api("/api/state")).controlState, "running");
  await assert.rejects(groupedA.request("list_windows"), /integration redirect/i);
  assert.ok(Array.isArray(await groupedB.request("list_windows")));
  groupedA.close();
  groupedB.close();
  await Promise.all([groupedA.closed, groupedB.closed]);
  console.log("PASS one-shot interjection is consumed once per logical MCP client");
  await assert.rejects(client.request("list_windows"), /integration redirect/i);
  assert.ok(Array.isArray(await client.request("list_windows")));
  await client.request("close");
  await client.closed;
  const nextClient = new PipeClient();
  await nextClient.ready();
  assert.ok(Array.isArray(await nextClient.request("list_windows")));
  nextClient.close();
  console.log("PASS interjection is delivered once and auto-resumes the same client");
  console.log("PASS close ends the interrupted turn and the next client reconnects cleanly");
} finally {
  await api("/api/action", { action: "resume" }).catch(() => {});
  await api("/api/config", originalConfig).catch(() => {});
  client.close();
  try { execFileSync("taskkill.exe", ["/IM", "FastCuaFixture.exe", "/F"], { stdio: "ignore" }); } catch {}
}

console.log("12 control-plane integration checks passed.");
