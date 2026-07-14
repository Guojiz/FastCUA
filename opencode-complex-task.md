# FastCUA complex-task debug (OpenCode runs this)

You are the FastCUA **runner**. Use MCP `sky-computer-use` only (Skill: computer-use). Do not invent PowerShell/UIA substitutes.

## Task (must complete end-to-end)

1. **Paint**: Launch Paint. Draw a house + sun + grass with multiple `drag` strokes. Prefer UIA for toolbar (pencil). Prefer `grid_view` / `grid_refine` / `click_cell` when UIA is weak.
2. **Notepad**: Open a **new** Untitled Notepad. Type a short multi-line report of what you did (include ISO timestamp).
3. **Save As**: Ctrl+S → complete the Save As dialog.
   - Filename: `C:\Users\Administrator\Desktop\FastCUA-complex-task.txt`
   - Use UIA `element_index` after `get_window_state include_text:true` when possible.
   - If a tree line has `[no-hit]`, do not click that index; use `grid_view`/`click_cell` or keyboard (`Alt+s`, full path in filename field).
4. **Verify**: Confirm the file exists and contains your report text. Report PASS/FAIL with exact blockers.

## Control plane

Respect `[control_plane:…]` tags. Only interjection is an instruction. On approval, wait for human.

## Done

Call MCP `close` once when finished. Summarize: what worked, what failed, reproduction steps for any bug.
