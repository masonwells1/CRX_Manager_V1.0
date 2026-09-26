## 2026-09-26 - autonomous landing: the landing gate binds the transmitted SQL to the reviewed commit

**Sol HIGH, round 2 on PR #804.** The migration landing gate checked that a same-named migration file
was committed at the approved PR head and unchanged in the worktree, but never compared that committed
file with the SQL actually being transmitted. The apply rule book's source resolver can accept a
same-named file from another checkout, so different SQL could have ridden on the PR's CodeRabbit and
Sol approvals.

`migration-landing-gate-lib.mjs` now takes the sha256 of the transmitted SQL (`migration-apply-lib`
passes its `currentHash`) and refuses unless it equals the sha256 of `git show HEAD:<migration>` with the
same CRLF→LF normalization `scripts/apply-migration-file.mjs` applies. A missing hash fails closed.

Proof: 4 new refusal/normalization cases in `migration-apply-lib.test.mjs` (260 passing); a real run on
the PR branch refused SQL differing from the committed file ("not byte-identical", both hashes shown)
while the committed SQL passed that check and stopped at the next one (CodeRabbit not yet approved).
