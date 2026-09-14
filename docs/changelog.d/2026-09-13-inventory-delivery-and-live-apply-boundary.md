## 2026-09-13 - Separate inventory delivery from its parked SQL apply

Package the verified inventory recovery changes in a new single-commit delivery while preserving the original branches, commits and findings. The initial packaged Git tree exactly matches the tested candidate. Executable source and SQL remain unchanged; the current-state and migration-history handoff now describe repository delivery separately from the unapplied SQL, rather than carrying an unmerged-branch status onto main.

The migration remains parked. A future live apply needs its protected production gate, current preflight and separate authorization. The reviewed browser fix may ship without applying the database change.

Verification: the 185 affected behavior checks remain valid for unchanged executable inputs. Normal commit validation and a fresh independent exact-candidate review are required for the packaged delivery, followed by full remote checks and CodeRabbit.
