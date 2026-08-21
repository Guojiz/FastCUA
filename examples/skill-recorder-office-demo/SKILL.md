---
name: excel-expense-report
description: 意图：录入两列费用表（项目/金额）
verified: false
---

> [!WARNING]
> **草稿未验证 / UNVERIFIED DRAFT** — 本 Skill 由演示录制自动生成，从未端到端运行验证。
> 人工审查并测试每一步之前，不要依赖它执行任何操作。
> This skill was generated from a recorded demonstration and has NEVER been
> tested end-to-end. Review and test every step before relying on it.

# excel-expense-report

## Intent / 意图

- step 2: 意图：录入两列费用表（项目/金额）
- step 14: 金额列求和
- step 18: 另存为xlsx，文件名按日期参数化

## Steps / 步骤

1. Click left at (306,324) on ListItem(50007) "空白工作簿"
   - ⚠ unresolved: input was injected, not physically demonstrated
2. Type `{{text_1}}` into DataItem(50029) #A1 "A1" — intent: 意图：录入两列费用表（项目/金额）
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
3. Press Tab on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
4. Type `{{text_2}}` into DataItem(50029) #B1 "B1"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
5. Press Enter on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
6. Type `{{text_3}}` into DataItem(50029) #A2 "A2"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
7. Press Tab on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
8. Type `{{text_4}}` into DataItem(50029) #B2 "B2"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
9. Press Enter on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
10. Type `{{text_5}}` into DataItem(50029) #A3 "A3"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
11. Press Tab on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
12. Type `{{text_6}}` into DataItem(50029) #B3 "B3"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
13. Press Enter on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
14. Type `{{text_7}}` into DataItem(50029) #A4 "A4" — intent: 金额列求和
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
15. Press Tab on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
16. Type `{{text_8}}` into DataItem(50029) #B4 "B4"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
17. Press Enter on Pane(50033)
   - ⚠ unresolved: input was injected, not physically demonstrated
18. Press F12 on DataItem(50029) #A5 "A5" — intent: 另存为xlsx，文件名按日期参数化
   - ⚠ unresolved: input was injected, not physically demonstrated
19. Click left at (588,496) on Edit(50004) #1001 "文件名:"
   - ⚠ unresolved: input was injected, not physically demonstrated
20. Press Ctrl+A on Edit(50004) #1001 "文件名:"
   - ⚠ unresolved: input was injected, not physically demonstrated
21. Type `C:\Users\Administrator\AppData\Local\Temp\fastcua-office-demo\report-{{date}}.xlsx` into Edit(50004) #1001 "文件名:"
   - input arrived as VK_PACKET (automation-style Unicode injection)
   - ⚠ unresolved: input was injected, not physically demonstrated
22. Press Tab on Edit(50004) #1001 "文件名:"
   - ⚠ unresolved: input was injected, not physically demonstrated
23. Click left at (769,702) on Button(50000) #1 "保存(S)"
   - ⚠ unresolved: input was injected, not physically demonstrated

## Parameters / 参数

| parameter | kind | observed during recording | provenance |
|---|---|---|---|
| `{{text_1}}` | text | `项目` | step 2, typed-value (UIA snapshot) |
| `{{text_2}}` | text | `金额` | step 4, typed-value (UIA snapshot) |
| `{{text_3}}` | text | `差旅` | step 6, typed-value (UIA snapshot) |
| `{{text_4}}` | text | `1200` | step 8, typed-value (UIA snapshot) |
| `{{text_5}}` | text | `餐饮` | step 10, typed-value (UIA snapshot) |
| `{{text_6}}` | text | `340` | step 12, typed-value (UIA snapshot) |
| `{{text_7}}` | text | `合计` | step 14, typed-value (UIA snapshot) |
| `{{text_8}}` | text | `1540` | step 16, typed-value (UIA snapshot) |
| `{{date}}` | date | `2026-07-23` | step 21, typed-value (UIA snapshot) |
| `{{filename}}` | filename | `report-2026-07-23.xlsx` | step 21, typed-value (UIA snapshot) |

## Review aids / 审查辅助

The recording session also captured **review media**, kept next to the source
session (NOT copied into this folder, and never embedded in this file):

- video: `C:\Users\ADMINI~1\AppData\Local\Temp\fastcua-office-demo-jOmrrj\session\video\video.avi` — MJPEG AVI of the demo (per-frame index: `C:\Users\ADMINI~1\AppData\Local\Temp\fastcua-office-demo-jOmrrj\session\video\index.jsonl`)
- audio: none (unavailable: GetService(IAudioCaptureClient) 0x88890003)

When a step is unclear, an agent may LOOK at the corresponding moment instead
of guessing:

```
node tools/skill-recorder/frame-extract.mjs "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\fastcua-office-demo-jOmrrj\\session" --note 1
```

(Also `--at-ms <epoch-ms>` or `--at <ISO-8601>`.) Moments that were redacted
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
- App scope is fixed at record time (1 app(s): `EXCEL.EXE`); a replay that
  would touch anything outside it is refused before execution.
- Password-field input was redacted at record time; no secret is present in
  this folder and none may be reconstructed.
- Spans recorded as injected input (another automation driving) are flagged
  ⚠ unresolved — treat them as unverified by default.
- Nothing here auto-installs or auto-runs: this folder is inert documentation
  until a human reviews it and copies it into a skills directory.

## Source / 来源

- session: `C:\Users\ADMINI~1\AppData\Local\Temp\fastcua-office-demo-jOmrrj\session\session.jsonl` (format fastcua-recording/1)
- draft: `C:\Users\ADMINI~1\AppData\Local\Temp\fastcua-office-demo-jOmrrj\session\draft.json`
- keyframes: `C:\Users\ADMINI~1\AppData\Local\Temp\fastcua-office-demo-jOmrrj\session\keyframes` (19 JPEG frames)
- compiled: 2026-07-23T14:44:46.973Z by tools/skill-recorder/compile.mjs
