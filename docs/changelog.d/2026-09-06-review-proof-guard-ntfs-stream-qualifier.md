## 2026-09-06 - The review-proof guard's NTFS stream-qualifier case is pinned by test

The Codex GitHub App's pass over PR #612 at b7c4b4b22 suggested that reading
`migration-review-x.json::$DATA` on Windows would open the proof's default data
stream while both `.json` checks fail, because the spelled string ends in the
stream qualifier rather than in `.json`.

The guard already withstands this. It resolves the target with
`realpathSync.native`, which returns the file's final path without any stream
qualifier (`GetFinalPathNameByHandle`), so the resolved string ends in `.json` and
the evidence and proof-name rules fire. Probed on Windows 11 with Node 24: the
native realpath of the `::$DATA` form is the plain `.json` path, while stat and
read of the qualified form succeed against the file.

No guard change. The test now pins the behaviour with the same operating-system
oracle as the symlink-then-`..` cases: for evidence through the junctioned state
directory, evidence by its external name, and a push proof, in both `::$DATA` and
`::$data` spellings, the guard must deny exactly when the operating system opens
the qualified form as the file and stay quiet where that form is an ordinary
absent name (POSIX). On Windows the test additionally asserts the qualified read
returned the proof, so the deny branch is known to have run.
