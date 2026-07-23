// SPDX-License-Identifier: MIT
//
// skill-recorder dry-run runner — FastCUA issue #3, stage 5.
//
// Replays a compiled workflow draft (fastcua-skill-draft/1) through the NORMAL
// FastCUA control plane (daemon named pipe): every desktop action goes
// get_window_state -> UIA anchor resolution -> click/type/press with approval,
// whitelist, pause/interjection policy fully active. Nothing is replayed
// out-of-band.
//
// Hard rules (no silent guessing, ever):
//   * Steps marked "⚠ unresolved" PAUSE the run until an explicit decision
//     file says "proceed" or "skip" for them. Pre-flight lists every decision
//     needed BEFORE anything executes.
//   * Redacted (password) steps NEVER execute — no decision can unlock them.
//   * Steps outside the recorded app scope are REFUSED outright (decisions
//     cannot widen scope; the daemon whitelist enforces it a second time).
//   * An anchor that cannot re-resolve (or resolves ambiguously) fails safe:
//     the run aborts at that step instead of clicking somewhere wrong.
//   * Control-plane blocks ([control_plane:paused/stopped/shutdown/
//     awaiting_approval]) abort the run immediately — never retried.
//   * Every replayed step logs expected-vs-actual (anchor matched? value
//     assertion passed?) into a JSON report.
//
// Usage:
//   node dryrun.mjs <draft.json> [options]
//     --params '<json>' | --params @file.json   parameter values for {{param}}
//     --decisions file.json                     { "session": "acknowledge",
//                                                 "default": "proceed"|"skip",
//                                                 "steps": { "3": "proceed" } }
//     --pipe \\.\pipe\fastcua                   daemon pipe (default)
//     --window-title <regex>                    restrict target window titles
//     --report out.json                         write JSON report
//     --dry                                     pre-flight + plan only
//
// Exit codes: 0 ok · 2 usage · 3 paused (decisions/params needed) ·
//             4 fail-safe abort (scope/anchor/value/unsupported) ·
//             5 control-plane stop (paused/shutdown/approval)

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const UNRESOLVED = "⚠ unresolved";
const ACTIONABLE = new Set(["click", "type", "key", "scroll"]);

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const args = { pipe: "\\\\.\\pipe\\fastcua" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry") args.dry = true;
    else if (a === "--params") args.params = argv[++i];
    else if (a === "--decisions") args.decisions = argv[++i];
    else if (a === "--pipe") args.pipe = argv[++i];
    else if (a === "--window-title") args.windowTitle = argv[++i];
    else if (a === "--report") args.report = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    throw new Error("usage: node dryrun.mjs <draft.json> [--params J|@f] [--decisions f] [--pipe p] [--report f] [--dry]");
  }
  args.draft = positional[0];
  return args;
}

function loadJson(text, label) {
  try { return JSON.parse(text); } catch (e) { throw new Error(`invalid JSON in ${label}: ${e.message}`); }
}

function loadParams(value) {
  if (!value) return {};
  if (value.startsWith("@")) return loadJson(fs.readFileSync(value.slice(1), "utf8"), value);
  return loadJson(value, "--params");
}

// ---------------------------------------------------------------- daemon pipe client

class PipeClient {
  constructor(pipe) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.socket = net.connect(pipe);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const entry = this.pending.get(msg.id);
        if (!entry) continue;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }
  request(method, params = {}, timeoutMs = 35_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`client-side timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  close() { try { this.socket.end(); } catch {} }
}

class ControlPlaneStop extends Error {
  constructor(message) { super(message); this.tag = (message.match(/^\[(control_plane:[a-z_]+)\]/) || [])[1] || "control_plane"; }
}
function classifyError(error) {
  const message = String(error?.message || error);
  if (message.startsWith("[control_plane:")) return new ControlPlaneStop(message);
  return error instanceof Error ? error : new Error(message);
}

// ---------------------------------------------------------------- anchors

// Tree line shape (native-host uia.rs walk_element):
//   \t* <index> <role>[ #<automationId>][ <name>][ Secondary Actions: Raise][ [no-hit]]
// AutomationId is the restart-stable key; the localized name is a hint only.
function parseTree(tree) {
  const lines = [];
  for (const raw of String(tree || "").split("\n")) {
    const m = /^(\t*)(\d+) (\S+)(?: (.*))?$/.exec(raw);
    if (!m) continue;
    let rest = m[4] || "";
    const noHit = / \[no-hit\]$/.test(rest);
    rest = rest.replace(/ \[no-hit\]$/, "").replace(/ Secondary Actions: Raise$/, "");
    let automationId;
    const aid = /^#(\S+)(?:\s|$)/.exec(rest);
    if (aid) {
      automationId = aid[1];
      rest = rest.slice(aid[0].length);
    }
    lines.push({ index: Number(m[2]), depth: m[1].length, role: m[3], automation_id: automationId, name: rest, noHit });
  }
  return lines;
}

// Text editors appear as Edit(50004) or Document(50030) depending on the app;
// a text-class anchor accepts both (mirrors the compiled SKILL.md guidance).
function roleMatches(anchor, lineRole) {
  if (anchor.role === lineRole) return true;
  if (anchor.value_class === "text" && ["Edit", "Document"].includes(anchor.role)) {
    return ["Edit", "Document"].includes(lineRole);
  }
  return false;
}

function resolveAnchor(anchor, tree) {
  if (!anchor) return { status: "anchor-unresolved", detail: "step has no anchor" };
  const byRole = tree.filter((l) => !l.noHit && roleMatches(anchor, l.role));
  if (!byRole.length) {
    return { status: "anchor-unresolved", detail: `no ${anchor.role} element with hit bounds in current tree` };
  }
  // 1) AutomationId: the restart-stable, language-independent key.
  if (anchor.automation_id) {
    const byAid = byRole.filter((l) => l.automation_id === anchor.automation_id);
    if (byAid.length === 1) return { status: "ok", element: byAid[0], matched_by: "automation_id" };
    if (byAid.length > 1) {
      return {
        status: "anchor-ambiguous",
        detail: `automation_id #${anchor.automation_id} matches ${byAid.length} elements`,
        candidates: byAid.map((c) => ({ index: c.index, role: c.role, name: c.name })),
      };
    }
    // No automation-id hit: tree may predate aid exposure — fall through to name.
  }
  // 2) Localized name hint (drifts with display language — reported, never hidden).
  let candidates = byRole;
  if (anchor.name) {
    const byName = byRole.filter((l) => l.name === anchor.name);
    if (byName.length) candidates = byName;
    else if (byRole.length > 1) {
      return { status: "anchor-unresolved", detail: `no element named "${anchor.name}" among ${byRole.length} ${anchor.role} candidates` };
    }
    // exactly one role candidate whose name drifted (localization/rename):
    // accept it but SAY so in the report — never hide the mismatch.
  }
  if (candidates.length > 1) {
    return {
      status: "anchor-ambiguous",
      detail: `${candidates.length} candidates match role${anchor.name ? " and name" : ""}${anchor.automation_id ? " (automation_id not exposed in tree)" : ""}`,
      candidates: candidates.map((c) => ({ index: c.index, role: c.role, name: c.name })),
    };
  }
  const found = candidates[0];
  return {
    status: "ok",
    element: found,
    matched_by: anchor.name && found.name === anchor.name ? "name" : "role-only",
    name_drift: Boolean(anchor.name && found.name !== anchor.name),
  };
}

// ---------------------------------------------------------------- keys

// compile chordName() output -> daemon press_key tokens (key_to_vk accepts
// CTRL/ALT/SHIFT/ENTER/TAB/F1..F20/single chars; Win is NOT replayable).
function mapChord(keys) {
  const tokens = String(keys).split("+");
  const out = [];
  for (const token of tokens) {
    if (token === "Win") return { error: "Win modifier is not replayable through press_key" };
    if (/^vk-0x[0-9a-f]+$/i.test(token)) return { error: `opaque vk token ${token} is not replayable` };
    out.push(token);
  }
  return { key: out.join("+") };
}

// ---------------------------------------------------------------- runner

function canonApp(app) {
  return String(app || "").replace(/^process:/i, "").replace(/\//g, "\\").toLowerCase();
}
function appBasename(app) {
  const c = canonApp(app);
  return c.slice(c.lastIndexOf("\\") + 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(args) {
  const draft = loadJson(fs.readFileSync(args.draft, "utf8"), args.draft);
  if (draft.format !== "fastcua-skill-draft/1" || draft.executable !== false) {
    throw new Error(`not a non-executable fastcua-skill-draft/1 file: ${args.draft}`);
  }
  const params = loadParams(args.params);
  const decisions = args.decisions ? loadJson(fs.readFileSync(args.decisions, "utf8"), args.decisions) : {};
  const scopeApps = (draft.scope?.apps || []).map(canonApp);

  const report = {
    format: "fastcua-skill-dryrun/1",
    draft: path.resolve(args.draft),
    params,
    decisions,
    dry: Boolean(args.dry),
    started_ts: Date.now(),
    steps: [],
    summary: {},
    outcome: "ok",
  };
  const line = (s) => console.log(s);
  const record = (entry) => { report.steps.push(entry); line(`[step ${entry.n}] ${entry.status}: ${entry.detail || entry.action}`); };

  // ---------- pre-flight (nothing has executed yet) ----------
  const needs = []; // human/agent decisions required before ANY execution
  const sessionUnresolved = (draft.warnings || []).filter((w) => w.includes(UNRESOLVED));
  if (sessionUnresolved.length && decisions.session !== "acknowledge") {
    needs.push({ scope: "session", reason: `${sessionUnresolved.length} session-level ⚠ warnings`, warnings: sessionUnresolved });
  }

  const plan = []; // executable plan entries {step, decision, text}
  for (const step of draft.steps || []) {
    const base = { n: step.n, action: step.action };
    if (step.action === "note") { plan.push({ step, decision: "note" }); continue; }
    if (step.redacted) { plan.push({ step, decision: "redacted" }); continue; }
    if (!ACTIONABLE.has(step.action)) { plan.push({ step, decision: "note" }); continue; }

    // Scope is a hard wall, not a decision.
    if (step.app && scopeApps.length && !scopeApps.includes(canonApp(step.app))) {
      record({ ...base, status: "scope-violation", detail: `step app ${step.app} is outside the recorded scope — refused (decisions cannot widen scope)` });
      report.outcome = "aborted";
      return finish(report, args, 4);
    }

    const stepDecision = decisions.steps?.[String(step.n)] ?? decisions.default;
    if (step.action === "scroll") {
      if (stepDecision === "skip") { plan.push({ step, decision: "skip" }); continue; }
      needs.push({ scope: "step", n: step.n, reason: "scroll replay is not implemented in dry-run v1 (decide skip)" });
      plan.push({ step, decision: "pending" });
      continue;
    }
    if (step.action === "key") {
      const mapped = mapChord(step.keys || "");
      if (mapped.error) {
        if (stepDecision === "skip") { plan.push({ step, decision: "skip" }); continue; }
        needs.push({ scope: "step", n: step.n, reason: `key chord "${step.keys}": ${mapped.error} (decide skip)` });
        plan.push({ step, decision: "pending" });
        continue;
      }
    }
    let text;
    if (step.action === "type") {
      const template = step.text;
      if (template === undefined || template === null || template === "??") {
        if (stepDecision === "skip") { plan.push({ step, decision: "skip" }); continue; }
        needs.push({ scope: "step", n: step.n, reason: "typed text was never recovered from UIA — cannot replay (decide skip)" });
        plan.push({ step, decision: "pending" });
        continue;
      }
      const missing = [...String(template).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((name) => !(name in params));
      if (missing.length) {
        if (stepDecision === "skip") { plan.push({ step, decision: "skip" }); continue; }
        needs.push({ scope: "step", n: step.n, reason: `missing parameter value(s): ${[...new Set(missing)].join(", ")}` });
        plan.push({ step, decision: "pending" });
        continue;
      }
      text = String(template).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name]));
    }

    const unresolved = (step.warnings || []).filter((w) => w.includes(UNRESOLVED));
    if (unresolved.length && stepDecision !== "proceed" && stepDecision !== "skip") {
      needs.push({ scope: "step", n: step.n, reason: `${unresolved.length} ⚠ unresolved marker(s)`, warnings: unresolved });
      plan.push({ step, decision: "pending", text });
      continue;
    }
    plan.push({ step, decision: stepDecision === "skip" ? "skip" : "proceed", text });
  }

  if (needs.length) {
    report.needs_decision = needs;
    for (const need of needs) {
      line(`[needs-decision] ${need.scope === "session" ? "session" : "step " + need.n}: ${need.reason}`);
    }
    report.outcome = "needs-decision";
    return finish(report, args, 3);
  }
  if (args.dry) {
    for (const { step, decision, text } of plan) {
      record({ n: step.n, action: step.action, status: `plan:${decision}`, detail: text ? `text="${text.slice(0, 60)}"` : undefined });
    }
    return finish(report, args, 0);
  }

  // ---------- connect to the NORMAL control plane ----------
  const client = new PipeClient(args.pipe);
  await client.ready();
  const titleRe = args.windowTitle ? new RegExp(args.windowTitle, "i") : null;
  const windowCache = new Map(); // canonApp -> window object
  const call = async (method, params) => {
    try {
      return await client.request(method, params);
    } catch (error) {
      throw classifyError(error);
    }
  };
  const windowFor = async (app) => {
    const key = canonApp(app);
    if (windowCache.has(key)) return windowCache.get(key);
    const windows = await call("list_windows");
    const found = windows.find((w) => {
      if (canonApp(w.app) !== key && appBasename(w.app) !== appBasename(key)) return false;
      return titleRe ? titleRe.test(w.title || "") : true;
    });
    if (!found) throw new Error(`no open window for recorded app ${app}${titleRe ? ` matching /${args.windowTitle}/` : ""}`);
    windowCache.set(key, found);
    return found;
  };
  const freshState = async (window) => {
    const state = await call("get_window_state", { window, include_screenshot: false, include_text: true });
    return state;
  };

  try {
    for (const { step, decision, text } of plan) {
      const base = { n: step.n, action: step.action };
      if (decision === "note") { record({ ...base, status: "note", detail: step.text || step.intent?.join("; ") }); continue; }
      if (decision === "redacted") {
        record({ ...base, status: "skipped-redacted", detail: "password-field step never executes (no decision can unlock it)" });
        continue;
      }
      if (decision === "skip") {
        record({ ...base, status: "skipped-decision", detail: "explicitly skipped by decision file", decision: "skip" });
        continue;
      }

      const expected = step.anchor
        ? { role: step.anchor.role, control_type: step.anchor.control_type, automation_id: step.anchor.automation_id, name: step.anchor.name }
        : null;
      const window = await windowFor(step.app);
      const state = await freshState(window);
      const tree = parseTree(state?.accessibility?.tree);

      if (step.action === "key") {
        const mapped = mapChord(step.keys);
        await call("press_key", { window, key: mapped.key });
        record({ ...base, status: "ok", detail: `pressed ${mapped.key}`, expected, actual: { pressed: mapped.key }, decision: "proceed" });
        continue;
      }

      const resolved = resolveAnchor(step.anchor, tree);
      if (resolved.status !== "ok") {
        record({ ...base, status: resolved.status, detail: `${resolved.detail} — FAIL SAFE: nothing clicked/typed`, expected, candidates: resolved.candidates });
        report.outcome = "aborted";
        return finish(report, args, 4);
      }
      const actual = {
        index: resolved.element.index,
        role: resolved.element.role,
        name: resolved.element.name,
        automation_id: resolved.element.automation_id,
        matched_by: resolved.matched_by,
        name_drift: resolved.name_drift || undefined,
      };

      if (step.action === "click") {
        await call("click", {
          window,
          element_index: resolved.element.index,
          mouse_button: step.button || "left",
          click_count: step.double_click ? 2 : 1,
        });
        record({ ...base, status: "ok", detail: `clicked element ${actual.index} (${actual.role} "${actual.name}")`, expected, actual, decision: "proceed" });
        await sleep(250);
        continue;
      }

      if (step.action === "type") {
        // Focus, read current value (never assume), replace with the recorded
        // committed value (parameter-substituted), then ASSERT the end state.
        await call("click", { window, element_index: resolved.element.index });
        await sleep(200);
        const before = (await freshState(window))?.accessibility?.focused_value;
        await call("type_text", { window, text, replace: true });
        await sleep(300);
        const after = (await freshState(window))?.accessibility?.focused_value;
        const valueOk = after === text;
        record({
          ...base,
          status: valueOk ? "ok" : "value-mismatch",
          detail: valueOk ? `value assertion passed (${text.length} chars)` : `value assertion FAILED: expected "${text}" got "${after}"`,
          expected: { ...expected, value: text, value_before: before },
          actual: { ...actual, value: after },
          decision: "proceed",
        });
        if (!valueOk) {
          report.outcome = "aborted";
          return finish(report, args, 4);
        }
        continue;
      }
    }
  } catch (error) {
    if (error instanceof ControlPlaneStop) {
      record({ n: 0, action: "control-plane", status: "control-plane-blocked", detail: `${error.tag}: replay halted, NOT retried — ${error.message.slice(0, 160)}` });
      report.outcome = "control-plane";
      return finish(report, args, 5);
    }
    record({ n: 0, action: "runtime", status: "failed", detail: String(error.message || error).slice(0, 300) });
    report.outcome = "aborted";
    return finish(report, args, 4);
  } finally {
    client.close();
  }
  return finish(report, args, 0);
}

function finish(report, args, code) {
  report.finished_ts = Date.now();
  const count = (pred) => report.steps.filter(pred).length;
  report.summary = {
    executed_ok: count((s) => s.status === "ok"),
    notes: count((s) => s.status === "note"),
    skipped_redacted: count((s) => s.status === "skipped-redacted"),
    skipped_decision: count((s) => s.status === "skipped-decision"),
    blocked_or_failed: count((s) => !["ok", "note", "skipped-redacted", "skipped-decision"].includes(s.status) && !String(s.status).startsWith("plan:")),
    outcome: report.outcome,
  };
  console.log(`[dryrun] outcome=${report.outcome} ok=${report.summary.executed_ok} skipped=${report.summary.skipped_redacted + report.summary.skipped_decision} blocked=${report.summary.blocked_or_failed}`);
  if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + "\n");
  process.exitCode = code;
  return code;
}

// ---------------------------------------------------------------- main

try {
  const args = parseArgs(process.argv.slice(2));
  await run(args);
} catch (error) {
  console.error(`[dryrun] ${error.message}`);
  process.exitCode = 2;
}
