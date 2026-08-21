import { spawn } from "node:child_process";
import readline from "node:readline";
const child = spawn(process.execPath, ["server.mjs"], { cwd: new URL(".", import.meta.url), stdio: ["pipe", "pipe", "inherit"] });
function normalize(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const out = { ...value };
  if (out.type === "object" && out.additionalProperties === undefined) out.additionalProperties = false;
  if (out.properties && typeof out.properties === "object") {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([key, item]) => [key, normalize(item)]));
  }
  if (out.items) out.items = normalize(out.items);
  return out;
}
const input = readline.createInterface({ input: process.stdin });
const output = readline.createInterface({ input: child.stdout });
input.on("line", (line) => child.stdin.write(line + "\n"));
output.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.result?.tools && Array.isArray(message.result.tools)) {
      message.result.tools = message.result.tools.map((tool) => ({ ...tool, inputSchema: normalize(tool.inputSchema) }));
    }
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch {
    process.stdout.write(line + "\n");
  }
});
child.on("exit", (code) => process.exit(code || 0));
process.stdin.on("end", () => child.stdin.end());
