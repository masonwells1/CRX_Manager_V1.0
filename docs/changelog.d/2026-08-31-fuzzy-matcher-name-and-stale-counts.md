## 2026-08-31 — Name the real fuzzy matcher and retire superseded counts

Third Codex pass on PR #529, two findings, both verified and both mine rather than new defects in
the measurement itself.

### The fuzzy-matcher reference was only half fixed

`docs/reference/code-patterns.md` originally pointed at `fuzzyMatchProduct()` in
`src/lib/ocrParser.ts`. The earlier fix in this PR corrected the *file* but kept the *function
name*, which does not exist — an exact-identifier search (`fuzzyMatchProduct\b`) returns nothing,
`fuzzyMatchProductWithScore()` being a different identifier that merely shares the prefix. A
reader following the "corrected" reference still could not find the API.

What actually exists:

- `fuzzyMatchProductWithScore()` — `src/components/purchase-orders/BulkPOImport.tsx:87`, a thin
  wrapper;
- `resolveFuzzyProductIdentity()` — exported from `src/lib/productIdentityResolver.ts`, where the
  matching actually happens;
- the 0.7 threshold is `minimumScore = 0.7` in `productIdentityResolver.ts:74`, not in the
  component.

The entry now names both functions and puts the threshold where it lives. The lesson: correcting
half of a wrong reference produces a reference that is still wrong, and looks verified.

### The first changelog entry still published superseded numbers

`2026-08-31-docs-cleanup-and-branch-inventory.md` was written against the round-two figures and
still claimed 16 branches carrying absent migrations and 15 mechanically safe to delete, along with
the obsolete whole-tree method description. The final report says 12, 4 modifying an existing
migration, and only 2 safe.

Since these files are the durable record of the change, a reader consulting that entry could have
treated 13 branches holding unique authored content — including live Dependabot PRs — as safe to
delete. The entry now carries the corrected end state and points at the two correction entries
rather than restating a method that no longer applies.

### Proof observed

- `grep -rn "fuzzyMatchProduct\b" src/` returns nothing — the word boundary is what makes this
  exact, since a bare substring search would match `fuzzyMatchProductWithScore`.
  `fuzzyMatchProductWithScore` and
  `resolveFuzzyProductIdentity` were read at their cited locations, as was `minimumScore = 0.7`.
- `npm run check:docs` passes.
