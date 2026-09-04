## 2026-09-04 - migration-drift-reviewer CHECK 2 requires exactly one post-migration overload and stops calling regprocedure schema-qualified

**Files:** `.claude/agents/migration-drift-reviewer.md` (CHECK 2 step 4),
`scripts/check-agent-guidance.mjs`
**Found by:** second exact-SHA `gpt-5.6-sol` push proof on PR #594, commit `7edceff`

Three real findings against the identity-signature rewrite recorded in
`2026-09-04-drift-reviewer-check2-identity-signatures.md`. All three were verified against the
repository's own sources before being accepted.

## HIGH — a surviving overload could still return clean

The rewrite said a signature that matches an existing live signature REPLACES it, "no new
overload → clean". That is wrong when the name carries a second live overload the migration
leaves in place: nothing is added, yet the post-migration set still holds two, which is the March
2026 shadow-overload shape.

`docs/workflows/SAFE_DEVELOPMENT_RULES.md` is explicit — the `pg_proc` query "Must return exactly
1 row. If >1, consolidate before adding more." Step 4 now computes the post-migration signature set
and requires **exactly one** signature, emitting **BLOCKER** for more, whether this migration added
the extra or merely inherited it. A pre-existing overload does not become acceptable because this
migration did not create it.

## HIGH — `oid::regprocedure::text` is not schema-qualified

The rewrite called it "the full schema-qualified identity signature". It is not: `regprocedure`
renders search_path-dependently, dropping the schema when the function is visible on the current
path and printing it when it is not, so one function yields two different strings on two sessions
and a namespace confusion can fake a replacement match.
`scripts/db-invariant-sweeps/predicates/office-only-pricing-secdef-gates.sql` already documents
this. Step 4 now requires the schema and the signature as **separate columns** (`nspname` from a
joined `pg_namespace`, plus `oid::regprocedure::text`), forbids reading the schema off the
`regprocedure` text, and points at `to_regprocedure('public.' || signature)` for resolving a known
signature.

## MEDIUM — the semantic detector failed open on cross-clause negation

`clearsOverloadFindingOnCount` suppressed detection whenever a negation appeared anywhere in the
sentence, so `Do not consult history; a live overload count of 1 clears this finding` passed
undetected. It now splits on clause boundaries and requires the negation to sit in the same clause
and before the verb, and that exact bypass string is a permanent adversarial sample. The verb list
grew by five obvious synonyms and is deliberately not exhaustive: the **exact-text assertions are
the primary guard** — they pin the required sentences verbatim, so a rewrite that drops them fails
whatever wording replaces them — and the detector is a secondary net for text appended beside the
pinned sentences. A comment in the file says exactly that, so it does not outclaim what it tests.

Five assertions replace or join the earlier set, pinning the exactly-one requirement, the
BLOCKER-on-a-surviving-overload branch, the `SAFE_DEVELOPMENT_RULES` citation, the separate
namespace column, and the explicit refusal to call the `regprocedure` text schema-qualified.
