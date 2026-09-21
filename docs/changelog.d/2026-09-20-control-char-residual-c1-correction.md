## 2026-09-20 — correct the C1 claim in the accepted control-character residual, and record the parked forward migration

Documentation only. No code, no migration, no schema change, nothing applied to production.

### What was wrong

The `OPEN (ACCEPTED by Mason) 2026-09-20 — adjust_inventory accepts an idempotency key containing
ASCII control characters` entry in `docs/manual/KNOWN_ISSUES.md` carried a measured-false sentence:

> Under `COLLATE "C"` a `[[:cntrl:]]` test refuses only C0 controls and DEL. C1 controls, ZWSP, BOM,
> U+2028 and the soft hyphen still pass.

The C1 half is false. That sentence describes how much closing the gap would buy, so it understated
the value of the fix inside the very paragraph that justifies not doing it. Mason's accept still
stands — he re-affirmed it on 2026-09-20 when the corrected scope was put to him — but the record
should not carry a false measurement.

### What is true, measured

On PostgreSQL 17.6 (`public.ecr.aws/supabase/postgres:17.6.1.158`, db `en_US.UTF-8`/UTF8), by
enumerating code points rather than reasoning from the collation:

- `[[:cntrl:]]` under `COLLATE "C"` matches **exactly 64** code points: U+0001–U+001F, U+007F (DEL),
  **and the whole C1 block U+0080–U+009F — 32 of 32**.
- The **default** collation matches the same 64, so `COLLATE "C"` is defensive pinning, not the cause
  of that set. It is genuinely in effect — it changes other classes, e.g. `[[:alpha:]]` on U+00E9.
- `chr(0)` is refused by PostgreSQL outright (`null character not permitted`), so 31 + 1 + 32 = 64
  is exact, not approximate.
- NBSP (U+00A0), ZWSP (U+200B), BOM (U+FEFF), U+2028 and the soft hyphen (U+00AD) are **not**
  matched. That half of the original sentence was correct.

Measured three times independently, by parties that each predicted the opposite and tested instead
of asserting: a container prover in this delivery, an `rls-security-reviewer`, and a
`migration-drift-reviewer`. The shared wrong intuition is that `COLLATE "C"` selects the ASCII regex
strategy and therefore caps the class at ASCII. It does not for `[[:cntrl:]]`.

### Also recorded

The entry said the written fix was stranded on an unappliable branch. That is now out of date in a
way that matters for anyone who picks this up: a proper **new forward migration** exists, parked and
unapplied, on `claude/adjust-inventory-control-char-keys-20260920` at `4bcb1d5e3` (pushed, no PR).
The entry now names it, names the superseded branch that must not be revived, and lists what review
found still open on it — two postflight assertions proven defeatable (the cutover-trigger check no
longer inspects the trigger function's body; the control-character check is satisfied by a
commented-out clause) plus four documents still carrying the pre-correction scope wording.

The entry also claimed the case was "never tested, in either direction". Still true of everything on
`main`; no longer true of the parked branch, which carries
`scripts/smoke/prove-adjust-inventory-control-character-keys.mjs` and its rolled-back chain.

### Proof

Documentation change, so the proof is the measurement above plus the repository gates. The 64
code-point count and the C1 result were observed in a throwaway `--network none` PostgreSQL 17.6
container, not inferred.

### Not verified

Nothing in the live database was touched or re-read for this change. The live `adjust_inventory`
body, the accepted residual itself, and the parked migration are all unchanged by it.
