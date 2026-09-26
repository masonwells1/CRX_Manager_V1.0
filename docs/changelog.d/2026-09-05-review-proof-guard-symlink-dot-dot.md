## 2026-09-05 - Resolve a read target the way the operating system opens it

The Codex GitHub App reviewed PR #612 at e25605efd and reproduced a bypass of the
native-read exemption: a path that reaches the state directory through a
directory symlink followed by `..` (for example `/tmp/alias/../migration-review-x.json`
with `alias` pointing at `<repo>/.claude/session-state/subdir`) was normalised
lexically by `path.resolve` before `realpathSync.native` ran. The guard examined
`/tmp/migration-review-x.json`, found nothing, classified the read `unresolvable`,
and emitted an empty allow response, while a POSIX open follows the symlink first
and returns the migration proof.

The guard now resolves the string the operating system will open. On POSIX that is
the raw path (joined to the payload `cwd` when relative) with no lexical `..`
collapse, because libc `realpath` applies the same symlink-then-`..` order as
`open()`. On Windows the kernel collapses `..` textually before any reparse point
is consulted, so there the normalised form is the faithful one and is kept. The
normalised form is otherwise used only for the over-inclusive name checks.

The regression case builds a directory symlink into the state directory (one
outside the checkout named absolutely, one under `<repo>/src` named relative to
the checkout root), reads the proof through `alias/..` with the operating system
as the oracle, and requires a deny exactly when that read returns the proof's
bytes. Run inside a Linux container against the committed guard the absolute case
failed with an empty allow response; the working-tree guard passes both. On
Windows the raw string opens nothing and the guard stays quiet, which the same
assertion checks.

CodeRabbit's review of the same head asked for the junction hard-link case to be
gated on its own capability flag: `linkSync` on the junction target now records
`externalHardLinked`, the dependent assertions and the subdirectory-cwd hard-link
payload run only when it is true, and a refusal is logged instead of aborting the
correction-guard chain.
