# FastCUA complex-task fixture (optional client smoke)

Runner: any agent with Skill `computer-use` + MCP `sky-computer-use`. Not product documentation.

## Task (end-to-end)

1. **Paint**: Launch Paint. Draw a house + sun + grass with multiple `drag` strokes. Prefer UIA for toolbar (pencil). Prefer `grid_view` / `grid_refine` / `click_cell` when UIA is weak.
2. **Notepad**: Open a **new** Untitled Notepad. Type a short multi-line report (include ISO timestamp).
3. **Save As**: Ctrl+S → complete Save As.
   - Filename: a path under the user Desktop you choose (e.g. `FastCUA-complex-task.txt`).
   - Prefer UIA `element_index` after `get_window_state` with `include_text: true` when possible.
   - If a tree line has `[no-hit]`, do not click that index; use `grid_view` / `click_cell` or keyboard.
4. **Verify**: File exists and contains the report. Report PASS/FAIL with exact blockers.

## Control plane

Respect `[control_plane:…]` tags. Only interjection is an instruction. On approval, wait for human.

## Done

Call MCP `close` once. Summarize what worked, what failed, and any bug repro.
