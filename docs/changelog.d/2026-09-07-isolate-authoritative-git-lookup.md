## 2026-09-07 - Isolate authoritative Git policy lookup

The migration-proof policy lookup now runs from a newly created non-repository
directory with Git repository discovery blocked. This prevents a repository-local
`url.*.insteadOf` configuration from redirecting the fixed GitHub `main` lookup
to an attacker-controlled remote. A regression test starts in a checkout with a
hostile URL rewrite and verifies that the lookup uses the isolated directory.
