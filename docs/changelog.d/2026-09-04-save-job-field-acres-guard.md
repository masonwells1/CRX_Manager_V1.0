## 2026-09-04 - Save-job field-acreage guard candidate

- Added a local-only forward migration candidate that rejects missing and JSON-null job-field acreage before writes with distinct diagnostics and newly accepts a non-null empty string from direct RPC callers as numeric zero; the UI already sends zero.
- Registered the candidate-only disposable proof separately, preserving the permanent live-runnable save-job parity chain and its 66-behaviour-test chemical-unit prover. The candidate proof reproduces both pre-candidate defects, includes separate mutation canaries for missing and null acreage, and covers a real numeric-Infinity case.
- Corrected the documentation-drift guard so a deliberately future-stamped candidate cannot force a false future verification date, and made the migration-history header state that 916 is the latest sequence rather than the number of rows.
- Made the canonical migration-review proof wrapper bind the hash and attached SQL to one read, stream large prompts through stdin, review only a sanitized temporary packet, and clear stale proof halves before every attempt so a failed re-review cannot inherit an earlier clean result.
- A 2026-09-04 read-only production survey found 5 stored job-field rows and no SQL NULL, negative, NaN, or infinite acreage; no existing job is affected. Missing JSON keys are request-shape defects and cannot be represented by stored relational rows.
- No production migration was applied.
