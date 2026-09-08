## 2026-09-05 - Bound the commission payment guard lock wait

- The source-only commission payment business-date migration now stops after 10 seconds if another payment writer prevents it from acquiring its installation lock.
- This keeps a future production apply fail-closed instead of allowing an indefinite wait; the disposable PostgreSQL proof still passes after the change.
- The migration remains unapplied and still requires a separate current-conversation approval plus fresh apply gates.
