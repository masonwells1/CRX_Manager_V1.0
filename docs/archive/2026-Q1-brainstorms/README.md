# 2026 Q1 Brainstorms & Audits — Archive

These are historical planning documents and audit reports from January–March 2026 that lived on long-stale feature branches and were never merged through PRs. The branches were cleaned up on 2026-05-07; the docs are preserved here so the historical reasoning isn't lost.

**These documents are NOT current state.** Many of the gaps, defects, and plans they describe have been addressed in later work (Wave A/B, Phase 13–22, integrity-cleanup tooling, returns rebuild, inventory-position RPC, etc.). Read them as snapshots of what was true *at the date in their filename*, not as work-to-do lists.

For the current state of the system, see:
- [CLAUDE.md](../../../CLAUDE.md) — current architecture rules and counts
- [docs/CHANGELOG.md](../../CHANGELOG.md) — what shipped session-by-session
- [docs/reference/](../../reference/) — schema, RPCs, pages, code patterns
- [docs/audits/](../../audits/) — current audit findings

## Contents

| File | Origin branch | Date | Notes |
|---|---|---|---|
| `2026-03-01-superpower-brainstorm-inventory-delivery-blendtickets.md` | claude/analyze-app-structure-OPErH | 2026-03-01 | Brainstorm of "superpower" features for inventory, deliveries, blend tickets. Many ideas have since shipped or been superseded. |
| `2026-03-01-team-board-brainstorm.md` | claude/brainstorm-team-board-sohzc | 2026-03-01 | Team-board feature brainstorm + gap analysis. |
| `2026-03-01-gap-remediation-handoff.md` | claude/document-app-workflow-ejLfZ | 2026-03-01 | Verified gap-remediation handoff plan. Most gaps have been closed. |

If you need the original commit history for any of these, the branches were deleted on 2026-05-07 but their objects remain in git's reflog/object store until garbage-collected. Use `git fsck --unreachable` or check the GitHub audit log if you need to recover an exact branch state within the next ~90 days.
