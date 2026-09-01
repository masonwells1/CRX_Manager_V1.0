## 2026-08-31 - Defer return-credit migration rollout

Recorded Mason's decision to keep the ordered six-file return-credit migration chain
`20260827041000` through `20260827041500` unapplied for now. A future live rollout requires
fresh explicit authorization and the migration safety gates in force at that time.

Moved the six unchanged SQL sources from `supabase/migrations/` to `scripts/.staging-migrations/`
so a broad Supabase migration push cannot apply the deferred chain accidentally. The disposable
real-schema verifier and focused migration contract test now read the staged sources.

The rejected `20260827223000` global ledger-order trigger is not part of the deferred queue.

Final review also hardened the staged sources before parking: soft-deleted invoices no longer
count as delivery billing coverage, and cancel-return rejects a blank reason before returning an
idempotent replay. Exact body and file hashes, the disposable verifier, and mutation tests were
updated with those corrections, including the next migration's fail-closed incoming-body pin.
The disposable verifier now attributes its source-basis mutation proof to the canonical costed
credit fixture that owns exact source-line lineage, rather than to a damaged zero-COGS credit
that intentionally owns no source lot. It also normalizes the temporary Windows Supabase schema
dump to LF before replay so exact source-fragment preflights reproduce production instead of
failing on CRLF-only test artifacts. These safety fixes do not authorize or perform a live apply.
Candidate SQL copied into that disposable database is LF-normalized for the same reason, matching
the governed apply artifact instead of the Windows working-tree representation.
The replay now pins `America/Chicago` before its first date baseline, preventing an evening run
from creating fixtures on tomorrow's UTC date and then reporting them outside today's CRX business
window. It proves the canonical chain before installing any deliberate mutants, restores exact
migration-installed function definitions, isolates inventory mutations from unrelated reporting
assertions, and keeps the recognized-COGS cap removal proof focused on its dedicated backdated
fixture. The corrected full replay completed every proof, reached `SMOKE_PASS_ROLLBACK`, and left
zero fixture residue; production remained read-only throughout.
