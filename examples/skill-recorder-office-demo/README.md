# skill-recorder Office demo (excel-expense-report)

> Historical artifact: this example predates the dedicated-writer pipeline. Current
> `compile.mjs` emits evidence + a synthesis request; `synthesize.mjs` writes and
> provenance-lints new `SKILL.md` drafts.

Recorded on real Microsoft Excel: start page → 空白工作簿 → two-column expense
table (项目/金额 × 3 rows) → =SUM total → F12 save-as with a date-parameterized
filename. Compiled to `draft.json` (23 steps, 10 parameters incl. the date) +
the generated `SKILL.md` draft (`verified: false`, as produced by compile).

Dry-run replayed the draft through the normal FastCUA control plane with
substituted parameters (用品/费用/交通/5600/住宿/400/总计/6000, date 2026-08-01);
the saved xlsx was verified cell-by-cell with openpyxl — all 8 cells matched
(tests/office-demo-e2e.mjs, 26/26 checks).

Promote demo: `promote.mjs` refused without flags (exit 3) and with only
--yes-i-reviewed (exit 4, verified:false), then promoted with
`--yes-i-reviewed --force-unverified` into the Kimi skills dir, appended the
force-warning line, and the copy was removed again. Log: `tests/_office-promote-*.log`.

No media bytes or session data here — `draft.json` + `SKILL.md` + this note only.
