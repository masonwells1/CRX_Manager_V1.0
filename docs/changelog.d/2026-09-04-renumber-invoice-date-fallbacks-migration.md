## 2026-09-04 - Renumber the invoice_date Chicago-fallback migration so it can actually apply

- Renamed `supabase/migrations/20260903170000_invoice_date_fallbacks_chicago.sql` to
  `supabase/migrations/20260904160000_invoice_date_fallbacks_chicago.sql`. The SQL content is
  byte-for-byte unchanged (git records a 100% rename). Every reference was updated in the same
  commit: `.gitattributes` (the `eol=lf` pin), `docs/changelog.d/2026-09-03-invoice-date-fallbacks-chicago.md`,
  `docs/manual/DECISION_LOG.md`, `docs/manual/KNOWN_ISSUES.md`,
  `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`, `docs/reference/migration-history.md`
  (row 911), `scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs`, `src/lib/rpcContracts.test.ts`
  and `src/lib/rpcIdempotencyScope.test.ts`.
- Why: the file was authored 2026-09-03 and never applied, and four migrations were applied live
  while PR #589 sat open. Migrations apply in ledger `name` order, and by 2026-09-04 the highest
  applied timestamped name was `20260903230000_commission_report_snapshot_contract`, so a
  `20260903170000` file sorted below the high-water mark. That is the dangerous shape: it would not
  have been refused loudly, it would have been silently skipped forever — the PR could have gone
  green, merged, and shipped a migration that never ran, while every document claimed the fix was
  live. The new stamp clears every applied `name` and `version`, with headroom above same-day
  applies from other lanes.
- Recorded two ledger-reading traps in `docs/reference/migration-history.md` row 911. First,
  `version` and `name` are different columns and diverge here: `version` is the apply-time stamp,
  `name` is the file's own stamp, and the ordering guard reads `name` — reading the high-water off
  `version` gives a plausible-looking wrong answer. Second, `max(name)` returns garbage, because
  legacy non-timestamp rows (`year_end_summary`, `void_vendor_bill_rpc`,
  `warn_backdated_delivery_completion`) sort above digits; the correct query is
  `select name from supabase_migrations.schema_migrations where name ~ '^[0-9]{14}' order by name desc limit 1;`
- Re-verified the four preflight pins read-only against live (project `rhyzpcqhnizqbxphqdkr`) on
  2026-09-04, before and independent of the rename, so the renumber demonstrably does not invalidate
  them: `_price_order_below_cost_impl_20260810` `775317b102a0cd211418773aa409d510` (4 args),
  `_save_invoice_lineage_unaware_impl_20260827` `45e63ffc8e821467bcca056cad535163` (3 args),
  `_save_field_app_invoice_impl_20260714` `a44110b8398943fc6e450e776a7d7098` (7 args), and
  `_save_field_app_split_invoice_impl` `263dee1e74eab819f36dafbe59a5ba5e` (9 args) — all matching,
  all `SECURITY DEFINER`.
- Recorded that these pins hash `prosrc` (the function body only), NOT `pg_get_functiondef`. Hashing
  the full definition includes the header and yields entirely different digests; doing that during
  this change produced four apparent "drift" mismatches that were purely an artifact of the wrong
  query and briefly looked like a blocker.
- Deliberately left `scripts/smoke/fixtures/invoice-date-fallbacks-live-bodies-20260903.sql`
  byte-identical, so its line-4 comment still names the old filename. That fixture is `-text` in
  `.gitattributes:178` and carries 1300 literal CR bytes, because the proof installs production's
  `_save_field_app_split_invoice_impl` body byte-for-byte and pins its CRLF md5. Both a `sed -i` and
  the editor tool rewrote the whole file to LF, wiping every CR byte, and the prover then failed at
  `PHASE 1b` with the body hashing to the LF preimage `4a05478da4a8d6601eefd4aed5c0ab3b` instead of
  the CRLF pin. The file's own header says "Never hand-edit", and this is why. A stale filename in a
  comment is the strictly cheaper defect; anyone who must change it has to rewrite it through a
  CR-preserving path and re-run the prover.
- Proof: `scripts/smoke/prove-invoice-date-fallbacks-chicago.mjs` reports ALL PHASES PASSED,
  including the behavioural pair — PHASE 2 reproduces the defect (an invoice saved with no
  `invoice_date` stamped 2026-09-05, the UTC tomorrow) and PHASE 6 shows the fix (the same save
  stamps 2026-09-04, the Chicago business day) — plus PHASE 3 drift refusal, PHASE 1c
  disaster-recovery LF acceptance, and PHASE 7b's mutation check that the drift pin is load-bearing.
  `npm run typecheck`, `npm run lint` and `npm run build` are clean; `npm run test` passes 347 test
  files / 4946 tests.
- The migration remains NOT APPLIED. A live apply goes through `scripts/apply-migration-file.mjs`
  with fresh `write-apply-proofs.mjs` proofs and Mason's typed OK, per the standing gate.
