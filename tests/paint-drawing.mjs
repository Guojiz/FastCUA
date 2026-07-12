import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const output = path.resolve(process.argv[2] || "audit/paint-fastcua.jpg");
const socket = net.createConnection("\\\\.\\pipe\\fastcua");
let nextId = 1, buffer = "";
const pending = new Map();

socket.setEncoding("utf8");
socket.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line), entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error?.message || message.error)) : entry.resolve(message.result); }
  }
});

function request(method, params = {}) {
  const id = nextId++;
  socket.write(JSON.stringify({ id, method, params, meta: { session_id: "paint-test", turn_id: "1", "x-oai-cua-request-budget-ms": 15000 } }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
const paintExe = process.argv[3] || process.env.PAINT_EXE || process.env.LOCALAPPDATA + "\\Microsoft\\WindowsApps\\mspaint.exe";
await request("launch_app", { app: paintExe });
let window;
for (let i = 0; i < 40 && !window; i++) {
  const windows = await request("list_windows");
  window = windows.find(item => /paint/i.test(`${item.app} ${item.title}`));
  if (!window) await sleep(250);
}
if (!window) throw new Error("Paint window did not appear");
await request("activate_window", { window });
await sleep(700);
let shot = (await request("get_window_state", { window, include_screenshot: true, include_text: false })).screenshots[0];
const w = shot.width, h = shot.height;
const x0 = Math.round(w * .25), x1 = Math.round(w * .75);
const y0 = Math.max(190, Math.round(h * .3)), y1 = Math.round(h * .82);
const cx = Math.round((x0 + x1) / 2), roof = Math.round(y0 + (y1 - y0) * .18);
const strokes = [
  [x0, roof, cx, y0], [cx, y0, x1, roof],
  [Math.round(x0 * .98), roof, x0, y1], [x1, roof, x1, y1], [x0, y1, x1, y1],
  [Math.round(w * .44), y1, Math.round(w * .44), Math.round(h * .62)],
  [Math.round(w * .44), Math.round(h * .62), Math.round(w * .56), Math.round(h * .62)],
  [Math.round(w * .56), Math.round(h * .62), Math.round(w * .56), y1],
  [Math.round(w * .31), Math.round(h * .52), Math.round(w * .39), Math.round(h * .52)],
  [Math.round(w * .35), Math.round(h * .48), Math.round(w * .35), Math.round(h * .57)],
  [Math.round(w * .61), Math.round(h * .52), Math.round(w * .69), Math.round(h * .52)],
  [Math.round(w * .65), Math.round(h * .48), Math.round(w * .65), Math.round(h * .57)],
];
for (const [from_x, from_y, to_x, to_y] of strokes) {
  await request("drag", { window, from_x, from_y, to_x, to_y, screenshotId: shot.id, duration_ms: 220 });
}
await sleep(600);
shot = (await request("get_window_state", { window, include_screenshot: true, include_text: false })).screenshots[0];
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, Buffer.from(shot.url.split(",", 2)[1], "base64"));
console.log(JSON.stringify({ output, window: window.title, size: `${shot.width}x${shot.height}`, strokes: strokes.length }));
socket.end();
