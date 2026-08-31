## 2026-08-31 — A modified migration cannot be re-stamped; and a stale ref reads as a fresh one

Two P2 findings from Codex's review of `53f2aa1f`, both on the branch inventory. Both correct.

### The recovery rule was unsafe for modified migrations

The report told the reader to preserve a live migration by landing the **byte-identical SQL** into
`supabase/migrations/` before deleting the branch, and said explicitly that this "applies to both
migration sections". It should not have. For the four branches that *modify* a migration `main`
already has, both readings of that instruction are wrong:

- **Restore the branch's version to the original path** — edits an applied migration, which the CRX
  Hard Rules forbid outright.
- **Re-stamp the payload under a new timestamp** — makes it *execute again*. These are not
  abstractly replayable scripts.

`20260812115238_repair_historical_order_line_cents.sql`, carried by
`claude/recover-applied-migrations-20260812`, is the concrete case and it is a money path. It is a
one-time historical repair binding an approved preimage — 35 mapped rows, 16 orders, 151 order
lines, and a content digest — and it raises `APPROVED_SET_DRIFTED` when the database no longer
matches. Re-stamped after the repair has landed it aborts rather than corrupting, so the failure is
loud; but the "recovery" recovers nothing and breaks a deploy.

The report now carries a separate procedure for modified migrations: leave the applied file
untouched, recover the branch's version as **evidence** rather than as a migration, diff it and use
read-only live introspection to establish whether the difference ever reached the database, and
only then — if a real difference must reach production — write a *new*, deliberately replay-safe
forward reconciliation as its own reviewed change. Explicitly: none of that belongs in a deletion
sweep, and a branch whose modified migration holds a real difference stays until the reconciliation
has shipped.

### A stale ref reads exactly like a current one

The baseline check said to confirm `git rev-parse origin/main` still returns the pinned OID. That
reads the *local* remote-tracking ref. In a checkout that has not fetched it returns the old OID
happily — reporting "baseline current" precisely when `main` has moved, which is the one condition
that makes every classification in the report wrong.

Changed to `git ls-remote origin refs/heads/main`, which asks the server. This is the same class of
error that produced the first wrong measurement in this PR: a shallow, unfetched checkout reported
~2,500 unmerged commits on branches that had merged.

### The same routing survived in a third place

Codex's review of `cf0b2466` found the "Suggested review order" section still sending an
applied-live *modified* migration to the generic byte-identical rule, after the two sections above
had been corrected. A reviewer working from that summary could still have overwritten an applied
path or re-stamped one-time SQL.

Fixed by routing every mention rather than the one reported. There are four places the report
decides which rule applies, and they now each name it:

- the modified-migration disposition list — forward reconciliation;
- the absent-from-`main` disposition list — byte-identical recovery, *and it says why that is the
  right rule there*;
- review-order step 1 — forward reconciliation;
- review-order step 2 — byte-identical recovery, with an explicit note that the 2 branches also in
  step 1 take the forward route for the file they modify and this route only for their genuinely
  absent migrations.

Naming the rule at each decision point, instead of writing "the rule above", is what stops the
next reader inheriting the wrong one.

### Proof observed

- `supabase/migrations/20260812115238_repair_historical_order_line_cents.sql` exists on `main` and
  contains `APPROVED_SET_DRIFTED` at two guard sites, including the populated-database check and the
  bound-preimage assertion naming 35 rows / 16 orders / 151 lines and the digest.
- Report regenerated, then swept for every occurrence of "recovery rule" and "forward
  reconciliation": four routing points, each now naming its rule explicitly.
- `npm run check:docs` passes.
