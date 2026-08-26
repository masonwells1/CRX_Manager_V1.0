## 2026-08-26 — the trust-boundary migration was wedged by an out-of-order apply and is renumbered; its apply now refuses owner-helper drift

**The wedge, and the renumber (PR #499, Mason-approved).** While PR #401's
`20260825190000_quote_version_restore_trust_boundary` sat merged-but-unapplied, the
COMMENT-only `20260826150000_fix_save_job_comment_refusal_count` (PR #497) was applied live at
2026-08-26 20:59:35 UTC — twelve minutes after the apply-order constraint was posted publicly
on #497. That moved the ledger's name high-water past the trust boundary's stamp, and
`migration-ordering-lib.mjs` compares name stamps, so the security migration's apply was
refused outright — the same mechanical wedge that forced this file's first renumbering. Fixed
by `git mv` to `20260826220000_quote_version_restore_trust_boundary.sql` plus all thirteen
references-by-name (seven moved at the first renumbering; the growth is the round-8-to-11
pin/test/smoke additions). No fingerprint changed — every pin hashes normalized function
bodies, never filenames — proven by running the mirror, contract, and parser suites
post-rename: 153/153. The applied comment migration is metadata-only, so the damage is pure
ordering: the security fix is delayed, not weakened. Causal record: `migration-history.md`
entry 892.

**Apply-time hardening (Sol exact-SHA review, CRX-MIG-DRIFT-001).** The migration body-pins
the two owner helpers but the standing sweep is not transactional with the apply — so a second
owner-helper overload (born EXECUTE-able by the API roles on this project) or a browser grant
appearing between review and apply would sit outside every pin. The precondition and
postcondition now assert exactly one overload of each owner helper and no anon/authenticated
EXECUTE (measured live 2026-08-26, read-only: one each, none — the assertions are no-ops today
and fail closed on drift). Sol's remaining finding is the in-transaction cutover race: the
owner's recorded accepted risk, deliberately unresolved on #401.

**Smoke pass token anchored to an identifier boundary.** `interpret-result.mjs` accepted any
error message merely EXTENDING `SMOKE_PASS_ROLLBACK` — `SMOKE_PASS_ROLLBACK_BUT_FAILED` (Sol)
and, after the first fix, `SMOKE_PASS_ROLLBACK$BUT_FAILED` (CodeRabbit — PostgreSQL
identifiers may contain `$`). The boundary now excludes `[A-Za-z0-9_$]`, with red/green
regressions for both attack strings observed failing (4/4).

Not verified: the migration itself remains UNAPPLIED — the apply follows PR #499's merge,
from the owning session, through the gated file-bytes door with fresh proofs.
