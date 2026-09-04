## 2026-09-04 - Applied the invoice_date Chicago-fallback migration to live

- Applied `20260904160000_invoice_date_fallbacks_chicago` to production
  (`rhyzpcqhnizqbxphqdkr`) at 2026-09-04 13:00 UTC, ledger version `20260904130047`. Four
  server-side `invoice_date` fallbacks now stamp the America/Chicago business day instead of the UTC
  `CURRENT_DATE`. Authorised by Mason's explicit in-chat OK in the applying session.
- Route: `scripts/apply-migration-file.mjs --confirm`, HTTP 201, one transaction carrying the
  migration and its ledger row, queryHash
  `73b0830b8a1cfd2fdfaa45ac4c815e06bdf488c4f1dfbd0c81c00e28f103fcf2`. The token was read from Windows
  Credential Manager in-process by a scratchpad launcher; it was never written to a file and the
  launcher adds no bypass — all five apply gates ran inside the gated script.
- What was applied is provably what was reviewed: blob `42ba56b2a09a64ef43f34cc8e0717a7c27d53c18`,
  byte-identical at the reviewed head `70054ecf5`, at merge commit `c800be44c`, and on `main`.

### Gates, in order

1. Both in-session subagent reviews returned **SAFE TO APPLY**, 0 BLOCKERs
   (`rls-security-reviewer`: 0 HIGH; `migration-drift-reviewer`: 1 HIGH, accepted — see residuals).
   The security review verified the "one delta per body" claim by diffing against the shipped
   byte-exact live bodies rather than trusting the header, and found **five changed lines total**,
   every one a date expression.
2. `write-apply-proofs.mjs` — both reviewer charters returned CLEAN machine verdicts from
   gpt-5.6-sol/high.
3. Exact-SHA push proof at `70054ecf5` (base `250464c9c`) — CLEAN.
4. The gate refused twice first, correctly: once because the fresh worktree had no
   applied-migration snapshot (no evidence of what the database had already run, so an out-of-order
   replay could not be detected), and once because the subagent review proof did not yet exist.

### Post-apply verification (read-only, same session)

Ledger 996 -> 997 rows. All four bodies at their candidate pins —
`_price_order_below_cost_impl_20260810` `bad627af481b79da93e5afbb1a3bc181`,
`_save_invoice_lineage_unaware_impl_20260827` `e1f1e0e641bd22f23505a7afc4384b2b`,
`_save_field_app_invoice_impl_20260714` `bf900b8bd31439b9fa2963b161e107ca`,
`_save_field_app_split_invoice_impl` `9288b8fb410f33b7c7d46ecfb76306fa` — each with exactly ONE
overload, `prosecdef` true, `search_path=public, pg_temp`, no CR bytes, and the America/Chicago
conversion present in all four. No schema-registry regeneration was required: the migration creates
no table, column, enum or generated column, and the registry-freshness hook wrote no stale flag.

### Two residuals, deferred deliberately — not fixed by this apply

- **(a) OPEN, DEADLINE 2026-09-30 — `season` is still UTC in two of the four bodies.**
  `_save_invoice_lineage_unaware_impl_20260827` and `_save_field_app_invoice_impl_20260714` stamp
  `season` from `current_season()` = `compute_season(CURRENT_DATE)`. `compute_season` rolls at
  month >= 10, so on 2026-09-30 after 7 pm Chicago a row is dated 2026-09-30 (season 2026) while
  stamped `season = 2027`. Before this apply both were UTC and agreed; correcting the date exposed
  the coupling. `season` drives `customer_application_rates` and year-end statements. The correct
  pattern already exists in the split body, which derives the season from the same COALESCEd Chicago
  date. Not an apply-blocker — the migration is still a strict improvement — but it needs a
  follow-up migration before 2026-09-30. Same class, later window: `next_invoice_number` takes its
  year from `extract(year FROM now())` (UTC).
- **(b) OPEN OWNER DECISION — the retained commission `CURRENT_DATE`.** Pinned at exactly 1 by the
  postflight so it cannot drift silently. It now disagrees with the Chicago-dated invoice written in
  the same transaction on a Chicago evening, where before the apply the two always agreed. Whether
  commissions should follow the invoice date is Mason's call.
