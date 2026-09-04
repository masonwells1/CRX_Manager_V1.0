## 2026-09-03 — a lock assertion that passed precisely when the lock was missing, and a receipt that cannot prove what it claimed

Independent `gpt-5.6-sol` review (high reasoning effort) of the PR #535 candidate at head
`0b5034a5c`, after four CodeRabbit rounds all returned `CHANGES_REQUESTED`. Two runs: frontend +
sweeps/smoke, and the six migrations.

**Files:** `scripts/smoke/prove-gauntlet-write-boundary-concurrency.mjs`,
`src/pages/VendorBillDetail.tsx`, `src/pages/CycleCounts.tsx`, `src/pages/Reports.tsx`,
`src/components/integrity/IntegrityCleanupPanel.tsx`, `src/lib/section9ReceivingApSafety.test.ts`

### HIGH — the cycle-count lock assertion was satisfied by the bug it existed to catch

```js
triggerBody.indexOf('FOR UPDATE;') < triggerBody.indexOf('SET item_revision = item_revision + 1')
```

An absent `FOR UPDATE;` yields `-1`, which is below every real offset, so the assertion passed
**because** the lock was gone. Line 226 of the same file already did this correctly
(`poItem >= 0 && po > poItem && …`), so this was a one-off slip, not a convention.

Both offsets are now proven non-negative before their order is compared, and the enclosing
function bounds are asserted so a failed `indexOf` cannot silently produce a garbage slice.
Mutation tested: on a lock-free trigger body the old form returns PASS and the new form FAILs;
a correct body still passes. 7th instance of the recurring "a check that binds one half of a
pairing is satisfied by the bug" class.

### MEDIUM — "This edit was already saved" could not be true from the evidence it used

`VendorBillDetail` matched an `IDEMPOTENCY_INTENT_MISMATCH` receipt on `bill_id` alone and then
told the operator their edit had saved. An intent **mismatch** means the payload differed, so the
receipt necessarily belongs to an EARLIER submission against that same bill — `bill_id` matches
in both the safe and the unsafe case, so it discriminates nothing.

Sol also refuted the fix originally planned here (compare the receipt's `new_total_cents` against
the submitted subtotal + adjustment): the differing field can be the notes or either date at an
identical total, so **no** field comparison at this site can prove the on-screen edit is the one
that committed. The message now reports only what the receipt proves — an earlier edit landed,
the current fields are unconfirmed — and refreshes so the stored bill is visible.
`resetKey()` stays in both branches; it is load-bearing for duplicate recovery.

### MEDIUM — a completed inventory adjustment could be reported as a failure

`CycleCounts` ran `logActivity` inside `runCriticalAction`, after `complete_cycle_count` had
committed and its idempotency key was retired. A logging rejection therefore surfaced a
successful inventory adjustment as failed, and the retry ran under a fresh key against an
already-completed count. Logging is now a caught post-commit side effect.

### LOW — `isNaN` admits Infinity

`IntegrityCleanupPanel` gated a reconciling quantity on `isNaN(n) || n < 0`. Exponent notation
(`1e309`) parses to `Infinity`, which is neither NaN nor negative. Proven by execution: `1e309`
and `Infinity` were accepted before and are rejected now, while `12.5` still passes and
`-3`/`abc`/empty still fail. Now `!Number.isFinite(n)`.

### MEDIUM — a historical cutoff the report never applied

Commission Balance always queries `todayInBusinessTz()`, but the date pickers and presets stayed
live, so the screen displayed a cutoff it silently ignored. They are disabled for that tab; CSV
export is unaffected. The **behavior** is pinned by test now, not only the banner wording — the
new assertion was mutation tested by reverting the call site (red) and restoring it (green).

### Not actionable in this PR — 24 migration findings

All six migrations were applied to production on 2026-09-03 and are immutable, so every
correction is a separate forward migration. Sol's own verdict: "CHANGES REQUIRED via new forward
migrations." Recorded as follow-up, not a #535 blocker.

Sol's read-only detection queries were run against live. Clean (0 rows): null-PO-total bypassing
overage confirmation, negative/nonfinite cycle-count quantities, invalid commission money.
**Not clean, and pre-dating this PR:** 19 `inventory` rows with negative `quantity_available`
(all last touched 2026-07-02..2026-07-17, zero touched since the migrations went live), and PO
item `e6559c38-4ae4-4899-b33c-a23e8900cec8` storing 227.5 received with no backing
`receiving_records`. Both unowned.

Sol also confirmed the earlier absent-role rewrite is correct and complete across every visible
arm, with no remaining `EXISTS(role) AND has_table_privilege('name', …)` shape.

Verified: typecheck, lint, production build, 354 test files / 4989 tests pass. Not verified: the
disabled Reports controls were not rendered in a browser — the auth-gated stub harness does not
exist in this worktree.
