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
- The reader retains earlier `SECURITY DEFINER` evidence and requires the
  complete authored routine body to pass the actor-binding check.
- Comments and string literals are masked, so rollback words used only as data
  do not create false transaction evidence.
- The existing reviewed file-level exemption remains the escape hatch for a
  safe, unusual transaction flow that this best-effort reader cannot prove.

### Proof

- The savepoint/rollback regression failed against the pre-fix hook: the unsafe
  routine was allowed.
- The repaired focused suite passes 512 assertions, covering
  `ROLLBACK TO SAVEPOINT`, full-transaction `ABORT`, an existing unreadable
  routine elevation, a released-savepoint control, comment/string controls,
  a deferred invoker ALTER, schema-distinct custom-type overloads, and a
  correctly bound definer routine.
- Mutation proof: forcing rollback detection off makes the original savepoint
  regression fail; restoring it returns the suite to green.
- Separate mutations that trust deferred INVOKER text or unqualified custom
  types make their new regression fail; restoring each guard returns the suite
  to green.

### Scope

Mason authorized this bounded repair after the exact-SHA gate reproduced the
bypass. The broader 2026-09-01 best-effort cap remains in force; this change
does not add a transaction parser or resume general regex/dataflow hardening.
