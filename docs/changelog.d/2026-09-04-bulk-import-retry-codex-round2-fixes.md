## 2026-09-04 - Bulk field import retry: close the Codex round-2 findings

Second `gpt-5.6-sol` high-effort review, this time over BOTH commits together, with the round-1
fixes explicitly framed as new code and prime suspects and six named claims of mine to falsify.
Run confirmed complete (`tokens used` marker, no 404/quota).

**34 findings → 11. Both BLOCKERs gone.** Round 2: 0 BLOCKER, 3 HIGH, 4 MEDIUM, 3 LOW, 1 QUESTION.

Sol independently confirmed the round-1 fixes are real rather than cosmetic: `overrideOk` is scoped
freshly per row and reachable, a throw from `assertRpcResult` does enter the catch and set it false,
the override test's mapping dependency genuinely holds, reverting the gate does break the test, and
the identical-row test does fail when the counter is replaced with zero.

### Fixed — the one real HIGH

- **An out-of-band stated acreage still retired the save key** (finding 1). The gate asked "did an
  RPC fail", but the right question is "did an override the operator REQUESTED fail to land". A
  stated acreage the client rejects as out-of-band never reaches the server, yet the requested
  billing acreage did not apply — and correcting that number and re-importing is the same retry
  shape as any other correction. The row retired its save key, so the correction inserted a SECOND
  field. `overrideOk = false` now covers the client-side rejection too. A row with NO stated acreage
  requested no override and is still complete.

### Refuted — two HIGHs, from source

- **Findings 2 and 3 ("a falsy, non-throwing `assertRpcResult` still retires all keys")** do not
  apply. The real helper in `src/lib/db.ts` **throws** on `null`/`undefined` and otherwise returns
  the data; it is not a predicate and never returns falsy silently. Sol reasoned from the test's
  mock because the packet did not supply the real contract — my omission, and the same gap it
  flagged at 65% confidence in round 1 (finding 22).
- **But the underlying complaint was fair**, so it is fixed anyway: the test mocked
  `assertRpcResult` as `(data) => data != null`, a predicate. The tests therefore described a
  contract the app does not have. The mock now mirrors the real throwing helper.

### Fixed — documentation that still carried a refuted claim

- **The false `total_acres` rationale was still in the executable source and the guard comment**
  (finding 6). Round 1 corrected the changelog but not `BulkFieldImport.tsx` or
  `gauntletFrontendSafetyGuards.test.ts`, which both still said the boundary overwrites the seed
  "moments later" / it "never survives". A known-false rationale sitting next to the code it
  justifies is worse than none. Both now state the real reason (exclusion is what lets a corrected
  retry replay) and explicitly flag the failure path where the seed does persist.
- **The correction itself overstated the harm** (finding 7). Saying a corrected retry means "the
  corrected acreage never lands" is false in general: a successful corrected `set_field_boundary`
  writes `measured_acres` and `total_acres` from the corrected geometry. The stale seed persists
  only while no boundary call succeeds, or the row is abandoned.

### Fixed — tests that could pass for the wrong reason

- **The override test proved retention but not repair** (finding 4). It asserted the save key was
  reused but never that the retry re-attempted the override. It would have stayed green if the
  retry silently stopped calling it. Now asserts two override calls, the second against the original
  field id with the right acreage, and that the warning is gone.
- **The identical-row test's two distinct keys were not uniquely attributable to the counter**
  (finding 5). If a regression swallowed row 1's boundary failure, row 1 would retire its scope
  normally and row 2 would mint a fresh key anyway — passing for an unrelated reason. It now pins
  that row 1 genuinely failed, making the key-retention precondition part of the test.

### Still open, unchanged

Findings 8 (abandoned scopes accumulate in the component-lifetime map), 9 (the source-string counter
guard is still defeatable by a `.clear()` inserted before the asserted read), 10 ("exact payload"
is inaccurate wording for `save_field`, which does write `total_acres`), and 11 (QUESTION: is an
override-rejected row "complete" for the success count but "unfinished" for key retention — a split
this change deliberately keeps, since the row IS imported and billing on measured acres). The
round-1 accepted limits — remount/refresh, receipt expiry, correcting a save-owned attribute,
re-importing a mixed-result file, cross-invocation ordinals — all still stand and still need a
durable server-side field identity.

### Verification

`npm run lint` clean · `npm run test` 356 files / **5020 passed** / 0 failed · `npm run build`
succeeded.

Nine mutations, source restored byte-identical after every run, all RED:

- `B2` revert the `overrideOk` gate → guard RED, behavioral RED
- `B2b` gate present but `overrideOk = false` never set → guard RED, behavioral RED
- `R2F1` out-of-band acreage no longer blocks retirement → guard RED, behavioral RED
- `S24` neuter the occurrence counter → guard RED, behavioral RED
- plus the original five (delete all three resets; delete only the `save_field` reset; retire with
  the wrong scope; move `total_acres` back into the identity; put the file position back into the
  scope) → all still RED
