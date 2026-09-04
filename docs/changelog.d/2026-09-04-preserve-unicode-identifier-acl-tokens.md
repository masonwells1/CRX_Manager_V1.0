## 2026-09-04 - Preserve ACL tokens after Unicode SQL identifiers

The SECURITY DEFINER migration-proof lexer now treats non-ASCII identifier characters as routine
identifier content. A dollar sign following a Unicode PostgreSQL identifier can no longer conceal a
later execute grant or revoke.
