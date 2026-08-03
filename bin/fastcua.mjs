#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(root, "scripts", "manage.ps1");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function usage() {
  console.log(`FastCUA ${packageJson.version} — Windows Computer Use runtime

Usage:
  npx fastcua              Install the latest stable runtime
  npx fastcua install      Install or repair the latest stable runtime
  npx fastcua update       Update with checksum verification and rollback
  npx fastcua check        Check whether a newer stable release exists
  npx fastcua doctor       Detect mixed paths, versions, and damaged files
  npx fastcua version      Print the CLI version
  npx fastcua help         Show this help

The installed runtime checks for updates automatically at most once per day.
It only notifies; installation remains an explicit user action.
`);
}

const command = (process.argv[2] || "install").toLowerCase();
if (command === "help" || command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}
if (command === "version" || command === "-v" || command === "--version") {
  console.log(packageJson.version);
  process.exit(0);
}
if (!["install", "update", "check", "doctor"].includes(command)) {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(1);
}
if (process.platform !== "win32") {
  console.error("FastCUA currently supports Windows only (win32).");
  process.exit(1);
}
if (!fs.existsSync(manager)) {
  console.error(`FastCUA management script is missing: ${manager}`);
  process.exit(1);
}

const action = command[0].toUpperCase() + command.slice(1);
const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", manager, "-Action", action],
  { stdio: "inherit", windowsHide: false },
);
child.on("error", (error) => {
  console.error("Failed to start the FastCUA manager:", error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
