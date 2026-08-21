#!/usr/bin/env node
// frame-extract.mjs — pull a single frame out of a skill-recorder session's
// video track as a JPEG, so an agent (or the reviewing user) can LOOK at a
// chosen moment of the demonstration without playing the whole video.
//
// Usage:
//   node frame-extract.mjs <session-dir> --at-ms <epoch-ms> [--out file.jpg]
//   node frame-extract.mjs <session-dir> --at <ISO-8601>   [--out file.jpg]
//   node frame-extract.mjs <session-dir> --note <N>        [--out file.jpg]
//
// Selection rule: the index entry with the largest ts <= T wins. If that
// entry is a redaction gap (password focus / secure desktop), no frame is
// written; the tool explains the redaction and exits 4. --note N uses the
// timestamp of the Nth (1-based) narration note in session.jsonl.
//
// Exit codes: 0 frame written; 2 usage/index error; 3 target moment precedes
// the first video entry; 4 moment is redacted (by design, nothing to show).

import fs from 'node:fs';
import path from 'node:path';

function fail(msg, code) {
  console.error(`frame-extract: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
const sessionDir = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (!sessionDir) fail('usage: frame-extract.mjs <session-dir> (--at-ms N | --at ISO | --note N) [--out file.jpg]', 2);

const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const indexPath = path.join(sessionDir, 'video', 'index.jsonl');
if (!fs.existsSync(indexPath)) {
  fail(`no video index at ${indexPath} (was this session recorded without --no-video?)`, 2);
}

// --- resolve target timestamp T -------------------------------------------
let T = null;
let viaNote = null;
if (opt('--at-ms') != null) {
  T = Number(opt('--at-ms'));
  if (!Number.isFinite(T)) fail(`--at-ms value is not a number: ${opt('--at-ms')}`, 2);
} else if (opt('--at') != null) {
  T = Date.parse(opt('--at'));
  if (!Number.isFinite(T)) fail(`--at value is not a parseable date: ${opt('--at')}`, 2);
} else if (opt('--note') != null) {
  const n = Number(opt('--note'));
  if (!Number.isInteger(n) || n < 1) fail(`--note must be a 1-based integer, got: ${opt('--note')}`, 2);
  const sessPath = path.join(sessionDir, 'session.jsonl');
  if (!fs.existsSync(sessPath)) fail(`no session.jsonl at ${sessPath}`, 2);
  const notes = fs.readFileSync(sessPath, 'utf8')
    .split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.t === 'note');
  if (n > notes.length) fail(`session has ${notes.length} note(s); --note ${n} is out of range`, 2);
  viaNote = { n, text: notes[n - 1].text };
  T = notes[n - 1].ts ?? notes[n - 1].unix_ms;
  if (!Number.isFinite(T)) fail(`note ${n} has no usable timestamp`, 2);
} else {
  fail('one of --at-ms / --at / --note is required', 2);
}

// --- pick the index entry with largest ts <= T -----------------------------
const entries = fs.readFileSync(indexPath, 'utf8')
  .split(/\r?\n/).filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && typeof r.ts === 'number' && (r.kind === 'frame' || (r.kind || '').startsWith('redacted-gap')));

let best = null;
for (const e of entries) {
  if (e.ts <= T && (!best || e.ts > best.ts)) best = e;
}
if (!best) {
  const first = entries[0];
  fail(`target moment ${new Date(T).toISOString()} precedes the first video entry (${first ? new Date(first.ts).toISOString() : 'none'}); the video track starts later`, 3);
}

// --- redaction gate: never reconstruct a suppressed moment ------------------
if (best.kind !== 'frame') {
  const reason = best.reason || 'redacted';
  console.log(JSON.stringify({
    ok: false,
    redacted: true,
    reason,
    at: new Date(best.ts).toISOString(),
    requested: new Date(T).toISOString(),
    message: `The moment at ${new Date(best.ts).toISOString()} was suppressed by the recorder's redaction layer (${reason}). No pixels exist for it — this is intentional, not a failure.`,
  }, null, 2));
  process.exit(4);
}

// --- slice the JPEG out of the AVI by stored offset/length ------------------
const aviPath = path.join(sessionDir, 'video', 'video.avi');
if (!fs.existsSync(aviPath)) fail(`index references frames but ${aviPath} is missing`, 2);

const fd = fs.openSync(aviPath, 'r');
let buf;
try {
  buf = Buffer.alloc(best.len);
  const read = fs.readSync(fd, buf, 0, best.len, best.off);
  if (read !== best.len) fail(`short read at offset ${best.off}: got ${read}/${best.len} bytes`, 2);
} finally {
  fs.closeSync(fd);
}
if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
  fail(`bytes at offset ${best.off} are not a well-formed JPEG (missing SOI/EOI markers) — index/AVI mismatch?`, 2);
}

const outPath = opt('--out')
  ? path.resolve(opt('--out'))
  : path.join(sessionDir, 'keyframes', `extract-${best.i}-${best.ts}.jpg`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buf);

console.log(JSON.stringify({
  ok: true,
  frame: best.i,
  at: new Date(best.ts).toISOString(),
  requested: new Date(T).toISOString(),
  note: viaNote || undefined,
  bytes: buf.length,
  out: outPath,
}, null, 2));
