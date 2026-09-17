## 2026-09-09 - the live-data guard recognises the 29 sweep predicates instead of parsing them

**Outcome:** all 29 `db-invariant-sweeps` predicates now clear the live-data
guard. `main` cleared 0. Nothing else about classification changed.

**Why the previous attempt was abandoned.** 19 of the 29 predicates open with
prose like `-- predicate (f): overloads`, and `findNonReadFunctionCall` read
that as a call to a function named `predicate`; the other 10 open with a `-- ===`
banner and are refused for the same reason a line further down. All 29 were
refused, so the C1 control had no path through `execute_sql` at all.
(`run-sweeps.mjs` does have a direct `psql` path, which needs `SUPABASE_DB_URL`
and a local `psql` — so "no working execution path anywhere", as this entry
first said, was wrong: the blocked path was the MCP/guard one.)

PR #639 tried to fix this by teaching
the guard to lex SQL: comments, string literals, dollar-quoting, escape strings,
schema qualification. Six pinned `gpt-5.6-sol` rounds each found real defects,
and rounds 4, 5 and 6 each found defects introduced by the previous round's fix.
At its final head that branch **refused four kinds of legitimate SQL that `main`
accepts** (`UPDATE customers SET name='[E2E] INSERT INTO customers'`,
`SELECT '"!"('`, `SELECT 'é('`, `SELECT * FROM t AS "!"(x)`), still allowed two
marker-ordering false exemptions, and was still quadratic. Mason closed it
unmerged on 2026-09-09.

The reason it could not converge: a PreToolUse hook cannot see
`standard_conforming_strings`, cannot resolve a `search_path`, and cannot know
which schema a bare name binds to. The reviewer had a real PostgreSQL 17 to test
against; the hook had guesses, and the guesses were the bugs.

**What changed instead.** These 29 predicates are not unknown input — they are
fixed, reviewed text in this repository. So the guard **recognises** them rather
than understanding them:

- `scripts/db-invariant-sweeps/predicate-fingerprints.json` — a checked-in
  manifest of the sha256 of each predicate file.
- `write-predicate-fingerprints.mjs` regenerates it.
- `classifySql` returns `{ block: false, kind: "known-sweep-predicate" }` on an
  exact match, and otherwise runs completely unchanged.

This can only ever ADD permission for bytes already written and reviewed, so
**no non-matching input is classified differently**. There is no lexer, and
there must never be one here.

Stated precisely, because the looser phrasings are wrong: the match is on the
sha256 of the file's bytes *after* the normalisation below, so the accepted set
is each predicate plus its line-ending, BOM and trailing-whitespace variants —
not literally "the 29 exact texts". Codex confirmed over 1,000,000 generated
inputs that whenever the fingerprint does NOT match, this branch and `main`
return identical verdicts.

**The control is the fingerprint changing.** Edit a predicate and the guard stops
recognising it until the manifest is regenerated — and that regeneration lands
in the diff, where the changed SQL gets re-reviewed. A test asserts the manifest
lists exactly the files on disk with exactly their current hashes, in both
directions.

Two things that control does NOT catch, stated so nobody relies on it for them:
a coordinated edit that changes a predicate *and* regenerates the manifest
passes the test — reviewing that combined diff is the real gate — and a
normalisation-equivalent edit changes no hash by design. A third gap was closed
after review: the count assertion was a floor (`>= 29`), which would have let a
reviewed predicate be deleted from both the directory and the manifest once the
suite grew past it. It is pinned at exactly 29 now.

**Normalisation is deliberately almost nothing:** a UTF-8 BOM, line endings, and
trailing whitespace at end of file — the three things a checkout can change
without changing a single SQL character. Not case, not internal whitespace, not
comments. Anything more would be a parser again, and would let two different
statements collapse onto one fingerprint. Asserted in both directions.

**A keyword shape check was tried here and removed.** The idea was belt and
braces: refuse to fingerprint a file containing `INSERT INTO`, `TRUNCATE `,
`REVOKE `, `CREATE TRIGGER`. Run against the real files it rejected **11 of the
29, every one a false positive** — these predicates inspect privileges, so they
legitimately say `TRUNCATE` inside a `has_table_privilege(...)` literal and
discuss `REVOKE` in their header comments. Making it pass would mean skipping
comments and string literals, which is the SQL lexer that just failed six review
rounds. A check that can only be satisfied by rebuilding the component we
deleted is worse than no check: it applies pressure to weaken itself until it
goes quiet. The reasoning is recorded in the generator so the idea is not
re-attempted from scratch.

**A quadratic defect was introduced here and fixed.** The trailing-whitespace
trim was `/\s+$/`, which backtracks — and since EVERY input now passes through
the normaliser on its way to the classifier, a long run of leading whitespace
became a denial of service on the hook itself: 80,000 spaces cost 1.06 s,
quadrupling per doubling. `trimEnd()` strips the identical character set
natively in linear time; the same input is now under a millisecond. A test
asserts the shape (quadrupling the input must not quadruple the time) rather
than a wall-clock number.

The generator no longer restates the normalisation either — it imports the
guard's. Two copies drifting would mean the manifest recorded different bytes
than the guard computes, which is the one failure this design cannot detect from
the inside.

**Proof.** `predicate-fingerprints.test.mjs` — 154 assertions, wired into
`npm run test:correction-guards`. Beyond the unit tests, the DEPLOYED hook
process was driven with real `PreToolUse` payloads and `REAL-DATA-OK` absent:
**29 of 29 predicate files clear it** (main: 0 of 29), while all 15 must-deny
shapes are still denied — hand-written DELETE, live invoice total, audit-log
write, TRUNCATE, raw DDL, GRANT, mutating RPC via SELECT, `setval`, unknown app
function, and the comment/literal smuggling shapes from the earlier Codex
rounds. Codex reproduced those same 29/29 and 15/15 numbers independently, and
separately read all 29 predicates and confirmed each is a single top-level
`SELECT`/`WITH ... SELECT` with no executable write, no `SELECT INTO`, and no
data-changing CTE — the one question a fingerprint cannot answer about itself.

**Correction to an earlier claim.** The "deployed hook process" line in PR #639's
round-5 and round-6 commit messages was measuring `C:\CRX_Manager`, a different
checkout carrying stale local edits, rather than the branch being committed. The
findings and fixes in those rounds were sound — they were verified by a
differential harness that imports the git blobs directly — but that particular
proof line did not measure what it said it measured. The harness is a local
scratch tool and is not checked in; it takes the checkout path as its first
argument, and this entry's numbers were produced by pointing it at the branch
worktree and confirmed independently by Codex.

**Still open, unchanged here:** Codex's `production-action-guard.mjs` classifies
`execute_sql` against its own separate allowlist, which this change does not
touch, so the Codex path still clears fewer. Reconciling the two remains a
follow-up.
