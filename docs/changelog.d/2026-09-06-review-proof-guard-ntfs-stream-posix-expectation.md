## 2026-09-06 - The NTFS stream-qualifier test expects the guard's fail-closed denial on POSIX

The first cut of the stream-qualifier regression (33994be9e) expected silence on
POSIX for every `::$DATA` name the operating system does not open. The Codex
GitHub App reproduced the failure on Linux: the qualified name is absent there,
but a name that lexically enters `.claude/session-state` fails closed when it does
not resolve (there is nothing to read from a missing file), and a name carrying a
proof basename such as `codex-review-abc.json` is denied before any resolution.
Both are deliberate guard rules, so the Ubuntu correction-guard chain in CI failed
on the test, not on the guard.

The test now expects a denial when the operating system opens the qualified name
as the file, when the name enters the state directory, or when it names a proof;
only an absent name outside the state directory with no proof basename stays
quiet. Run on Windows 11 (Node 24) and inside a Linux container (Node 22) before
the push: both pass, Windows through the opened-file branch and Linux through the
fail-closed and proof-name branches.
