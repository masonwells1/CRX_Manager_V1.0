## 2026-09-17 - Restamped filenames corrected in four changelogs; alias masking finished

**What changed.** CodeRabbit's review of delivery PR #712 raised five Minor findings. Four were
documentation, one was declined with reasons, and one uncovered a real half-finished fix.

- Four changelog entries still named migrations by stamps that PR #704 retired on 2026-09-14, so an
  operator planning the apply would look for files that do not exist. Corrected to the current
  basename with the former stamp noted, never two `.sql` basenames on one line (that shape broke the
  parked-migration cross-reference guard on PR #707):
  `2026-09-10-transfer-cutover-drains-readers-and-expired-receipts.md`,
  `2026-09-14-transfer-guard-table-rls-and-postfix-run.md` and
  `2026-09-14-transfer-smoke-keys-match-validator.md` now name
  `20260914100800_bind_transfer_invoice_intent.sql`. `2026-09-08-transfer-invoice-intent-binding.md`
  was more than stale: it listed three migration files as the delivery's diff. After the merge with
  PR #704 the delivery touches exactly one, so the entry now says so.
- `docs/manual/KNOWN_ISSUES.md` residual (h) claimed `aliasNames()` still reads raw source. PR #708
  fixed only the sweep's call site; the pinned-site test still discovered aliases — and labelled
  sites — from raw source, where a `resetKey:` in a comment or string could invent an alias and
  relabel a pin. Both call sites now pass masked text, and residual (h) is closed. The trailing
  "needs a real tokenizer" sentence drops (h) and now records the deferred JSX gap instead.

**Declined, with reasons.** CodeRabbit also asked that `maskNonCode()` be made JSX-aware, because in
JSX text an apostrophe reads as an unterminated string and `//` reads as a line comment, blanking the
rest of the line and hiding any reset on it. The behaviour is real and already documented in residual
(h)'s list ("A `//` inside JSX text masks the rest of its line"). Distinguishing JSX text from
strings, comments, templates and regex literals is the real tokenizer that the same list says is
needed to close (a), (b), (f) and (g). That work is tracked in issue #686, which Mason deferred on
2026-09-14, and it does not belong inside a delivery PR whose subject is invoice-transfer binding.

**Proof observed.** `src/__tests__/idempotency-reset-order.test.ts` is 28/28, including a new case
that asserts the raw view still invents the alias (`aliasNames(commented)` returns `['refetch']`)
while the masked view returns none — so the fix cannot decay into a no-op — plus a positive control
that a real declaration survives masking. The pinned known-unfixed-sites list is unchanged by the
tightening, which is the evidence that no real site was relabelled. Typecheck, lint,
`npm run test:correction-guards`, `node scripts/check-doc-drift.mjs` and
`src/lib/assertRpcCoverage.test.ts` all pass.

**Not verified.** No live database was read or written. `20260914100800_bind_transfer_invoice_intent.sql`
remains parked and unapplied, and the independent `gpt-5.6-sol` exact-SHA review of this candidate is
still outstanding because the Codex account is over its usage limit.
