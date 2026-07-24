#!/usr/bin/env node
// promote.mjs — copy a REVIEWED skill draft folder into an agent host's
// skills directory. This tool is the promotion gate: it refuses to run
// without an explicit human-review attestation, refuses unverified drafts
// unless explicitly forced, and never runs silently.
//
// The AGENT runs this tool, but only after the user has approved the
// promotion in conversation. Promotion is never automatic.
//
// Usage:
//   node promote.mjs --detect-host
//   node promote.mjs <draft-dir> --to <skills-dir> [--yes-i-reviewed]
//                    [--force-unverified] [--overwrite]
//
// Exit codes: 0 promoted; 2 usage/IO error; 3 missing review attestation;
// 4 draft is verified:false and --force-unverified absent; 5 target exists
// without --overwrite; 6 promotion failed verification after copy.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function fail(msg, code) {
  console.error(`promote: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);

// --- host detection ----------------------------------------------------------
// Detection order: explicit env override, then known hosts, then generic
// fallbacks. Each candidate is reported with whether it exists right now.
function detectHosts() {
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    {
      id: 'env-override',
      host: 'explicit FASTCUA_SKILLS_DIR',
      dir: process.env.FASTCUA_SKILLS_DIR || null,
    },
    {
      id: 'kimi',
      host: 'Kimi Work (kimi-desktop)',
      dir: path.join(appdata, 'kimi-desktop', 'daimon-share', 'daimon', 'skills'),
    },
    {
      id: 'claude-code',
      host: 'Claude Code',
      dir: path.join(os.homedir(), '.claude', 'skills'),
    },
    {
      id: 'opencode',
      host: 'opencode',
      dir: path.join(os.homedir(), '.config', 'opencode', 'skills'),
    },
  ];
  return candidates
    .filter((c) => c.dir)
    .map((c) => ({ ...c, exists: fs.existsSync(c.dir) }));
}

if (args.includes('--detect-host')) {
  const hosts = detectHosts();
  console.log(JSON.stringify({
    candidates: hosts,
    recommended: hosts.find((h) => h.exists)?.dir || hosts[0]?.dir || null,
    note: 'Pick the directory matching the agent host you actually use. You may also pass any directory explicitly via --to.',
  }, null, 2));
  process.exit(0);
}

// --- promotion ----------------------------------------------------------------
const draftDir = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const toDir = opt('--to') ? path.resolve(opt('--to')) : null;
const reviewed = args.includes('--yes-i-reviewed');
const forceUnverified = args.includes('--force-unverified');
const overwrite = args.includes('--overwrite');

if (!draftDir || !toDir) {
  fail('usage: promote.mjs <draft-dir> --to <skills-dir> [--yes-i-reviewed] [--force-unverified] [--overwrite]', 2);
}

const skillFile = path.join(draftDir, 'SKILL.md');
if (!fs.existsSync(skillFile)) {
  fail(`no SKILL.md in ${draftDir} — run synthesize.mjs and evidence lint before promotion`, 2);
}
const skillName = path.basename(draftDir);

// Gate 1: human-review attestation. The agent must only pass this flag after
// the user explicitly approved the promotion in conversation.
if (!reviewed) {
  fail('refusing to promote without --yes-i-reviewed. Promotion requires explicit user approval in conversation first — never promote silently.', 3);
}

// Gate 2: verification status. A draft with verified:false has never run
// end-to-end; promoting it is allowed only with an explicit override, and the
// promoted copy gets an extra warning line appended.
const text = fs.readFileSync(skillFile, 'utf8');
const verifiedFalse = /^verified:\s*false\s*$/m.test(text);
if (verifiedFalse && !forceUnverified) {
  fail(`draft "${skillName}" is verified:false (never run end-to-end). Either dry-run it first, or re-run with --force-unverified to promote it anyway.`, 4);
}

// Gate 3: no clobbering without consent.
const target = path.join(toDir, skillName);
if (fs.existsSync(target) && !overwrite) {
  fail(`target already exists: ${target} (use --overwrite to replace it)`, 5);
}

fs.mkdirSync(toDir, { recursive: true });
if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(draftDir, target, { recursive: true });

if (verifiedFalse && forceUnverified) {
  fs.appendFileSync(
    path.join(target, 'SKILL.md'),
    '\n> [!WARNING]\n> Promoted with --force-unverified: this skill was never dry-run end-to-end before promotion. Review and test before relying on it.\n',
  );
}

// Verify the copy landed where a host can discover it.
const promotedSkill = path.join(target, 'SKILL.md');
if (!fs.existsSync(promotedSkill)) {
  fail(`copy completed but ${promotedSkill} is missing — promotion failed`, 6);
}

console.log(JSON.stringify({
  ok: true,
  skill: skillName,
  from: draftDir,
  to: target,
  skill_md: promotedSkill,
  verified: !verifiedFalse,
  forced_unverified: verifiedFalse && forceUnverified,
  next_step: 'The skill file is now in the host skills directory. If the host indexes skills at startup, restart or reload the host/session so the new skill is discovered.',
}, null, 2));
