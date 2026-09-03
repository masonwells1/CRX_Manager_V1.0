## 2026-09-03 — Windows trailing-period path aliases walked past the protected-file canonicalizer

Codex round 7 on PR #563, High — the exact-SHA `gpt-5.6-sol` proof of the branch after
`main` (#580) was merged in. Follows rounds 2 and 3
(`2026-09-02-canonicalize-protected-paths-before-matching.md`,
`2026-09-02-close-dot-slash-and-drive-relative-guard-aliases.md`).

**Files:** `.codex/hooks/production-action-guard.mjs`, `.codex/hooks/production-action-guard.test.mjs`,
`scripts/apply-live-testdata-maintenance-20260812.mjs` (guard blob re-pin only)

### The hole

The Win32 path normalizer strips trailing periods and spaces from a path segment before the
file system ever sees the name. So on Windows these three spellings all open
`.claude/hooks/codex-bot-review-lib.mjs`:

```
.claude./hooks/codex-bot-review-lib.mjs
.claude/hooks./codex-bot-review-lib.mjs
.claude/hooks/codex-bot-review-lib.mjs.
```

`canonicalizeGuardPath` knew about `.`/`..` segments and drive prefixes and nothing else, so
each of these canonicalized to a string the protected-path matcher did not recognise, and the
guard returned `blocked:false` for `Set-Content` and `echo x >` against a module both merge
guards import at startup. Same blast radius as round 2: every protected entry, not one file.

Confirmed on this machine before changing anything, with `Get-Item` on a harmless docs file:
every trailing-period, multi-period and trailing-space spelling resolved to the real file.
Segments made **only** of periods and spaces (`...`, `.. `, `. .`) did not resolve at all.

### The fix — the shape, not the spelling

Canonicalization now applies Windows' own rule: trailing periods and spaces are stripped from
**every** segment, and a segment left empty by that is dropped. Both choices are deliberately
over-inclusive — Windows trims only one period from an interior segment, and a period-only
segment is not a parent hop on any platform — but a deny-guard that canonicalizes *more* than
the OS can only over-block, never under-block. The exact `.` and `..` spellings are handled
before the strip, so a real parent reference is never eaten; a test pins that.

Codex's three payloads plus the trailing-space and multi-period forms are asserted on `Write`,
`Edit`, `apply_patch` and the shell channel. Four near-miss canaries keep the strip honest: an
*interior* period (`codex-push-lib..mjs`) and a real suffix (`.mjs.bak`, the module's own test
file) are different files and stay editable.

### Mutation check

Reverting the strip to a no-op turns the new block red at its first payload; restoring it
turns the suite green again. Recorded in the PR, not asserted here.

### Not changed

The Claude-side `review-proof-guard.mjs` on `main` canonicalizes `..` detours on its own and
is outside this PR's diff; whether it shares the trailing-period gap is a separate check for a
separate change, and is flagged to Mason in the PR report rather than folded in here.
