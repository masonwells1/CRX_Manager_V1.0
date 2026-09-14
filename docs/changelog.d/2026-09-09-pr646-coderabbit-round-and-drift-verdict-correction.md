## 2026-09-09 — PR #646: CI unblocked, and a review-verdict overclaim corrected

PR #646 (the cycle-count completion-revision apply) failed CI and drew four CodeRabbit
findings. This entry records what was wrong, what was fixed, and what was rejected with
evidence.

### The CI failure was not this PR

`Lint, Type Check, Test, Build` failed at 28s on `npm audit --audit-level=high`: a newly
published HIGH advisory against `js-yaml` (GHSA-2883-xcg3-v3hh), reached transitively via
`eslint → @eslint/eslintrc → js-yaml@4.3.1`. The branch touches **zero** dependency files —
its whole diff is four docs and one migration — and the failure reproduced locally against
the same lockfile, so it was blocking every PR in the repo, not this one.

Already fixed on `main` by #645 ("bump js-yaml past the HIGH advisory blocking every PR").
The branch was two commits behind and simply had not picked it up. Merged `origin/main` in
(zero file overlap, clean merge), reinstalled, and re-ran the exact CI command:
`npm audit --audit-level=high` → `found 0 vulnerabilities`, exit 0. The job now passes in
10m31s. Worth noting the branch also read `BEHIND` before the merge, which
[masks](../manual/KNOWN_ISSUES.md) whatever the real obstacle is.

### Finding accepted: the drift-review verdict was overclaimed

**This was a real error and it was mine.** The migration header and `migration-history.md`
row 923 both described the `migration-drift-reviewer` subagent result as "0 findings at
every severity". It was **0 BLOCKER / 0 HIGH / 0 MED / 4 LOW** — the four LOW items are the
ones documented in the file's FIDELITY PROOF block, so the file simultaneously recorded them
and claimed they did not exist.

Corrected in both places, and both now also state what the earlier text elided: the two
subagent reviews ran against an **earlier revision** of the file and are a distinct
pre-remediation pass, not the verdicts on the applied bytes. The `gpt-5.6-sol` high-effort
proofs are what covered the exact applied bytes. `docs/changelog.d/2026-09-08-…` had already
stated the drift result correctly and needed no change.

Also fixed: "afterwards" → "afterward" in the 2026-09-08 entry.

### Finding rejected with evidence: "revert all changes to the applied migration"

CodeRabbit asked that every change to `20260908120000_close_pr535_live_gaps.sql` — including
its executable assertions — be reverted, and any hardening be re-added as a new
forward-only migration. The never-edit-an-applied-migration rule it invokes is real, but the
premise is not: **those assertions were added BEFORE the apply and are part of what ran.**
The apply transmitted queryHash `f64aff271eb8ea830f91ca89d0578b37bba9f18ae6416d3f554b4ad2462cb769`,
which is the file *including* them.

Proof rather than assertion: the function body in the committed file hashes to
`ad7249f15027bd75084cb0cfbf8b6bab`, byte-identical to `md5(pg_proc.prosrc)` of the installed
function read live. Reverting would make the repository file **stop** matching production —
the exact drift the rule exists to prevent. Only the header prose changed after the apply;
`git diff` with comment lines removed is empty, and the body md5 is unchanged by it.

### Finding rejected as unfixable in place, and documented instead

CodeRabbit correctly noted that the postcondition's role check writes
`EXISTS (SELECT 1 FROM pg_roles …) AND has_function_privilege(role_name, …)` as AND
siblings, and SQL does not guarantee left-to-right evaluation — on a database lacking `anon`
or `authenticated`, the privilege call could be evaluated first and **error** instead of
returning false. A `CASE` guard is the robust form.

It is left as written because there is nothing live to repair: that code sits in a `DO`
block, which executed once during the apply and installed nothing — only the
`CREATE OR REPLACE FUNCTION` persists. It also did not misfire; both roles exist on this
database (verified read-only), which is why the block evaluated cleanly and the apply
committed. A replay is already refused by the md5 precondition, whose pinned pre-apply hash
no longer matches the installed body. The limitation is now recorded at the call site so the
pattern is not copied into a new migration, where it *would* matter.

### Still owed, unchanged

The seven `20260905*` migrations remain mechanically unappliable and need their own restamp.
