// SPDX-License-Identifier: MIT
//
// skill-recorder draft compiler — FastCUA issue #3, stages 3-4.
//
// session.jsonl (fastcua-recording/1) -> human-readable, NON-executable
// evidence package (evidence.json + evidence.md) plus the deterministic replay
// draft. --skill writes only a synthesis request; a dedicated agent writes SKILL.md.
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

const DRAG_MIN_DISPLACEMENT_PX = 6;
const DRAG_MIN_PATH_PX = 10;
const DRAG_MAX_DURATION_MS = 30_000;
const DRAG_PATH_POINT_LIMIT = 32;

function distance(a, b) {
  return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y));
}

function pointerPoint(ev) {
  const point = {
    screen_x: ev.x,
    screen_y: ev.y,
  };
  const bounds = ev.fg?.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4) return point;
  const [left, top, right, bottom] = bounds.map(Number);
  const width = right - left;
  const height = bottom - top;
  if (![left, top, right, bottom].every(Number.isFinite) || width <= 0 || height <= 0) return point;
  const windowX = Number(ev.x) - left;
  const windowY = Number(ev.y) - top;
  return {
    ...point,
    window_x: windowX,
    window_y: windowY,
    window_width: width,
    window_height: height,
    x_ratio: windowX / width,
    y_ratio: windowY / height,
    inside_window: windowX >= 0 && windowY >= 0 && windowX < width && windowY < height,
  };
}

function sampleGesturePath(events, startTs) {
  if (events.length <= DRAG_PATH_POINT_LIMIT) {
    return events.map((ev) => ({ ...pointerPoint(ev), dt_ms: Math.max(0, ev.ts - startTs) }));
  }
  const indexes = new Set([0, events.length - 1]);
  for (let n = 1; n < DRAG_PATH_POINT_LIMIT - 1; n++) {
    indexes.add(Math.round(n * (events.length - 1) / (DRAG_PATH_POINT_LIMIT - 1)));
  }
  return [...indexes].sort((a, b) => a - b)
    .map((index) => ({ ...pointerPoint(events[index]), dt_ms: Math.max(0, events[index].ts - startTs) }));
}

function pointerGesture(events, downIndex) {
  const down = events[downIndex];
  const moves = [];
  let up = null;
  let upIndex = -1;
  for (let j = downIndex + 1; j < events.length; j++) {
    const candidate = events[j];
    if (Number.isFinite(candidate.ts) && candidate.ts - down.ts > DRAG_MAX_DURATION_MS) break;
    if (candidate.t === "mouse_down" && candidate.button === down.button) break;
    if (candidate.t === "mouse_move") moves.push({ event: candidate, index: j });
    if (candidate.t === "mouse_up" && candidate.button === down.button) {
      up = candidate;
      upIndex = j;
      break;
    }
  }
  const pointEvents = [down, ...moves.map((entry) => entry.event), ...(up ? [up] : [])];
  const displacement = up ? distance(down, up) : 0;
  const maxDisplacement = pointEvents.reduce((max, point) => Math.max(max, distance(down, point)), 0);
  const pathLength = pointEvents.slice(1)
    .reduce((total, point, index) => total + distance(pointEvents[index], point), 0);
  return {
    down,
    moves,
    up,
    upIndex,
    pointEvents,
    displacement,
    maxDisplacement,
    pathLength,
    isDrag: Boolean(up && (maxDisplacement >= DRAG_MIN_DISPLACEMENT_PX || pathLength >= DRAG_MIN_PATH_PX)),
  };
}

function buildSteps(events) {
  const steps = [];
  const notes = [];
  const consumedPointerEvents = new Set();
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
    // Virtual elements (Excel cells) all share hwnd 0, so an AutomationId —
    // when the anchor has one — must participate in the match, and
    // "departed" snapshots (value read after focus left) count too.
    let observed;
    if (run.anchor) {
      const sameElement = (f) =>
        f.uia?.value !== undefined &&
        f.uia.hwnd === run.anchor.hwnd &&
        (run.anchor.automation_id ? f.uia.automation_id === run.anchor.automation_id : true) &&
        (run.anchor.control_type ? f.uia.control_type === run.anchor.control_type : true);
      // Stage 1: the DEPARTED snapshot is authoritative — it is the value
      // re-read after focus left, i.e. after the control committed. Burst
      // typing (one SendInput span) ends the run instantly while the commit
      // lands seconds later, so allow a generous post-run window.
      const departed = [...focusEvents].reverse().find((f) =>
        f.trigger === "departed" && sameElement(f) && f.ts >= run.lastTs && f.ts <= run.lastTs + 8000);
      // Stage 2 (legacy): latest snapshot of any trigger near the run.
      const snap = departed || [...focusEvents].reverse().find((f) =>
        sameElement(f) && f.ts >= run.tsStart - 1000 && f.ts <= run.lastTs + 3000);
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
    if (consumedPointerEvents.has(i)) {
      i++;
      continue;
    }
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
      const gesture = pointerGesture(events, i);
      for (const move of gesture.moves) consumedPointerEvents.add(move.index);
      if (gesture.upIndex >= 0) consumedPointerEvents.add(gesture.upIndex);
      const warnings = [];
      if (gesture.pointEvents.some((event) => event.injected)) {
        warnings.push(`${UNRESOLVED}: input was injected, not physically demonstrated`);
      }
      if (!ev.anchor) warnings.push(`${UNRESOLVED}: no UIA anchor (ElementFromPoint failed or timed out)`);
      const button = { 1: "left", 2: "right", 3: "middle" }[ev.button] || String(ev.button);
      if (gesture.isDrag) {
        if (!gesture.up?.anchor) warnings.push(`${UNRESOLVED}: no UIA anchor at drag endpoint`);
        const from = pointerPoint(ev);
        const to = pointerPoint(gesture.up);
        if (from.inside_window !== true || to.inside_window !== true) {
          warnings.push(`${UNRESOLVED}: drag point cannot be safely rebased to the recorded window`);
        }
        if (gesture.up?.fg?.hwnd !== ev.fg?.hwnd) {
          warnings.push(`${UNRESOLVED}: drag crossed foreground windows`);
        }
        const straightness = gesture.pathLength > 0 ? gesture.displacement / gesture.pathLength : 1;
        if (straightness < 0.85) {
          warnings.push(`${UNRESOLVED}: captured drag path is curved; current replay uses the recorded endpoints`);
        }
        steps.push({
          n: steps.length + 1,
          ts: ev.ts,
          action: "drag",
          app: ev.fg?.app,
          window_title: ev.fg?.title,
          button,
          anchor: anchorSummary(ev.anchor),
          end_anchor: anchorSummary(gesture.up?.anchor),
          from,
          to,
          path: sampleGesturePath(gesture.pointEvents, ev.ts),
          path_points_recorded: gesture.pointEvents.length,
          duration_ms: Math.max(0, gesture.up.ts - ev.ts),
          displacement_px: Math.round(gesture.displacement * 10) / 10,
          path_length_px: Math.round(gesture.pathLength * 10) / 10,
          warnings,
        });
      } else {
        if (!gesture.up) warnings.push(`${UNRESOLVED}: mouse_up was not observed; click/drag boundary is ambiguous`);
        steps.push({
          n: steps.length + 1,
          ts: ev.ts,
          action: "click",
          app: ev.fg?.app,
          window_title: ev.fg?.title,
          button,
          x: ev.x,
          y: ev.y,
          point: pointerPoint(ev),
          anchor: anchorSummary(ev.anchor),
          double_click: Boolean(gesture.up && gesture.up._dbl),
          warnings,
        });
      }
      i++;
      continue;
    }
    if (ev.t === "wheel_v" || ev.t === "wheel_h") {
      const point = pointerPoint(ev);
      const warnings = ev.injected ? [`${UNRESOLVED}: input was injected`] : [];
      if (point.inside_window !== true) {
        warnings.push(`${UNRESOLVED}: wheel point cannot be safely rebased to the recorded window`);
      }
      steps.push({
        n: steps.length + 1,
        ts: ev.ts,
        action: "scroll",
        input: "wheel",
        app: ev.fg?.app,
        window_title: ev.fg?.title,
        axis: ev.t === "wheel_v" ? "vertical" : "horizontal",
        delta: ev.wheel,
        direction: ev.t === "wheel_v" ? (ev.wheel > 0 ? "up" : "down") : (ev.wheel > 0 ? "right" : "left"),
        amount: Math.abs(ev.wheel),
        point,
        warnings,
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
      // 400 matches the recorder's own value-snapshot cap — 80 truncated
      // legitimate paths, and truncated params replay corrupted text.
      claims.push({ kind: "text", value: text.trim().slice(0, 400), name: `text_${params.length + 1}` });
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
  const actionable = steps.filter((s) => ["click", "drag", "type", "key", "scroll"].includes(s.action));
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
    case "drag":
      return `${s.n}. Drag ${s.button} from (${s.from.screen_x},${s.from.screen_y}) on ${anchor} to (${s.to.screen_x},${s.to.screen_y}) on ${s.end_anchor?.role || "(no end anchor)"}; path ${s.path_points_recorded} points/${s.duration_ms} ms${intent}`;
    case "type":
      if (s.redacted) return `${s.n}. Type into password field — REDACTED (content never captured)${intent}`;
      return `${s.n}. Type \`${s.text ?? "??"}\` into ${anchor}${s.observed_text === undefined ? " (text unrecovered)" : ""}${intent}`;
    case "key":
      return `${s.n}. Press ${s.keys}${s.anchor ? ` on ${anchor}` : ""}${intent}`;
    case "scroll":
      return `${s.n}. Wheel ${s.axis} ${s.direction} ×${s.amount} at (${s.point.screen_x},${s.point.screen_y})${intent}`;
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
  const evidence = {
    format: "fastcua-skill-evidence/1",
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
    citation_contract: {
      step: "[evidence:step:<n>]",
      step_warning: "[evidence:step-warning:<n>:<index>]",
      parameter: "[evidence:param:<name>]",
      warning: "[evidence:warning:<index>]",
      rules: [
        "Cite every recorded step exactly where the Skill instructs that action.",
        "Cite every parameter and preserve its recorded provenance.",
        "Do not invent controls, app scope, values, success claims, or safety guarantees.",
      ],
    },
  };
  // draft.json remains the deterministic replay/acceptance artifact. The
  // evidence package is the only input to the natural-language writer.
  const draft = {
    ...evidence,
    format: "fastcua-skill-draft/1",
    evidence_format: evidence.format,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const evidenceJson = path.join(outDir, "evidence.json");
  const evidenceMd = path.join(outDir, "evidence.md");
  const draftJson = path.join(outDir, "draft.json");
  const draftMd = path.join(outDir, "draft.md");
  fs.writeFileSync(evidenceJson, JSON.stringify(evidence, null, 2) + "\n");
  fs.writeFileSync(draftJson, JSON.stringify(draft, null, 2) + "\n");

  const md = [
    `# Skill evidence package (UNVERIFIED)`,
    ``,
    `- source: \`${evidence.source}\``,
    `- generated: ${new Date(evidence.generated_ts).toISOString()} · format ${evidence.format} · **non-executable**`,
    `- writer contract: a dedicated agent writes natural-language SKILL.md; this compiler never does`,
    ``,
    `## Warnings`,
    ...(warnings.length ? warnings.map((w, i) => `- [evidence:warning:${i + 1}] ${w}`) : ["- (none)"]),
    ``,
    `## Steps`,
    ...steps.flatMap((step) => [
      `${stepLine(step)} [evidence:step:${step.n}]`,
      ...(step.warnings || []).map((warning, index) =>
        `   - ${warning} [evidence:step-warning:${step.n}:${index + 1}]`),
    ]),
    ``,
    `## App scope`,
    ...(scopeApps.length ? scopeApps.map((a) => `- \`${a}\``) : ["- (none recorded)"]),
    `- a replay may never touch apps outside this list`,
    ``,
    `## Parameters`,
    ...(parameters.length
      ? parameters.map((p) => `- \`{{${p.name}}}\` (${p.kind}) — observed \`${p.observed}\` at step ${p.provenance.step} (${p.provenance.source}) [evidence:param:${p.name}]`)
      : ["- (none inferred)"]),
    ``,
    `## Media`,
    `- keyframes: ${keyframes.length} JPEG frames in \`${path.join(path.dirname(sessionPath), "keyframes")}\``,
    `- video: ${media.video ? `\`${media.video}\` with index \`${media.video_index}\`` : "(not recorded)"}`,
    `- audio: ${media.audio ? `\`${media.audio}\` (PCM 16 kHz mono)` : `(none)${media.audio_note ? ` — ${media.audio_note}` : ""}`}`,
    `- media is local review evidence and is never embedded in the package`,
    ``,
  ].join("\n");
  fs.writeFileSync(evidenceMd, md);
  fs.writeFileSync(draftMd, md);
  return { evidence, draft, evidenceJson, evidenceMd, draftJson, draftMd };
}

// ---------------------------------------------------------------- synthesis request

function createSynthesisRequest(name, evidence, outDir) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name)) {
    throw new Error(`invalid skill name "${name}" (lowercase letters, digits, dashes)`);
  }
  const dir = path.join(outDir, "skill-draft", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "synthesis-request.json");
  const request = {
    format: "fastcua-skill-synthesis-request/1",
    skill_name: name,
    evidence: path.resolve(outDir, "evidence.json"),
    output: path.resolve(dir, "SKILL.md"),
    writer: "dedicated-subagent",
    lint: "tools/skill-recorder/lint-skill.mjs",
    verified: false,
    stats: evidence.stats,
  };
  fs.writeFileSync(file, JSON.stringify(request, null, 2) + "\n");
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
  const { evidence, draft, evidenceJson, evidenceMd, draftJson, draftMd } = compileSession(sessionPath, outDir);
  console.log(`[compile] steps=${draft.stats.steps} params=${draft.parameters.length} warnings=${draft.warnings.length}`);
  console.log(`[compile] evidence: ${evidenceJson}`);
  console.log(`[compile] evidence: ${evidenceMd}`);
  console.log(`[compile] replay draft: ${draftJson}`);
  console.log(`[compile] replay draft: ${draftMd}`);
  const skillName = opt("--skill");
  if (skillName) {
    const { dir, file } = createSynthesisRequest(skillName, evidence, outDir);
    console.log(`[compile] synthesis request folder (inert, verified:false): ${dir}`);
    console.log(`[compile] request: ${file}`);
    console.log(`[compile] next: node tools/skill-recorder/synthesize.mjs ${JSON.stringify(evidenceJson)} --skill ${skillName}`);
  }
}

main();
