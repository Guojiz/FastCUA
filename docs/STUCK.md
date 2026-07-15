# Why FastCUA / agents get stuck (and what to do)

**Audience:** operators and agents running desktop tasks.  
**Not here:** install steps ([SELF_HOSTING.md](SELF_HOSTING.md)), product overview ([README](../README.md)), full agent API procedure (`skills/computer-use/`).

Software-side work must **fail fast**. Human pause / approval is intentional blocking — not a hang to “fix” by spamming tools.

## Software action budget: 30 seconds

| Layer | Limit |
|-------|--------|
| Native helper request (`daemon` → host) | **30s**, then timeout + helper reset |
| MCP request (`server.mjs` → daemon) | **30s** |
| JS REPL cell (default) | **30s** (`FASTCUA_JS_TIMEOUT_MS` overrides) |
| UIA snapshot thread | ~1.5s (falls back / marks tree bad) |
| Human approval wait | Separate (user decides; not software work) |

On timeout: **retry the same call once max**, then change strategy or report. Never spin.

These limits are product defaults in `daemon.mjs` / `server.mjs`. Agents must also follow the same budget in `skills/computer-use` (Skill + guidance).

## Why the UIA tree is “broken”

The tree is **Windows UI Automation**, not the screenshot. Bad trees happen when:

1. **App exposes little Accessibility** — Electron, custom canvas, games, many themed controls.
2. **Nodes exist but cannot be hit** — no bounding rect (`[no-hit]` in the tree), virtualized nav panes, DirectUI dialogs (e.g. some Save As UIs).
3. **Provider timeout** — UIA hung for that process; FastCUA aborts the snapshot.
4. **Shell-only tree** — Window / Pane / TitleBar only; no real Button / Edit / MenuItem targets.
5. **Stale indexes** — `element_index` only matches the **latest** `get_window_state(include_text: true)`; dialogs and list refreshes invalidate it.

Screenshots can look perfect while the tree is unusable. That is expected.

### Required agent response

After text snapshots, read **`state.uia`** (see Skill bootstrap):

| Signal | Required behavior |
|--------|-------------------|
| `prefer_vision: true` or `quality: broken` / `weak` | **Immediately** `sky.grid_view` — do **not** use `element_index` |
| One stale / unavailable `element_index` | Same: switch to vision; do not retry that index |

Product rule and Skill rule must match: broken tree → vision **now**, not after more index retries.

## Hang types

| Kind | Process alive? | Logs grow? | Cause | Fix |
|------|----------------|------------|-------|-----|
| Fake “done” | Exits | Stops | Model claims success without product | Require real file / UI proof |
| Approval / pause | Yes | Error loops | Safe mode / F8 | Wait for human; do not spam tools |
| Broken tree + index loop | Yes | Yes | Bad UIA still clicked | `uia.prefer_vision` → grid |
| Save As / DirectUI | Yes | Yes | Message-only clicks fail | SendInput path + grid / keyboard |
| Pipe deadlock | Yes | **No** | Parent blocked on helper stdio | Redirect logs / async read |
| Model / client hang | Yes | **No** | LLM or MCP client stuck | Outer client watchdog |

## Default whitelist (approval only)

Safe mode still prompts for **unknown** apps. Defaults are **exact** executable basenames / AUMIDs only (no substring match). Common local tools are included by default (Paint, Notepad, Explorer, Calculator, Terminal, cmd/PowerShell, WordPad, VS Code, a few agent hosts).

**Not** default-whitelisted: browsers as a class, password managers, security UI.

Important consistency rules:

- **Whitelist ≠ permission to automate.** The Skill still forbids terminals, password managers, auth dialogs, and security UI. Whitelist only skips the **approval prompt** if such an app is touched.
- Existing user `config.json` is **not** auto-merged when defaults expand. Edit `whitelist` or use island **Always approve** / **Full access**. New installs pick up code defaults.

## Related (right place for each topic)

| Topic | Where |
|-------|--------|
| Product principles, one-line install | [README](../README.md) |
| Build + install Skill **and** MCP | [SELF_HOSTING.md](SELF_HOSTING.md) |
| Agent runtime (bootstrap, tags, grid, safety) | `skills/computer-use/SKILL.md` + `docs/guidance.md` |
| Optional client notes (e.g. OpenCode headless) | [OPENCODE.md](OPENCODE.md) |
