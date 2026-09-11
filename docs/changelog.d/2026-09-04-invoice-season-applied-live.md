## 2026-09-04 - `20260904180000_invoice_season_follows_invoice_date` APPLIED LIVE

- Applied to production (`rhyzpcqhnizqbxphqdkr`) at 15:22 UTC under Mason's explicit in-chat OK.
  Ledger version `20260904152221`, name `20260904180000_invoice_season_follows_invoice_date`;
  ledger 997 -> 998 rows. HTTP 201, one transaction carrying the migration and its ledger row
  (157438 bytes, queryHash `28f168dbf3d2e22a48bc9ddbb07f82e9202b2b6cc39529543d7a64491b98ee7c`).
  **The 2026-09-30 window is closed on the database side.**
- Gate provenance: a same-session `write-apply-proofs.mjs` mint in which BOTH reviewer charters
  returned CLEAN machine verdicts from `gpt-5.6-sol`/high. Verified from the capture tails rather
  than the exit code — `rls-security-reviewer` 98,874 tokens and `migration-drift-reviewer` 112,771
  tokens, each capture ending in the `tokens used` completion footer, which is what distinguishes a
  real run from a credit-exhaustion or backend-outage refusal.
- **The apply gate refused the first attempt, correctly.** `MIGRATION PENDING-SET GUARD`: this
  checkout's `origin` ref was 95 minutes stale, so a migration merged since then would have been
  invisible and applying over it would have stranded it permanently (the 2026-08-26 defect). After
  `git fetch origin`: PR #584 had merged with no migration files, live was unchanged at 997 rows,
  and both bodies still hashed to their pinned starting md5s. All five gates then passed.
- Post-apply verification, read-only against the live catalog in the same session — not the
  script's word, and not the in-transaction postflight:
  - `_save_invoice_lineage_unaware_impl_20260827` -> `e3fc9bd9c1da4b2eb8082e91781e4915`
  - `_save_field_app_invoice_impl_20260714` -> `29d699a8b0698424345a78e9aac9dcd1`
  - both exactly their candidate pins; **ZERO** current-season-helper calls and **ZERO** UTC
    current-date tokens in either body (the latter confirming the 2026-09-04 predecessor's fix is
    preserved); one `compute_season(COALESCE(` derivation and two America/Chicago conversions each;
    no CR bytes; `prosecdef` true with `search_path=public, pg_temp`; arity 3/7, volatility `v`,
    parallel `u`, not strict, cost 100 — all unchanged; exactly ONE overload each.
  - ACLs unchanged: `postgres=X/postgres` and `postgres=X/postgres | service_role=X/postgres`.
    Neither impl is reachable by `anon` or `authenticated` except through its wrapper.
- No schema-registry regeneration required — the migration creates no table, column, enum or
  generated column, and the registry-freshness hook wrote no stale flag.
- B7 note: the server-assigned ledger `version` (`20260904152221`) differs from the authored
  timestamp, but the ledger `name` preserved the authored basename, so the disk filename stays.
- **Still outstanding:** the companion frontend fix in `src/pages/FieldApplicationInvoice.tsx` (its
  transaction-date default was UTC, pre-filling tomorrow after ~7 pm Chicago) reaches production
  only when PR #599 merges. Until then that page can still send the wrong business DAY — but the
  season it produces will now agree with whatever date it sends, which is the mismatch this
  migration removed. PR #599 additionally requires green CI, a fresh exact-SHA `gpt-5.6-sol`
  adversarial review of the final candidate, and CodeRabbit, per the delivery contract.
- Process note worth keeping: CI caught a doc-drift failure the local run did not, because
  `npm run check:docs` was not part of the local pre-commit sweep — adding migration-history row 912
  left the file's own header claiming 911 entries. Run `check:docs` alongside typecheck/lint/test/
  build whenever a reference doc with a count claim is touched.
