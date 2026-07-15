#!/usr/bin/env node
// FastCUA one-line installer entry (npx fastcua).
// Delegates to install.ps1 on Windows — does not reimplement runtime install.

import { spawn } from "node:child_process";
import process from "node:process";

const INSTALL_URL =
  process.env.FASTCUA_INSTALL_URL ||
  "https://raw.githubusercontent.com/Guojiz/FastCUA/main/install.ps1";

function usage() {
  console.log(`FastCUA — Windows Computer Use runtime for AI agents

Usage:
  npx fastcua              Install runtime (Windows)
  npx fastcua install      Same as above
  npx fastcua help         Show this help

After install, give Desktop "FastCUA Agent Setup.txt" to your agent so it
installs both the computer-use Skill and sky-computer-use MCP.

PowerShell equivalent:
  irm ${INSTALL_URL} | iex

Docs: https://github.com/Guojiz/FastCUA
`);
}

function main() {
  const cmd = (process.argv[2] || "install").toLowerCase();
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(0);
  }
  if (cmd !== "install") {
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
  }
  if (process.platform !== "win32") {
    console.error("FastCUA currently supports Windows only (win32).");
    process.exit(1);
  }

  // Same one-liner as README; -ExecutionPolicy Bypass for typical user shells.
  const ps = `irm '${INSTALL_URL.replace(/'/g, "''")}' | iex`;
  console.log("FastCUA: running Windows installer via PowerShell…");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { stdio: "inherit", windowsHide: false },
  );
  child.on("error", (err) => {
    console.error("Failed to start PowerShell:", err.message);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

main();
