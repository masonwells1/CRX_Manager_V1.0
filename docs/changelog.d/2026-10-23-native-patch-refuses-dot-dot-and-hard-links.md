## 2026-10-23 - native patch: refuse `..` segments and hard-linked files

Fourth Luna review round on the native `apply_patch` envelope repair. A patch under
`tool_input.command` is now refused when a path contains a `..` segment (Windows resolves it
lexically but POSIX resolves it after a linked directory, so the same text can name different
files), and when a destination is an existing file with more than one hard link (a hard link is
the same file under a second name that no path walk can see through). The guard suite gained a
real hard-link fixture, `..` cases, and the file-symlink cases now run independently of each other.
