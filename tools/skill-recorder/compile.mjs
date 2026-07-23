// SPDX-License-Identifier: MIT
//
// skill-recorder draft compiler — FastCUA issue #3, stages 3-4.
//
// session.jsonl (fastcua-recording/1) -> human-readable, NON-executable
// workflow draft (draft.json + draft.md) and, with --skill, an editable Skill
// draft folder (SKILL.md) that stays inert until a human approves it.
//
// Principles (beating the Cowork weaknesses):
//   * Auditable: every step keeps its semantic anchor (numeric control-type ID
//     + AutomationId + localized-name hint + value assertions) and provenance.
//   * No invented certainty: low-confidence alignment, injected spans,
//     unrecoverable text, missing narration all stay "⚠ unresolved".
//   * Redactions are never resurrected: password input is a step that says
//     "redacted", nothing more.
//   * Keyboard characters are never reconstructed from vk codes; typed text
//     comes only from UIA value snapshots (and is parameterised with
//     provenance). Command chords (letter WITH Ctrl/Alt) are named as chords —
//     never as text.
//
// Usage:
//   node tools/skill-recorder/compile.mjs <session.jsonl> [--out DIR]
//   node tools/skill-recorder/compile.mjs <session.jsonl> --skill NAME [--out DIR]

import fs from "node:fs";
import path from "node:path";

const UNRESOLVED = "⚠ unresolved";

// ---------------------------------------------------------------- parsing

function parseSession(file) {
  const raw = fs.readFileSync(file, "utf8");
  const events = [];
  const bad = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line));
    } catch {
      bad.push(i + 1);
    }
  });
  return { events, bad };
}

// ---------------------------------------------------------------- key naming

// Command-chord naming only: letters are resolved when Ctrl/Alt is held (a
// deliberate command, e.g. Ctrl+S = save), never for bare typed text.
const NAMED_KEYS = new Map([
  [0x0d, "Enter"], [0x09, "Tab"], [0x1b, "Escape"], [0x08, "Backspace"],
  [0x2e, "Delete"], [0x2d, "Insert"], [0x20, "Space"],
  [0x21, "PageUp"], [0x22, "PageDown"], [0x23, "End"], [0x24, "Home"],
  [0x25, "Left"], [0x26, "Up"], [0x27, "Right"], [0x28, "Down"],
]);
for (let f = 1; f <= 12; f++) NAMED_KEYS.set(0x6f + f, `F${f}`);

function chordName(ev) {
  const parts = [];
  if (ev.mods?.ctrl) parts.push("Ctrl");
  if (ev.mods?.alt) parts.push("Alt");
  if (ev.mods?.shift) parts.push("Shift");
  if (ev.mods?.win) parts.push("Win");
  const vk = ev.vk;
  if (NAMED_KEYS.has(vk)) parts.push(NAMED_KEYS.get(vk));
  else if (vk >= 0x41 && vk <= 0x5a) parts.push(String.fromCharCode(vk)); // chord letter
  else if (vk >= 0x30 && vk <= 0x39) parts.push(String.fromCharCode(vk));
  else parts.push(`vk-0x${vk.toString(16)}`);
  return parts.join("+");
}

// ---------------------------------------------------------------- steps

function anchorKey(a) {
  if (!a) return null;
  return `${a.control_type}:${a.hwnd}`;
}

function anchorSummary(a) {
  if (!a) return null;
  const out = {
    role: a.role,
    control_type: a.control_type,
    automation_id: a.automation_id || undefined,
    name: a.name || undefined,
    name_localized: true,
    bounds: a.bounds || undefined,
    value_class: a.value_class,
    alignment: a.alignment,
    confidence: a.confidence,
  };
  return out;
}

function buildSteps(events) {
  const steps = [];
  const notes = [];
  let i = 0;
  let typeRun = null; // {events:[], anchor, tsStart, lastTs, packet, processkey}
  let redactedRun = null; // {count, tsStart, lastTs, fg}

  const flushTypeRun = (focusEvents) => {
    if (!typeRun) return;
    const run = typeRun;
    typeRun = null;
    const warnings = [];
    if (run.packet) warnings.push("input arrived as VK_PACKET (automation-style Unicode injection)");
    if (run.processkey) warnings.push("IME composition span (VK_PROCESSKEY) — keys opaque, text read from UIA");
    if (run.events.some((e) => e.injected)) warnings.push(`${UNRESOLVED}: input was injected, not physically demonstrated`);
    if (!run.anchor) warnings.push(`${UNRESOLVED}: no UIA anchor for this typing`);
    else if (run.anchor.confidence === "low") warnings.push(`${UNRESOLVED}: low-confidence anchor alignment`);
    // Recover committed text ONLY from UIA value snapshots (never from vk).
    let observed;
    if (run.anchor?.hwnd) {
      const snap = [...focusEvents].reverse().find((f) =>
        f.uia?.value !== undefined && f.uia.hwnd === run.anchor.hwnd &&
        f.ts >= run.tsStart - 1000 && f.ts <= run.lastTs + 2500);
      if (snap) observed = snap.uia.value;
    }
    if (observed === undefined) warnings.push(`${UNRESOLVED}: typed text not recoverable from UIA value snapshots`);
    steps.push({
      n: steps.length + 1,
      ts: run.tsStart,
      action: "type",
      app: run.events[0]?.fg?.app,
      anchor: anchorSummary(run.anchor),
      key_count: run.events.length,
      observed_text: observed,
      warnings,
    });
  };
  const flushRedacted = () => {
    if (!redactedRun) return;
    const r = redactedRun;
    redactedRun = null;
    steps.push({
      n: steps.length + 1,
      ts: r.tsStart,
      action: "type",
      redacted: "password-field",
      key_count: r.count,
      app: r.app,
      warnings: ["redacted by recorder policy (password field); content never captured"],
    });
  };

  const focusEvents = events.filter((e) => e.t === "focus");

  while (i < events.length) {
    const ev = events[i];
    if (ev.t === "note") {
      notes.push(ev);
      i++;
      continue;
    }
    if (ev.t === "key_down" && ev.redacted) {
      if (typeRun) flushTypeRun(focusEvents);
      if (!redactedRun) redactedRun = { count: 0, tsStart: ev.ts, lastTs: ev.ts, app: ev.fg?.app };
      redactedRun.count++;
      redactedRun.lastTs = ev.ts;
      i++;
      continue;
    }
    // Context records (key releases, focus heartbeats, keyframes, stats,
    // media availability notes) are observations, not new user intent — they
    // must never split a run.
    const isContextRecord = ev.t === "key_up" || ev.t === "focus" || ev.t === "keyframe" || ev.t === "stats" || ev.t === "media";
    if (redactedRun && !isContextRecord) flushRedacted();

    if (ev.t === "key_down" && (ev.class === "printable" || ev.class === "ime" || ev.vk === 0x20)
      && !(ev.mods?.ctrl || ev.mods?.alt)) {
      const sameRun = typeRun && anchorKey(ev.anchor) === anchorKey(typeRun.anchor)
        && ev.ts - typeRun.lastTs <= 3000;
      if (!sameRun) {
        flushTypeRun(focusEvents);
        typeRun = { events: [], anchor: ev.anchor, tsStart: ev.ts, lastTs: ev.ts, packet: false, processkey: false };
      }
      typeRun.events.push(ev);
      typeRun.lastTs = ev.ts;
      if (ev.vk === 0xe7) typeRun.packet = true;
      if (ev.vk === 0xe5) typeRun.processkey = true;
      i++;
      continue;
    }
    if (isContextRecord) {
      i++;
      continue;
    }
    flushTypeRun(focusEvents);

    if (ev.t === "mouse_down") {
      const up = events.slice(i + 1, i + 8).find((e) =>
        e.t === "mouse_up" && e.button === ev.button && e.ts - ev.ts <= 1000);
      const warnings = [];
      if (ev.injected) warnings.push(`${UNRESOLVED}: input was injected, not physically demonstrated`);
      if (!ev.anchor) warnings.push(`${UNRESOLVED}: no UIA anchor (ElementFromPoint failed or timed out)`);
      steps.push({
        n: steps.length + 1,
        ts: ev.ts,
        action: "click",
        app: ev.fg?.app,
        button: { 1: "left", 2: "right", 3: "middle" }[ev.button] || String(ev.button),
        x: ev.x,
        y: ev.y,
        anchor: anchorSummary(ev.anchor),
        double_click: Boolean(up && up._dbl),
        warnings,
      });
      i++;
      continue;
    }
    if (ev.t === "wheel_v" || ev.t === "wheel_h") {
      steps.push({
        n: steps.length + 1,
        ts: ev.ts,
        action: "scroll",
        app: ev.fg?.app,
        direction: ev.t === "wheel_v" ? (ev.wheel > 0 ? "up" : "down") : (ev.wheel > 0 ? "right" : "left"),
        amount: Math.abs(ev.wheel),
        warnings: ev.injected ? [`${UNRESOLVED}: input was injected`] : [],
      });
      i++;
      continue;
    }
    if (ev.t === "key_down" && ev.class && ev.class !== "modifier") {
      const name = chordName(ev);
      if (name !== "Enter" || true) {
        const warnings = [];
        if (ev.injected) warnings.push(`${UNRESOLVED}: input was injected, not physically demonstrated`);
        steps.push({
          n: steps.length + 1,
          ts: ev.ts,
          action: "key",
          keys: name,
          app: ev.fg?.app,
          anchor: anchorSummary(ev.anchor),
          warnings,
        });
      }
      i++;
      continue;
    }
    i++;
  }
  flushTypeRun(focusEvents);
  flushRedacted();

  // Attach narration notes: a note explains the NEXT step within 15s; a
  // trailing note stands alone as a session annotation.
  for (const note of notes) {
    const next = steps.find((s) => s.ts >= note.ts && s.ts - note.ts <= 15_000);
    if (next) {
      (next.intent = next.intent || []).push(note.text);
    } else {
      steps.push({
        n: 0, // renumbered below
        ts: note.ts,
        action: "note",
        text: note.text,
        warnings: [`${UNRESOLVED}: narration not tied to a following step`],
      });
    }
  }
  steps.sort((a, b) => a.ts - b.ts);
  steps.forEach((s, idx) => { s.n = idx + 1; });
  return { steps, notes };
}

// ---------------------------------------------------------------- parameters

const DATE_RE = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/;
const FILE_RE = /\b[\w][\w .-]*\.[A-Za-z0-9]{1,6}\b/;

function inferParameters(steps) {
  const params = [];
  for (const step of steps) {
    if (step.action !== "type" || !step.observed_text) continue;
    let text = step.observed_text;
    const claims = [];
    let m;
    if ((m = DATE_RE.exec(text))) claims.push({ kind: "date", value: m[0], name: "date" });
    if ((m = FILE_RE.exec(text))) claims.push({ kind: "filename", value: m[0], name: "filename" });
    if (!claims.length && text.trim()) {
      claims.push({ kind: "text", value: text.trim().slice(0, 80), name: `text_${params.length + 1}` });
    }
    for (const c of claims) {
      let name = c.name;
      let suffix = 2;
      while (params.some((p) => p.name === name)) name = `${c.name}_${suffix++}`;
      params.push({
        name,
        kind: c.kind,
        observed: c.value,
        provenance: { step: step.n, source: "typed-value (UIA snapshot)", anchor: step.anchor?.role },
      });
      step.text = (step.text ?? text).split(c.value).join(`{{${name}}}`);
    }
    step.text = step.text ?? text;
  }
  return params;
}

// ---------------------------------------------------------------- draft

function sessionWarnings(steps, notes, events) {
  const warnings = [];
  if (!notes.length) warnings.push(`${UNRESOLVED}: no narration notes — intents are structural guesses, not teacher explanation`);
  const actionable = steps.filter((s) => ["click", "type", "key", "scroll"].includes(s.action));
  const injected = actionable.filter((s) => s.warnings.some((w) => w.includes("injected")));
  if (actionable.length && injected.length / actionable.length > 0.5) {
    warnings.push(`${UNRESOLVED}: ${injected.length}/${actionable.length} steps were injected input (automation-driven span) — needs human re-demo or explicit review`);
  }
  const redacted = events.filter((e) => e.redacted).length;
  if (redacted) warnings.push(`redaction: ${redacted} key events were redacted in a password field and are unrecoverable by design`);
  return warnings;
}

function stepLine(s) {
  const intent = s.intent?.length ? ` — intent: ${s.intent.join("; ")}` : "";
  const anchor = s.anchor
    ? `${s.anchor.role}(${s.anchor.control_type})${s.anchor.automation_id ? ` #${s.anchor.automation_id}` : ""}${s.anchor.name ? ` "${s.anchor.name}"` : ""}`
    : "(no anchor)";
  switch (s.action) {
    case "click":
      return `${s.n}. Click ${s.button} at (${s.x},${s.y}) on ${anchor}${intent}`;
    case "type":
      if (s.redacted) return `${s.n}. Type into password field — REDACTED (content never captured)${intent}`;
      return `${s.n}. Type \`${s.text ?? "??"}\` into ${anchor}${s.observed_text === undefined ? " (text unrecovered)" : ""}${intent}`;
    case "key":
      return `${s.n}. Press ${s.keys}${s.anchor ? ` on ${anchor}` : ""}${intent}`;
    case "scroll":
      return `${s.n}. Scroll ${s.direction} ×${s.amount}${intent}`;
    case "note":
      return `${s.n}. NOTE: ${s.text}`;
    default:
      return `${s.n}. ${s.action}${intent}`;
  }
}

function compileSession(sessionPath, outDir) {
  const { events, bad } = parseSession(sessionPath);
  const header = events.find((e) => e.t === "header");
  const formatOk = header?.format === "fastcua-recording/1";
  const { steps, notes } = buildSteps(events);
  const parameters = inferParameters(steps);
  const warnings = sessionWarnings(steps, notes, events);
  if (!formatOk) warnings.unshift(`${UNRESOLVED}: session header missing or unknown format (expected fastcua-recording/1)`);
  if (bad.length) warnings.push(`${UNRESOLVED}: ${bad.length} unparseable JSONL lines (${bad.slice(0, 5).join(",")})`);

  const keyframes = events.filter((e) => e.t === "keyframe" && !e.suppressed && e.path);
  // Media layout: header.media declares the intended files (null when the
  // track was disabled with --no-video/--no-audio); t:media records then
  // report runtime availability. Audio is best-effort — an "unavailable"
  // record downgrades the path to null and keeps the reason. Paths are
  // session-relative so drafts stay movable and reviewable anywhere.
  const headerMedia = header?.media || {};
  const mediaRecords = events.filter((e) => e.t === "media");
  const audioRec = mediaRecords.find((e) => e.kind === "audio");
  const audioUnavailable = audioRec?.status === "unavailable";
  const media = {
    video: headerMedia.video || null,
    video_index: headerMedia.video_index || null,
    audio: audioUnavailable ? null : headerMedia.audio || null,
    audio_note: audioUnavailable
      ? `unavailable: ${audioRec.detail}`
      : headerMedia.audio
        ? audioRec?.detail || headerMedia.audio_note || null
        : null,
    keyframes: "keyframes",
  };
  // App scope: the exact set of applications the demonstration touched. A
  // recorded workflow may never exceed this scope — the dry-run runner refuses
  // out-of-scope steps outright, and the daemon whitelist enforces it again
  // at execution time.
  const scopeApps = [...new Set(steps.map((s) => s.app).filter(Boolean))];
  const draft = {
    format: "fastcua-skill-draft/1",
    source: path.resolve(sessionPath),
    generated_ts: Date.now(),
    executable: false,
    verified: false,
    scope: { apps: scopeApps },
    steps,
    parameters,
    warnings,
    media,
    stats: {
      events: events.length,
      steps: steps.length,
      notes: notes.length,
      redacted_events: events.filter((e) => e.redacted).length,
      keyframes: keyframes.length,
      keyframe_bytes: keyframes.reduce((a, k) => a + (k.bytes || 0), 0),
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  const draftJson = path.join(outDir, "draft.json");
  const draftMd = path.join(outDir, "draft.md");
  fs.writeFileSync(draftJson, JSON.stringify(draft, null, 2) + "\n");

  const md = [
    `# Workflow draft (UNVERIFIED — 草稿未验证)`,
    ``,
    `- source: \`${draft.source}\``,
    `- generated: ${new Date(draft.generated_ts).toISOString()} · format fastcua-skill-draft/1 · **non-executable**`,
    ``,
    `## Warnings`,
    ...(warnings.length ? warnings.map((w) => `- ${w}`) : ["- (none)"]),
    ``,
    `## Steps`,
    ...steps.map(stepLine),
    ``,
    `## App scope`,
    ...(scopeApps.length ? scopeApps.map((a) => `- \`${a}\``) : ["- (none recorded)"]),
    `- a replay may never touch apps outside this list (dry-run refuses; daemon whitelist enforces again)`,
    ``,
    `## Parameters`,
    ...(parameters.length
      ? parameters.map((p) => `- \`{{${p.name}}}\` (${p.kind}) — observed \`${p.observed}\` at step ${p.provenance.step} (${p.provenance.source})`)
      : ["- (none inferred)"]),
    ``,
    `## Keyframes`,
    `- ${keyframes.length} JPEG frames in \`${path.join(path.dirname(sessionPath), "keyframes")}\``,
    ``,
    `## Media (review aids — never embedded)`,
    `- video: ${media.video ? `\`${media.video}\` (MJPEG AVI; per-frame index at \`${media.video_index}\`)` : "(not recorded)"}`,
    `- audio: ${media.audio ? `\`${media.audio}\` (PCM 16kHz mono narration)` : `(none)${media.audio_note ? ` — ${media.audio_note}` : ""}`}`,
    `- extract a frame: \`node tools/skill-recorder/frame-extract.mjs <session-dir> --note 1\``,
    ``,
  ].join("\n");
  fs.writeFileSync(draftMd, md);
  return { draft, draftJson, draftMd };
}

// ---------------------------------------------------------------- skill folder

function skillMd(name, draft, sessionPath) {
  const description = draft.steps.find((s) => s.intent?.length)?.intent[0]
    || "Recorded demonstration workflow (UNVERIFIED DRAFT — 草稿未验证)";
  const paramsTable = draft.parameters.length
    ? [
        "| parameter | kind | observed during recording | provenance |",
        "|---|---|---|---|",
        ...draft.parameters.map((p) =>
          `| \`{{${p.name}}}\` | ${p.kind} | \`${p.observed}\` | step ${p.provenance.step}, ${p.provenance.source} |`),
      ].join("\n")
    : "_No parameters inferred._";
  const stepsMd = draft.steps.map((s) => {
    const warn = s.warnings.length ? `\n   - ${s.warnings.join("\n   - ")}` : "";
    return `${stepLine(s)}${warn}`;
  }).join("\n");
  return `---
name: ${name}
description: ${JSON.stringify(description).slice(1, -1)}
verified: false
---

> [!WARNING]
> **草稿未验证 / UNVERIFIED DRAFT** — 本 Skill 由演示录制自动生成，从未端到端运行验证。
> 人工审查并测试每一步之前，不要依赖它执行任何操作。
> This skill was generated from a recorded demonstration and has NEVER been
> tested end-to-end. Review and test every step before relying on it.

# ${name}

## Intent / 意图

${draft.steps.filter((s) => s.intent?.length).map((s) => `- step ${s.n}: ${s.intent.join("; ")}`).join("\n") || "- ⚠ unresolved: no narration notes recorded; intent is a structural guess."}

## Steps / 步骤

${stepsMd}

## Parameters / 参数

${paramsTable}

## Review aids / 审查辅助

The recording session also captured **review media**, kept next to the source
session (NOT copied into this folder, and never embedded in this file):

${[
  draft.media.video
    ? `- video: \`${path.join(path.dirname(sessionPath), draft.media.video)}\` — MJPEG AVI of the demo (per-frame index: \`${path.join(path.dirname(sessionPath), draft.media.video_index)}\`)`
    : null,
  draft.media.audio
    ? `- audio: \`${path.join(path.dirname(sessionPath), draft.media.audio)}\` — PCM 16kHz mono narration. Listen to it during review; transcription is out of scope.`
    : draft.media.audio_note
      ? `- audio: none (${draft.media.audio_note})`
      : null,
].filter(Boolean).join("\n") || "- (no media recorded)"}

When a step is unclear, an agent may LOOK at the corresponding moment instead
of guessing:

\`\`\`
node tools/skill-recorder/frame-extract.mjs ${JSON.stringify(path.dirname(sessionPath))} --note 1
\`\`\`

(Also \`--at-ms <epoch-ms>\` or \`--at <ISO-8601>\`.) Moments that were redacted
(password focus, secure desktop) have no pixels by design — the extractor will
say so. Media exists to help human review; a replay must never depend on it.

## Semantic anchors / 语义锚点

Steps locate controls by **numeric UIA control-type ID + AutomationId +
bounds**, with localized names as display hints only (names change with
display language; "Edit"(50004) and "Document"(50030) are both accepted for
text editors). Steps whose anchor is missing or low-confidence are marked
⚠ unresolved and MUST be re-anchored by a human before use.

## Safety boundaries / 安全边界

- Runs under the FastCUA approval policy: the app whitelist is inherited from
  the daemon config; this skill cannot widen it or self-escalate.
- App scope is fixed at record time (${draft.scope.apps.length} app(s): ${draft.scope.apps.map((a) => `\`${a.split("\\").pop()}\``).join(", ") || "none"}); a replay that
  would touch anything outside it is refused before execution.
- Password-field input was redacted at record time; no secret is present in
  this folder and none may be reconstructed.
- Spans recorded as injected input (another automation driving) are flagged
  ⚠ unresolved — treat them as unverified by default.
- Nothing here auto-installs or auto-runs: this folder is inert documentation
  until a human reviews it and copies it into a skills directory.

## Source / 来源

- session: \`${path.resolve(sessionPath)}\` (format fastcua-recording/1)
- draft: \`${path.resolve(path.join(path.dirname(sessionPath), "draft.json"))}\`
- keyframes: \`${path.join(path.dirname(sessionPath), "keyframes")}\` (${draft.stats.keyframes} JPEG frames)
- compiled: ${new Date(draft.generated_ts).toISOString()} by tools/skill-recorder/compile.mjs
`;
}

function generateSkill(name, draft, sessionPath, outDir) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
    throw new Error(`invalid skill name "${name}" (lowercase letters, digits, dashes)`);
  }
  const dir = path.join(outDir, "skill-draft", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, skillMd(name, draft, sessionPath));
  return { dir, file };
}

// ---------------------------------------------------------------- cli

function main() {
  const args = process.argv.slice(2);
  const sessionPath = args.find((a) => !a.startsWith("--"));
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    console.error("usage: node compile.mjs <session.jsonl> [--skill NAME] [--out DIR]");
    process.exit(2);
  }
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = path.resolve(opt("--out") || path.dirname(sessionPath));
  const { draft, draftJson, draftMd } = compileSession(sessionPath, outDir);
  console.log(`[compile] steps=${draft.stats.steps} params=${draft.parameters.length} warnings=${draft.warnings.length}`);
  console.log(`[compile] draft: ${draftJson}`);
  console.log(`[compile] draft: ${draftMd}`);
  const skillName = opt("--skill");
  if (skillName) {
    const { dir, file } = generateSkill(skillName, draft, sessionPath, outDir);
    console.log(`[compile] skill draft folder (inert, verified:false): ${dir}`);
    console.log(`[compile] SKILL.md: ${file}`);
  }
}

main();
