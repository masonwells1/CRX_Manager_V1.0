## 2026-08-31 — CodeRabbit round on the provenance gate: identity, not just content

Fourth round on the migration source-provenance gate, and the first from CodeRabbit rather
than Codex. All three findings were verified against current code before acting — CodeRabbit's
own preamble says to treat findings as untrusted and check them — and all three were real.

**1. The file you pass must be the file that was approved.**

`scripts/apply-migration-file.mjs` takes a path, derives the ledger name from its basename, and
asks `resolveMigrationSource()` whether the repository holds that content under that name. An
out-of-tree copy with **identical bytes** therefore passed: `/tmp/<name>.sql` matched the
repository file, and the apply proceeded.

**Stated honestly: this was hardening, not a demonstrated bypass.** The rule is content-bound,
so a copy whose content *differs* was already refused, and the bytes that would have run were
identical either way. It is closed regardless, because accepting any path on disk makes
"apply THIS file" and "apply the reviewed migration" two different statements that merely
happen to coincide — and a rule whose safety rests on a coincidence is exactly the kind this
file keeps having to re-close. The script now requires the real path of the argument to equal
the real path of the approved file, using the resolver's own returned path so there is still
one implementation.

Regression test added, with its load-bearing mirror: the identical-content copy is refused, and
the repository file itself still reaches and passes the gate.

**2. A test name described the wrong thing.** An assertion on the `content-differs` branch was
labelled "distinguishes a name that exists from one that does not". A test whose name misstates
what it checks is a small lie that survives every future reading of the suite. Relabelled.

**3. Two changelog entries described the superseded rule.** Both still called the containment
logic "`realpathSync` on both the directory and the file" — which was the *first*
implementation and precisely the bypass Codex found in the previous round. Corrected in place,
with an explicit superseded-description note rather than a silent edit, and pointed at the
entry that describes the shipped root-anchored rule. This is the documented hazard of a
multi-round PR: the prose written in round one keeps describing code that round three replaced.

**Proof observed.**

- `migration-apply-lib.test.mjs` 166 → **171**; `migration-apply-guard.test.mjs` 107;
  `guards.test.mjs` 168 — all green.
- Real path, read-only: a pending return-credit migration still passes provenance and advances
  to the ordering gate; a parked wave-A migration is still refused by name.

**Not verified.** The file-level symlink case still skips on this machine (Windows elevation);
only the directory-junction path executes here. The new head SHA invalidates the `4bce5d6b6`
Codex proof, so a fresh exact-SHA review runs before merge.
