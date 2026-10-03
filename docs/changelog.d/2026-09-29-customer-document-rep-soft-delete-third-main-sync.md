## 2026-09-29 - soft_delete_customer_document: third `main` sync; hold no longer names a fixed PR number

PR #800 merged `main` again (#823, #826 and the docs cleanup part 2, #839; no conflicts). The
field-season migrations the ordering hold waits on (`20260914101000`..`101300`) keep moving to a new
PR number (#793, #832, #837, #838, #842, now #843), so `CURRENT_STATE.md`, `KNOWN_ISSUES.md` and
migration-history row 936 plus its addendum now name "the open field-season delivery PR" with the
number current on 2026-09-29, instead of a number that goes stale within hours.

Read-only live ledger check 2026-09-29: the newest `20260914` file live is still
`20260914100900` (`20260928025520`); `20260914101000`..`101300` are not live, so the hold stands.
The real-schema prover was re-run after the merge (result in the PR thread).
