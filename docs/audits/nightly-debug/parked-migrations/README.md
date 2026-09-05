# Parked migrations — awaiting Mason's approval

These `.sql` files are **🟡 Yellow-tier** fixes the nightly mission drafted and
**validated** but has **NOT applied** — they touch migrations/RPCs/money/RLS, which never
get auto-applied while Mason sleeps (CRX Hard Rule). They live HERE, not in
`supabase/migrations/`, on purpose: nothing in this folder is picked up by the apply
pipeline or the pre-commit SQL validator.

## To ship one (Mason, in the morning)

1. Read the file's header — it explains the bug, the fix, and how it was validated.
2. If you approve: tell Claude "ship parked migration <name>" and it will move the SQL into
   `supabase/migrations/<timestamp>_<name>.sql`, run `/migration-review` (the 5 reviewers +
   a real pay→void smoke test), and apply it via the normal `/ship` gate — with your final
   prod-push approval.

Each file was validated by **compiling it against the live schema inside a rolled-back
transaction** (zero production footprint). The bug each one fixes was confirmed by reading
the live function definition + its callers — citations are in the header.
