## 2026-09-08 — the unresolved-attempt freeze held one row, not each row

`useUnresolvedIntent` kept a single unresolved scope. On every screen that uses it the
in-flight guard is keyed per row, so two operations can be outstanding at once and the
last callback to finish decided what the freeze held.

### The failure

Duplicating two blend recipes overlaps freely: `duplicateInFlightRef` is a `Set` keyed on
`duplicate:${recipe.id}`, which stops a second click on the SAME recipe and nothing else.

1. Duplicate recipe B. While it is in flight, duplicate recipe A.
2. A fails ambiguously — a lost response, not a server refusal — so `markIfUncertain`
   freezes scope A. Whether A's copy committed is unknown.
3. B succeeds and calls `clear()`, which took no argument and cleared everything. A's
   freeze is gone with no signal.
4. Edit recipe A and duplicate it again. The fingerprint changed, so the scope changed;
   `refuseEdited` now sees nothing unresolved and lets it through; `getKeyFor` mints a
   fresh key. `save_blend_recipe` replays on the key alone and `blend_recipes` has no
   uniqueness constraint, so a SECOND copy is created while the unobserved first copy
   stays.

That is exactly the double-apply the freeze exists to stop. Found by CodeRabbit on
`src/pages/BlendRecipes.tsx`; the same shape existed on `IntegrityCleanupPanel`, whose
reconcile guard is also keyed per row.

### The fix

The hook now holds a `Set` of unresolved scopes. Each one stays frozen until that scope is
itself settled, and `refuseEdited` refuses any scope the set does not contain while the set
is non-empty — so a faithful retry of any outstanding attempt is still allowed and every
edited payload is still refused.

`clear` now **requires** the scope it settles. That is the guard rather than a formality:
the type-checker refuses any call site that cannot name the attempt it just resolved, so
a success on one row can no longer lift another row's freeze. All four call sites pass
their own scope — `BlendRecipes`, `InventoryPage` (hold and adjust) and
`IntegrityCleanupPanel`.

### Proof

Two new tests in `src/hooks/useUnresolvedIntent.test.tsx` walk the exact sequence above and
the both-unresolved case. Both were mutation-proven: reverting `clear` to ignore its scope
and clear the whole set fails them (`isFrozen` false where it must be true). `tsc` clean,
lint clean, `npm run test:correction-guards` exit 0, `check-doc-drift` clean, full vitest
suite 371 files / 5219 passed / 0 failed.

### Also fixed

`BulkFieldImport` advanced to step 6 — the progress screen — before `handleUpload` checked
that the signed-in profile had loaded. Step 6 has no Back button and its Next button is
disabled, so an operator whose profile had not loaded was stranded on "Importing field 0 of
0" with cancelling the dialog as the only way out. The check now runs before the step
changes, leaving the review step on screen so the import can be retried. Reported by
CodeRabbit as a minor functional-correctness issue.
