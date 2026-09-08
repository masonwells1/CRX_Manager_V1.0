---
# Read-only report: faster model at low effort (docs/reference/claude-model-tuning.md).
model: sonnet
effort: low
---

Show a quick project status dashboard for CRX Manager. Gather this info and present it cleanly:

1. **Git status**: current branch, uncommitted changes, last 3 commits (one-line each)
2. **Codebase counts**: pages (grep lazy in App.tsx), migrations (ls count), edge functions (ls count)
3. **Health**: run `npm run build` silently — just report PASS or FAIL
4. **Recent activity**: `git log --oneline --since="24 hours ago"` — what changed today?

Present it as a compact dashboard, not a wall of text. The `<count from ls>` placeholders below mean: use the REAL numbers you just gathered in step 2 — never hardcode counts in this file (hardcoded examples rot). Example format:

```
Branch: main (clean)
Last commit: abc1234 fix: invoice balance calculation

Pages: <count from ls> | Migrations: <count from ls> | Edge Functions: <count from ls>
Build: PASS | Tests: not run (use /preflight for full check)

Today's activity:
  abc1234 fix: invoice balance calculation
  def5678 feat: add tote tracking page
```
