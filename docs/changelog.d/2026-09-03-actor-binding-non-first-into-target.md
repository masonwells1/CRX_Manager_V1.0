## 2026-09-03 — actor-binding guard checks every recognized `INTO` target

An exact-commit security review of PR #449 reproduced one remaining bypass in
the write-time migration guard. A refusal could correctly bind
`p_performed_by` to `auth.uid()`, then a query could replace it as the second
assignment target:

```sql
SELECT p_target_id, p_target_id INTO p_target_id, p_performed_by;
```

The guard checked only the first target and allowed the forged attribution.
The same shape could overwrite a trusted local previously initialized from
`auth.uid()`.

### Changed

- The existing `SELECT`, `RETURNING`, `FETCH`, and dynamic `EXECUTE` `INTO`
  readers now split their recognized target lists and inspect every target.
- The check covers guarded actor parameters, positional actor aliases, quoted
  and block-qualified targets already supported by the guard, and trusted
  `auth.uid()` locals. Opaque PostgreSQL Unicode-escaped targets fail closed
  because they can decode to an actor-equivalent identifier.
- A safe control confirms that an actor in the output expression list is not
  rejected when every assignment target is a different variable.
- Ordinary hook fixtures now use an isolated empty migration directory. The
  dedicated cross-migration pg_cron lifecycle fixtures retain their authored
  multi-file histories, while unrelated cases no longer reparse all 900 real
  migrations in each child process.
- `KNOWN_ISSUES.md` now describes the hardened hook's post-merge capabilities
  and keeps the remaining parser, naming, tool-path, and hidden-dataflow gaps
  explicit.

### Scope

Mason authorized this one bounded repair. The actor-binding hook remains a
best-effort speed bump under the 2026-09-01 cap. This does not add general SQL
parsing, widen actor-name discovery, follow cross-routine dataflow, reconstruct
incremental edits, or change the post-apply sweep predicates.

### Proof

- With the repaired target-list logic present, the focused real-hook suite
  passes 501 assertions.
- Mutating the helper back to first-target-only behavior makes the trusted
  local second-target regression fail; restoring the repair returns it green.
- The first exact-commit review found a Unicode-escaped actor-equivalent target;
  the corrected candidate adds first- and non-first-target regressions for that
  valid PostgreSQL spelling.
