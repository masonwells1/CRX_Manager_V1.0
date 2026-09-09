## 2026-09-09 - the live-data guard recognises the 29 sweep predicates instead of parsing them

**Outcome:** all 29 `db-invariant-sweeps` predicates now clear the live-data
guard. `main` cleared 0. Nothing else about classification changed.

**Why the previous attempt was abandoned.** Every predicate opens with prose like
`-- predicate (f): overloads`, and `findNonReadFunctionCall` read that as a call
to a function named `predicate`, so the guard refused all 29 — the C1 control
had no working execution path anywhere. PR #639 tried to fix this by teaching
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

This can only ever ADD permission for bytes already written and reviewed, so no
other input is classified differently. There is no lexer, and there must never
be one here.

**The control is the fingerprint changing.** Edit a predicate and the guard stops
recognising it until the manifest is regenerated — and that regeneration lands
in the diff, where the changed SQL gets re-reviewed. A test asserts the manifest
lists exactly the files on disk with exactly their current hashes, in both
directions, so it cannot drift silently.

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

**Proof.** `predicate-fingerprints.test.mjs` — 142 assertions, wired into
`npm run test:correction-guards`. Beyond the unit tests, the DEPLOYED hook
process was driven with real `PreToolUse` payloads and `REAL-DATA-OK` absent:
**29 of 29 predicate files clear it** (main: 0 of 29), while all 15 must-deny
shapes are still denied — hand-written DELETE, live invoice total, audit-log
write, TRUNCATE, raw DDL, GRANT, mutating RPC via SELECT, `setval`, unknown app
function, and the comment/literal smuggling shapes from the earlier Codex
rounds.

**Correction to an earlier claim.** The "deployed hook process" line in PR #639's
round-5 and round-6 commit messages was measuring `C:\CRX_Manager`, a different
checkout carrying stale local edits, rather than the branch being committed. The
findings and fixes in those rounds were sound — they were verified by a
differential harness that imports the git blobs directly — but that particular
proof line did not measure what it said it measured. The harness now takes the
checkout as an argument and this entry's numbers were produced against the
branch worktree.

**Still open, unchanged here:** Codex's `production-action-guard.mjs` classifies
`execute_sql` against its own separate allowlist, which this change does not
touch, so the Codex path still clears fewer. Reconciling the two remains a
follow-up.
