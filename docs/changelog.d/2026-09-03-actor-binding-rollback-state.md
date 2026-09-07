## 2026-09-03 — actor-binding guard verifies invoker demotions conservatively

An exact-commit security review of PR #449 found that the write-time migration
guard trusted the lexically last routine security mode. A migration could create
an unsafe `SECURITY DEFINER` routine, demote it inside a savepoint, and then roll
that demotion back. PostgreSQL would commit the unsafe definer routine while the
guard incorrectly returned allow.

### Changed

- Executable `ROLLBACK` and `ABORT` transaction control now make
  `ALTER ... SECURITY INVOKER` unusable as de-escalation evidence.
- An invoker demotion counts only when it is top-level migration DDL; an ALTER
  stored in a routine body for deferred or conditional execution cannot clear
  an earlier definer mode.
- Custom argument types must be schema-qualified before CREATE and ALTER
  signatures can match, preventing search-path-distinct overloads from
  collapsing to one textual identity.
- PL/pgSQL names declared with `ALIAS FOR` are treated as writable spellings of
  the guarded actor parameter, so assigning through an alias invalidates an
  earlier refusal.
- A procedure `CALL` that receives the guarded actor or one of its aliases is
  treated as possible `OUT`/`INOUT` rebinding. Calls with no actor argument
  remain compatible.
- Persistent `cron.job` view aliases are now recovered from earlier migration
  files whose `.sql` extension uses mixed or uppercase characters.
- The reader retains earlier `SECURITY DEFINER` evidence and requires the
  complete authored routine body to pass the actor-binding check.
- Comments and string literals are masked, so rollback words used only as data
  do not create false transaction evidence.
- The existing reviewed file-level exemption remains the escape hatch for a
  safe, unusual transaction flow that this best-effort reader cannot prove.

### Proof

- The savepoint/rollback regression failed against the pre-fix hook: the unsafe
  routine was allowed.
- The repaired focused suite passes 521 assertions, covering
  `ROLLBACK TO SAVEPOINT`, full-transaction `ABORT`, an existing unreadable
  routine elevation, a released-savepoint control, comment/string controls,
  a deferred invoker ALTER, schema-distinct custom-type overloads, and a
  correctly bound definer routine. The added cases cover direct and positional
  actor aliases, direct/positional/named procedure arguments, unrelated-call
  controls, and uppercase historical migration files.
- Mutation proof: forcing rollback detection off makes the original savepoint
  regression fail; restoring it returns the suite to green.
- Separate mutations that trust deferred INVOKER text or unqualified custom
  types make their new regression fail; restoring each guard returns the suite
  to green.
- Each new exact-review regression failed against the prior hook before its
  repair: uppercase history was skipped, alias assignment passed, and an
  actor-bearing `CALL` passed.

### Scope

Mason authorized this bounded repair after the exact-SHA gate reproduced the
bypass. The broader 2026-09-01 best-effort cap remains in force; this change
does not add a transaction parser or resume general regex/dataflow hardening.
