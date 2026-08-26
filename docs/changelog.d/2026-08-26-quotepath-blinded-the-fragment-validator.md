## 2026-08-26 — git path-quoting blinded the fragment validator

CodeRabbit found (and reproduced) a fail-open in the ledger guard's CLI: with git's
default `core.quotePath`, a staged non-ASCII fragment name reached the parser as the
quoted-octal literal `"docs/changelog.d/\303\251.md"` — surrounding quotes included — which
no longer starts with the folder prefix, so the malformed-fragment refusal never saw it. A
source-only commit could carry junk into `docs/changelog.d/` unreported, defeating the
folder's core guarantee that anything unreadable is refused by name.

Both `git diff` passes now read NUL-delimited (`-z`), where paths are never quoted, so the
validator always sees real names — immune to the whole quoting class, not just this
spelling. Verified break-first: the new regression test stages a real `é.md` junk fragment
in a fixture repo and ran against the old code first (guard exited 0 — the fail-open,
reproduced), then against the fix (exits 1 and names the file by its real name). The R/C
two-path record shape is consumed defensively in the `-z` parser, preserving the old
last-field behavior in case `--no-renames` is ever dropped.
