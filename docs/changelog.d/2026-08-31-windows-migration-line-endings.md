## 2026-08-31 - Make the migration integrity test portable on Windows

Normalized ordinary CRLF checkout line endings before hashing and inspecting the
already-applied allocation migration. The test still requires the migration's
explicit `text eol=lf` Git attribute and still rejects stray carriage returns.

Verified with the focused draw-down quote intent-binding migration test. No
migration SQL, live database state, or production behavior was changed.
