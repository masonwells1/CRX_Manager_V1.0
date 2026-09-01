# PR #509 return-credit COGS rebuild — restart handoff

## WHERE

- Repository: `https://github.com/masonwells1/CRX_Manager_V1.0`
- Isolated checkout: `C:\Users\mason\.codex\worktrees\pr361-current-rebuild\CRX_Manager`
- Branch: `codex/pr361-current-rebuild`
- Code checkpoint commit: `45c9c90ebfc0bfc883723f2f39ff0351add23052`
- Pull request: `#509` — `https://github.com/masonwells1/CRX_Manager_V1.0/pull/509`
- Production: `https://croprxsolutions.app`
- Supabase project: `rhyzpcqhnizqbxphqdkr`

At checkpoint time the remote branch and PR still pointed to
`95419390d11889de180fa18817f237f04316c563`; the local branch was three commits ahead.
Nothing from this checkpoint was pushed.

## GOAL

Land the durable successor to PR #361: usable returns restore inventory, their credit memos reverse
the exact recognized historical COGS from active non-credit `posted`/`overdue`/`paid` invoices, and
the reversal is reported in `public.current_season()` so prior customer year-end reports remain
stable. Done means the final exact commit has clean Sol and Claude adversarial verdicts, PR #509 is
green and merged through branch protection, the six-file migration chain is separately approved and
applied in order, and production behavior is verified.

## PROVEN

- Fresh read-only production schema was loaded into a throwaway PostgreSQL container; production was
  not mutated.
- The full candidate chain produced `RETURN_CREDIT_POSTAPPLY_LIVE_PASS` with 61 named signals,
  `SMOKE_PASS_ROLLBACK`, and `residue=0`.
- The smoke executed and observed the legacy conversion/cancellation as 37.5 gallons in and 37.5
  gallons out.
- `void_delivery` and `cancel_delivery` both rejected reversal after a received return on the same
  delivery lineage.
- Three deliberate mutations were caught: subtracting only 15 gallons, removing the delivery-void
  return guard, and removing the delivery-cancel return guard.
- Focused migration contract suite: 13/13 passed.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run check:docs` passed.
- `npm run test:correction-guards` passed through its final schema-baseline check.
- The commit hook passed ledger, private-artifact containment, staged SQL validation, staged frontend
  validation, and commit-message containment.
- Earlier full-suite proof covered all 343 Vitest files by one near-complete run plus four shards;
  the single-process runner's only failure mode was a worker out-of-memory leak, not an assertion.

## WRITTEN, NOT PROVEN

- No current item is merely written without direct local execution proof.
- The final post-handoff HEAD has not yet received its required exact-SHA independent reviews.

## NOT STARTED

- Exact-SHA `gpt-5.6-sol` high-effort review of the final HEAD after this handoff commit.
- Exact-commit Claude CLI adversarial review of the same final HEAD.
- Push the three local commits plus this handoff commit, refresh PR #509, read CodeRabbit, and wait
  for required GitHub/Vercel checks.
- Merge and production verification.
- Live migration review/apply/post-apply verification. No live apply occurred in this task.

## APPROVAL STATE

- Mason chose current-season (2026 today) attribution for the return-credit COGS reversal.
- Mason required Claude adversarial review before push. That remains a hard pre-push condition.
- This handoff carries no permission to apply migrations, delete data, change permissions, or bypass
  any review/check. A future interactive live migration apply requires Mason's fresh in-chat approval.

## GATES AND BLOCKERS

- The last Claude CLI attempt was against older commit `1e42c0ff...` and was blocked by HTTP 429:
  weekly limit, reset August 30, 2026 at 9:00 AM America/Chicago. Evidence:
  `.claude/session-state/claude-review-latest.txt`. It is not a verdict for the current commit.
- Sol's older exact-SHA review found the two HIGH inventory defects fixed in `45c9c90e`; a fresh Sol
  verdict is required because the reviewed SHA changed.
- PR #509 is open but points to the older remote SHA. Its old CI result is not evidence for this local
  checkpoint.
- The live migration ordering prerequisite remains
  `20260826220000_quote_version_restore_trust_boundary.sql`; verify it is live before applying the
  six `20260827041xxx` files.

## FIRST ACTION

From the isolated checkout, verify `git status --short --branch`, `git rev-parse HEAD`, the current
remote head, PR #509 state, and live migration ledger. Then run the exact-SHA Sol review. If clean,
run Claude CLI against that same commit; do not push until Claude returns a complete clean verdict.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
