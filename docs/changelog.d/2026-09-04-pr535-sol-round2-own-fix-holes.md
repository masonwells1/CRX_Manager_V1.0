## 2026-09-04 - PR #535: close the round-2 holes in the round-1 fixes

Second `gpt-5.6-sol` high-effort review, frozen candidate `51cd1df58`, prompted to treat the
round-1 fixes as new code and prime suspects. Result: **0 BLOCKER**, 1 HIGH, 5 MEDIUM, 5 LOW,
2 QUESTION, and an explicit re-confirmation that all four round-1 rejections were correct.

This commit closes only the findings that are defects in the round-1 fixes themselves. Everything
else is parked below rather than fixed unattended.

### Fixed — holes in my own round-1 fixes

- **The BLOCKER fix failed OPEN when the baseline was missing.** The reviewed-vs-authoritative
  revision comparison was guarded by `typeof reviewedRevision === 'number'`, so when
  `activeCount.item_revision` was absent (the field is optional, and the `openDetail` seed read can
  fail) the comparison was SKIPPED and completion proceeded — silently restoring the exact bug the
  guard exists to close. Missing baseline is now treated the same as a mismatch: refresh, explain,
  require another click. The refresh stores the authoritative revision, so the next click proceeds.
- **The partial-reversal refresh was launched, not awaited.** `fetchData()` was called without
  `await` immediately before a rethrow, so `runCriticalAction` finished and re-enabled the controls
  while the already-reversed rows were still displayed, and a refresh rejection became an unhandled
  rejection that could displace the real reversal error. Now awaited inside its own non-throwing
  block, preserving the original error.
- **`logNotificationFailure` silently swallowed a failed failure-log.** It awaited
  `supabase.rpc('log_failed_notification', ...)` without `.throwOnError()`. Supabase RESOLVES with
  `{ error }` rather than rejecting, so a database error there wrote no failure row, produced no
  Sentry breadcrumb, and never reached the catch — the alert was lost *and* the loss was invisible.
  Now uses the `.throwOnError()` fire-and-forget form so the catch converts it into a Sentry report.
- **The money boundary test named the wrong boundary.** `Number.MAX_SAFE_INTEGER` is 9007199254740991
  cents — `$90071992547409.91`, not `.90`. Calling `.90` "the largest exactly representable amount"
  left the real boundary untested and would have passed an off-by-one that wrongly rejected a
  legitimate maximum. Now pins `.91` accepted (asserting it equals `MAX_SAFE_INTEGER`) and `.92`
  rejected. Verified by running it.

### Parked — real, but not to be fixed unattended

- **HIGH — bulk field import retry can duplicate a field.** `save_field`'s key scope includes
  `fieldIndex` and downstream boundary/acreage data, but `save_field` commits BEFORE those RPCs. If
  the boundary call then fails and the operator retries only that row (changing its index), the
  scope changes, a new key is minted, and `save_field` runs again with `p_field_id: null` — creating
  a second field and orphaning the first partial one. The fix is a redesign (stable
  client-generated field ID, per-stage intent, per-stage retirement) on a data path, and is Mason's
  call, not an unattended 05:00 change.
- **MEDIUM — a hung write in one cycle count blocks completing any other.** `failedItemWritesRef` is
  scoped per count but `pendingItemWritesRef` is component-wide, and completion awaits all of it.
- **MEDIUM — FNV-1a collision surface on key-only RPCs.** Restated from round 1; the documented
  limit stands, the structural fix (SHA-256 or full canonical payload as the local scope) does not.
- **MEDIUM/LOW — four more mutation-vacuous assertions** in `gauntletFrontendSafetyGuards.test.ts`
  and `NewVendorBill.overage.test.tsx` (queue chaining, reconcile scope contents, stage retirement,
  and a PO that is never selected). Same class as the round-1 test fix, different call sites.
- **LOW — fingerprinting a 25 MB import can block the main thread** (synchronous BigInt over every
  byte).
- **QUESTION — reconcile retires its key before an awaited `fetchAll()`** that is still inside the
  mutation's catch boundary.

### Verification

`npm run typecheck`, `npm run lint`, `npm run test` (354 files, 4992 passed, 0 failed) and
`npm run build` all pass on this tree. The corrected money boundary was additionally confirmed by
executing the real module.

**Not browser-verified:** the cycle-count completion guard, the receiving post-commit block, the
bulk-reversal refresh and the damaged-notification fallback. This worktree has no `.env`, copying
one in was denied by permission and was not worked around, and `harness.local/` exists only in the
main checkout. Those rest on typecheck + lint + tests + build only and must not be reported as
browser-proven.
