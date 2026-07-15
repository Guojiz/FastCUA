# Why FastCUA / agents get stuck (and what to do)

This document is for **product operators and agents**. Software-side hangs should fail fast; human control is intentional.

## Software action budget: 30 seconds

| Layer | Limit |
|-------|--------|
| Native helper request (`daemon` → host) | **30s** then timeout + helper reset |
| MCP daemon request (`server.mjs`) | **30s** |
| JS REPL cell (default) | **30s** (`FASTCUA_JS_TIMEOUT_MS` overrides) |
| UIA snapshot thread | ~1.5s (falls back / marks tree bad) |
| Human approval wait | Separate (user decides; not “software work”) |

On timeout: **retry once max**, then change strategy or report. Never spin.

## Why the UIA tree is “broken” (烂树)

The tree is **Windows UI Automation**, not the screenshot. Bad trees happen when:

1. **App exposes little Accessibility** — Electron, custom canvas, games, many themed controls.
2. **Nodes exist but cannot be hit** — no bounding rect (`[no-hit]` in the tree), virtualized nav panes, DirectUI dialogs.
3. **Provider timeout** — UIA hung for that process; FastCUA aborts the snapshot.
4. **Shell-only tree** — Window / Pane / TitleBar only; no real Button/Edit/MenuItem targets.
5. **Stale indexes** — `element_index` only matches the **latest** `get_window_state(include_text:true)`; dialogs and list refreshes invalidate it.

Screenshots can look perfect while the tree is unusable. That is expected.

### Required agent response

Read `state.uia` after text snapshots:

- `prefer_vision: true` or `quality: broken|weak` → **`sky.grid_view` immediately**; do not use `element_index`.
- One stale element click → same; switch to vision; do not retry that index.

## Hang types

| Kind | Process alive? | Logs grow? | Cause | Fix |
|------|----------------|------------|-------|-----|
| Fake PASS | Exits | Stops | Model claims done without product | Require real file/UI proof |
| Approval / pause | Yes | Error loops | Safe mode / F8 | Wait human or whitelist; do not spam tools |
| Broken tree + index loop | Yes | Yes | Bad UIA still clicked | `uia.prefer_vision` → grid |
| Save As / DirectUI | Yes | Yes | Message-only clicks fail | SendInput path + grid/keyboard |
| Pipe deadlock | Yes | **No** | Parent blocked on stdio | Redirect logs / async read |
| Model hang | Yes | **No** | LLM/MCP stuck | Outer watchdog (agent client) |

## Default whitelist

Safe mode still prompts for **unknown** apps. Defaults (exact basename / AUMID only) include common local tools: Paint, Notepad, Explorer, Calculator, Terminal, cmd/PowerShell, WordPad, VS Code, and a few agent hosts.

Not default-whitelisted: browsers as a class, password managers, security UI. Edit `config.json` → `whitelist` or use Always approve / Full access on the island.

Existing user configs are **not** auto-merged; only new installs / code defaults get the expanded list unless you edit config.

## OpenCode / headless debug tips

- Do **not** prompt “Open the file …” for instructions — the model will try to open it in Notepad via CUA.
- Inline the task steps; require `RESULT:PASS` only if an **external artifact** exists.
- Prefer interactive TUI for long tasks; headless `run` may short-circuit.

## Related

- Skill: `skills/computer-use/SKILL.md` (control plane tags, grid rules)
- Self-host: [SELF_HOSTING.md](SELF_HOSTING.md)
