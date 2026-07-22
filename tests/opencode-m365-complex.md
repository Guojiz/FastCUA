# FastCUA complex task — Microsoft 365 (OpenCode runner)

Runner: OpenCode with Skill `computer-use` + MCP `sky-computer-use`.
Host tools: `C:\Program Files\Microsoft Office\root\Office16\`.

## Goal

Cross-app Microsoft 365 workflow (Excel → Word → verify). Prefer UIA when `state.uia.quality === "good"`; if `prefer_vision` / weak / broken tree, switch to `grid_view` / `grid_refine` / `click_cell` immediately. 30s action budget; retry once then change strategy.

## Steps

1. **Excel**
   - Launch: `C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE` (or list_apps / Start Apps name Excel).
   - Dismiss any first-run / account / “Blank workbook” splash if it blocks the grid (Esc or click Blank workbook).
   - In the active sheet, enter a small sales table:
     | A | B |
     |---|---|
     | Item | Amount |
     | Widget | 120 |
     | Gadget | 85 |
     | Total | `=SUM(B2:B3)` |
   - Use keyboard navigation (Tab / Enter / arrows) when reliable; otherwise click cells via UIA or grid.
   - Save As to Desktop: `FastCUA-M365-Sales.xlsx`
     - Prefer Ctrl+S / F12; complete the Save As dialog (folder Desktop, exact name).
     - If dialog UIA is weak, use grid or type full path in File name + Enter.

2. **Word**
   - Launch: `C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE`
   - Blank document if prompted.
   - Type a short multi-line report with `type_text` at the current caret:
     - Title: `FastCUA M365 complex test`
     - ISO timestamp of now
     - One sentence that total sales from Excel is 205
     - Bullet or numbered note: Excel file name + path under Desktop
   - Save As Desktop: `FastCUA-M365-Report.docx`

3. **Verify (required)**
   - Confirm both files exist under the user Desktop with non-zero size.
   - You may use shell/read tools for verification after GUI save; do not skip GUI Save As.

4. **Done**
   - Call MCP `close` once.
   - Final message: PASS/FAIL, files paths + sizes, blockers, any FastCUA bugs to fix.

## Control plane

Respect `[control_plane:…]`. Only interjection is an instruction. Do not fall back to PowerShell UIAutomation/SendKeys as a substitute for FastCUA.

## Hard rules

- Read full computer-use Skill first.
- Connection check: `list_apps` or `list_windows` before acting.
- Do not invent desktop-absolute pixels; window screenshot space only.
- Prefer not to open real email/Teams/cloud login flows; stay in Excel + Word offline documents.

## Office-specific (avoid stall)

Microsoft Office windows are **heavy**. Bad patterns that look like “hang”:

1. **Do not** call `get_window_state` with **both** `include_screenshot: true` and `include_text: true` on Excel/Word every step. Prefer:
   - `include_text: true, include_screenshot: false` for UIA, **or**
   - `grid_view` alone when vision is needed (one annotated image).
2. After `launch_app`, **poll** `list_apps` / `list_windows` 1–3 times (Excel splash closes HWND). Never reuse a stale `id` after “window no longer exists”.
3. Prefer **keyboard** for the sales table: click once into the grid (or Ctrl+Home), then type `Item` Tab `Amount` Enter `Widget` Tab `120` Enter … then type the formula.
4. Save with **F12** or **Ctrl+S**, type full Desktop path into File name when the dialog is flaky.
5. Prefer MCP **`js`** with multi-step cells to cut LLM round-trips.
6. If a single tool call returns a huge tree/image and you lose the plot, drop screenshots and continue with keys only.
