## 2026-09-01 — the guard-claim ratchet could be walked past three different ways

The same PR #530 review that found the two P1 guard bypasses also found three P2 defects in
`scripts/guard-claim-audit.mjs` — the ratchet this PR introduced to stop guard comments claiming more
than their tests prove. All three let a real overclaim report as "no new unbacked safety claims",
which is the one failure mode a ratchet must not have. All three are fixed, each pinned by a test
that was mutation-checked red.

**1. The baseline identity truncated at 80 characters.** A grandfathered claim longer than that could
be reworded anywhere past character 80 and keep its key, so the reworded claim matched the baseline
and passed — directly contradicting the ratchet's stated invariant that rewording is new. Identity
now uses the complete normalized claim text; only the DISPLAY string stays truncated.

**2. Negation was tested against the whole line.** Any unrelated disclaimer sharing a line suppressed
the claim on it. The reviewer's example was this PR's own
`// FAIL-CLOSED READ-ONLY ALLOWLIST — deliberately NOT a destructive-verb list.`, which is a genuine
fail-closed claim and reported nothing, because the `NOT` belonged to a different clause. Negation is
now read only in a 30-character window running back from the matched phrase and including it, which
still discharges the forms that matter ("is not a fail-closed guard", "does not guarantee").

**3. Claims were scanned one line at a time.** Guard comments and concatenated refusal strings in
this repo routinely wrap — `(fail` / `closed)`, `"… fails " +` / `"closed."`, `cannot be` /
`bypassed` — and every wrapped claim was invisible. A two-line join is now checked when the single
line does not match. Only a match that STARTS on the line reports there, otherwise every claim
preceded by a bare `//` was counted twice with `//` as its text.

**Effect on the numbers.** The scanner now finds 165 claims where it found 157. Nine keys are new;
three of them are in `review-proof-guard.mjs`, this PR's own file, and were **annotated with
`@proven-by`/`@unproven` rather than grandfathered** — including the one the reviewer predicted would
slip. The other six are pre-existing claims on `main` (`codex-push-lib`, `idempotency-body-check`,
`migration-apply-lib`, `production-action-guard`) that the old scanner could not see: newly
*detected*, not newly written, and grandfathered as such.

Because identity changed, every key changed, so the baseline was regenerated with
`--update-baseline`. The reason is recorded in the baseline file's own `note` field so the jump from
156 to 163 entries is not mistaken later for someone quietly widening the allowlist.
