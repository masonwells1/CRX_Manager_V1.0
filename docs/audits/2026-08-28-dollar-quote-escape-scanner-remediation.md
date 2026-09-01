# Dollar-quote escape-string scanner remediation

## Finding

An independent exact-head review found that `stripDollarQuotedCore` handled a PostgreSQL `E'...'` literal as an ordinary string. A backslash-escaped quote could therefore let a dollar-quote marker inside the literal pair with one later in a comment, hiding a top-level `DELETE` from the destructive-migration classifier.

## Proof and repair

- Reproduced direct classifier bypass: `destructiveMigrationCheck(...)` returned `false` for the reviewed payload.
- Reproduced armed migration-path bypass: `evaluate(...)` returned `allow` with matching reviewer proofs.
- Repaired the protected scanner through the reviewed, input/output-pinned maintenance transformer. The accepted scanner blob is `419f4e8fc0b08566c6ebd139dde312d7553eb3f7`.
- Its independent artifact review returned `DOLLAR_QUOTE_ESCAPE_MAINTENANCE_VERDICT: CLEAN`; it verified 40 exploit variants and 85 non-E-string parity checks.

## Prevention

- `migration-apply-guard.test.mjs` directly asserts the full escape-string/dollar-tag payload is destructive.
- `migration-apply-lib.test.mjs` proves an armed hands-free run rejects that same payload even with otherwise valid proofs.
- The retained maintenance harness is re-pinned to the reviewed scanner blob so future guarded maintenance cannot silently drift from this parser state.
