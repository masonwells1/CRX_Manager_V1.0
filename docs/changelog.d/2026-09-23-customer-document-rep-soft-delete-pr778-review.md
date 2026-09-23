## 2026-09-23 - soft_delete_customer_document: PR #778 review fix

CodeRabbit (CHANGES_REQUESTED), one Minor finding, valid. No code, SQL or prover change.

**The gate history I wrote in the previous round was false.** Row 936 said the `gpt-5.6-sol` gate
"has never run on any blob of this file". It has: it returned CLEAN on the earlier heads
`1789c72b3` and `8069cd45a`, as the 2026-09-21 sol-gate entry records. Those proofs are VOID for
the current head — the signature changed after them, and every commit since unbinds them — but
"void" and "never ran" are different claims, and the wrong one understates what has been reviewed
while sounding more cautious.

Corrected in all three places that carried it, not just the line CodeRabbit flagged
(`docs/reference/migration-history.md` row 936, `docs/manual/CURRENT_STATE.md`,
`docs/manual/KNOWN_ISSUES.md`): each now names the two heads, says why the proofs are void, and
keeps the operative point — **a fresh gate run is still required before merge or apply, and it has
not run since (Codex usage limit, retry 2026-09-26).** A grep for other wordings of the same
overstatement found none.

Worth recording because the error was mine and it was introduced by a fix: the previous round
removed a stale blob pin from row 936 and rewrote the surrounding sentence, and the rewrite
invented a stronger claim than the evidence supported.
