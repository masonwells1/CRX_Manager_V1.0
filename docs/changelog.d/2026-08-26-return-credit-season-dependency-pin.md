## 2026-08-26 — Return-credit season dependency pinned fail-closed

The return-credit COGS migration now pins `current_season()` before and after its cutover. Exactly
one zero-argument, stable, postgres-owned integer function with the reviewed search path and exact
normalized body must exist. A same-shaped helper that silently changes season semantics therefore
aborts the migration instead of misfiling a return credit.

Fresh read-only production schema restored into disposable PostgreSQL passed all 51 load-bearing
return-credit predicates, rollback smoke, and zero-residue checks with the new dependency pin. The
focused return-credit suite passes. No migration was applied to the live database.
