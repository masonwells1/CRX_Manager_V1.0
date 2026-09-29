## 2026-09-29 — the usage report no longer counts a truncated hand-back as Mason's prompt

Follow-up to `2026-09-29-hand-back-truncated-report-keeps-stop.md`, on the same PR (#826).

**Finding (Codex GitHub App, P2, on `2832c49bf`).** After the hold latch began keeping a
truncated subagent hand-back whole (the fail-safe for Mason's stop),
`scripts/claude-usage-report.mjs` inherited that behaviour through `authoredByMason()`. A
truncated report was then counted as a human prompt and could become a `--titles` session
title, which is the misclassification the hand-back fix exists to prevent.

**Change.** `masonWords()` now runs `withoutSubagentReports()` before `authoredByMason()`,
so every hand-back is removed first, including a truncated one. Mason's text around a
hand-back is kept. The hold latch itself is unchanged.

**Proof.** `scripts/claude-usage-report.test.mjs` adds a truncated hand-back record, and
the real script still reports `human prompts 2`. With the fix stashed and the old script
restored, the same test fails, because it counts the truncated report as a third prompt.
