## 2026-10-23 - native patch: refuse padded paths, allow empty files

Sixth Luna review round on the native `apply_patch` envelope repair. The parser trimmed whitespace
off each path before checking it, so `src/notes` followed by a no-break space was checked as
`src/notes` while an applier that keeps the literal name would write a different file. A path with
leading or trailing whitespace of any Unicode kind is now refused instead of trimmed. In the other
direction, a patch that adds an empty file (`*** Add File:` with no `+` lines) is a valid edit and is
allowed. The file-symlink test cases now print a visible note when this account cannot create file
symlinks instead of skipping silently.
