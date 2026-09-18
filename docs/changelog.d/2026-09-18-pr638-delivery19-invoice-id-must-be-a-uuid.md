## 2026-09-18 - A transfer result's invoice id must be a UUID; three #638 review rounds

**What changed.** `assertTransferResultForJob()` in `src/lib/db.ts` accepted any nonblank string as
`invoice_id`. Both job-invoice screens retire the request key on that result, and `JobDetail`
navigates to `/field-invoices/<invoice_id>`, so a value such as `not-an-invoice` or a
whitespace-padded id would have been treated as a verified success (CodeRabbit, PR #720, Major).
The guard now requires the canonical 8-4-4-4-12 hex form of a Postgres `uuid`, any version, with no
padding, and anything else throws `TRANSFER_INVOICE_RESULT_INVALID` into the existing
reconciliation path. The live RPC builds `invoice_id` from a `uuid` column, whose text form is
already canonical, so a real transfer is unaffected. The component tests' placeholder ids
(`invoice-1`, `invoice-other`) became UUIDs so they keep exercising the success and wrong-job paths.

The same review raised two documentation items, both fixed: a `KNOWN_ISSUES.md` line began with
`#535` (markdownlint MD018), and a `migration-history.md` sentence called rows 917-921 commission
candidates although 917 is the next-invoice-number candidate and 921 was superseded with no file.

Earlier review rounds today, all on delivery PRs for #638 and all documentation-only: #715 merged
`main` (#646); #717 reconciled a finding count; #719 scoped the `invoice_id` no-refusal claim to the
screen guard and declined an applicator auto-draft finding with evidence (`complete_job` calls the
transfer only for admin or sales-rep completers; the policy is Mason's, #107); #720 closed scanner
residuals (f) and (g), which the whole-file mask had resolved on 2026-09-13.

**Proof observed.** `src/lib/db.test.ts` gains `non-UUID` and `whitespace-padded` rejection cases.
The five touched test files pass (98 tests), `npm run typecheck` is clean and `eslint` is clean.

**Not verified.** No live database was read or written, and no real transfer was run. The Sol
exact-SHA review for this candidate is still outstanding while the Codex account is over its limit.
