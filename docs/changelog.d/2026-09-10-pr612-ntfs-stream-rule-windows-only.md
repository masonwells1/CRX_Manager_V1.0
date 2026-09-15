## 2026-09-10 - PR #612: apply the NTFS stream rule on Windows only

Commit `3b77cbc67` refused any stream-qualified read path whose base name is JSON-shaped, on every
platform. CI on Linux then failed an existing `review-proof-guard.test.mjs` assertion: a
`x.json::$DATA` name that the operating system does not open, outside the state directory and naming
no proof, must stay allowed. On POSIX a colon is an ordinary filename character, so that path is
simply a differently named — and missing — file; there is no stream to hide anything.

`hasNtfsStreamQualifier` and `withoutNtfsStreamQualifier` in `.claude/hooks/review-proof-guard.mjs`
now apply only when `process.platform === "win32"`, the same way the guard already gates
case-insensitive path comparison. On POSIX the stream rule is inert again, as it was at `855020270`;
the other changes since then (malformed-input refusal, bare-string Read handling, any-depth state
membership, per-reason messages) apply on every platform.
Windows behaviour — where the named-stream read of state-directory JSON was reproduced and closed —
is unchanged.

**Verified on Windows by execution:** the guard's test suite passes, and the side-by-side probe
against `origin/main`'s guard with real named NTFS streams still returns the expected decision in 15
of 15 cases. **Not verified locally:** the POSIX branch, which only CI's Linux runner exercises — its
result on this commit is the check.
