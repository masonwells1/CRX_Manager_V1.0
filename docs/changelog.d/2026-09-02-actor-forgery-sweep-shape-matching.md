## 2026-09-02 — actor-forgery sweeps recognise the guard shapes live code actually uses

**Branch:** `claude/actor-forgery-triage-20260902` (commits `c8c38045`, `85263657`) — not yet landed.
**Files:** `scripts/db-invariant-sweeps/predicates/actor-forgery.sql`,
`actor-forgery-fin-audit.sql`, `actor-forgery-predicates.test.mjs`, `README.md`,
`docs/audits/2026-09-02-actor-forgery-predicate-triage.md`.
**No live data mutated, no migration, no live routine changed.**

## Why

PR #449's rewrite of the post-apply actor-forgery sweep took the live sweep from **1 row (green)**
to **56 rows / 55 routines** with only 2 allowlist entries — 53 unallowlisted. The 2026-09-01 cap
entry names these sweep predicates as the FIRST load-bearing protection against actor forgery, so
landing that as-is would have blunted the primary control to land a capped speed bump.

The same predicate blob (`a8e192daa7be…`) is byte-identical on
`claude/actor-forgery-sweeps-20260902`, the branch split out as "the safe half", so that branch
carried the identical regression. Its commit message's "zero routines newly reported" is true only
of its own delta, not versus `main`. PR #551 was closed for this reason.

## Triage result

**All 56 reported rows are false positives. Zero real actor-forgery holes.** Live code uses four
refusal-message spellings, two actor-binding forms, and both `IS DISTINCT FROM` and `<>`; the
predicate demanded exactly one combination. Per-row adjudication is in the audit doc.

## Decision

Mason, 2026-09-02, in-chat: **fix the checker, do not add exceptions.** Allowlisting 53
correctly-guarded routines would suppress the detector across most of the surface it exists to watch
and would need a new entry for every future routine written in house style.

## Change

Refusal credited by SHAPE rather than message literal; DECLARE-initializer binding accepted
alongside the assignment statement (ordering still enforced by match position); null-tolerant and
`<>`/`!=` refusals accepted; candidacy narrowed to uuid **or a user-defined type** — the second half
keeps the composite-type operator-overload class in scope and must not be simplified away.

Removing the fixed literal removed the anchor that made most match attempts fail immediately, and
the sweep began timing out against the live catalog. Four performance fixes were required: collapse
whitespace once in `lexed`; ordering by match position instead of a quadratic `.*?` bridge; `~*`
instead of `EXISTS (SELECT 1 FROM regexp_matches(…, 'gi'))`; and `OFFSET 0` fences so
`pre_refusal_src` is not recomputed once per WHERE arm.

**Live rows: 56 → 18**, with no allowlist entry added.

## Proof

Real PostgreSQL 17 container. Four ALLOW fixtures (one per live guard style) plus three DENY
canaries for the loosening itself — a correct comparison that only `RAISE NOTICE`s, an initializer
bound to the parameter instead of `auth.uid()`, and a null-tolerant shape compared against a random
uuid. The 22 pre-existing must-report fixtures still report. Mutation-tested in both directions.
Live counts measured read-only against `rhyzpcqhnizqbxphqdkr`.

## Still open

18 rows remain, deliberately NOT allowlisted: 13 thin dispatch wrappers (guard one call hop away in
a callee `authenticated`/`anon` cannot execute), 3 with `EXCEPTION WHEN OTHERS` later in the body
(the pre-existing fail-closed rule), 1 read-only filter, 1 already allowlisted. Each needs a
specific new checker capability; two are analyses where a wrong simplification would create a false
negative in a security control. Scoping call for Mason.

Separate finding, tracked in the audit doc: `link_fields_to_parent`, `save_field_polygons` and
`unlink_field_from_parent` accept `p_performed_by` and never reference it — an attribution gap, not
a forgery. Both properly authorized and both genuinely enforce `p_idempotency_key`.

## Guard quirks discovered (live-data read guard)

`AS MATERIALIZED (` is refused as a call to `materialized()`; `[\s(]` is refused because the class's
own `s` precedes `(`; `\M(?:` is refused for the same reason. Bounded quantifiers are not an escape
— PostgreSQL rejects a fully bounded refusal pattern with "invalid repetition count(s)".
