## 2026-09-06 — PR #605 CodeRabbit round: three tests stop calling a dead guard "allowed", and the check-script lists agree across "/"

CodeRabbit review `5124454013` at `c12708faa` returned four findings; a fifth was found by hand while
verifying them. Dispositions were posted in the review threads before any code changed, and the code
matches what was promised there.

### F2, F4, F5 — "silent" is not "allowed" (fixed)

Three guard tests asserted an allow as `stdout === ""` with no exit-status check. A hook that crashes
prints nothing too, so a dead guard satisfied every one of those lines. Same species as the
2026-07-28 incident where 30 Windows guards silently failed open behind a presence test.

- `.claude/hooks/review-proof-guard.test.mjs` (F4): 54 such lines, not the ~20 the review pointed at.
  All now go through one `allowed()` helper that asserts exit 0 **and** empty stdout.
- `.claude/hooks/migration-apply-guard.test.mjs` (F2): the four silent-allow legs (valid proof +
  benign migration, the two replacement-server cases, and the two unrelated-tool cases) assert exit 0.
- `.claude/hooks/protected-surface-parity.test.mjs` (F5, hand-found): the per-pattern `cat` leg
  asserts exit 0 before asserting silence. The three deny legs were already safe.

Proven backwards with a prelude that makes the real hook exit 3 with empty stdout on exactly one
allow-path payload, everything else untouched:

| test | old test | new test |
| --- | --- | --- |
| review-proof-guard (crash on `Write docs/review.md`) | exit 0 — blind | exit 1 |
| migration-apply-guard (crash on `mcp__permission_probe__write_marker`) | exit 0 — blind | exit 1 |
| protected-surface-parity (crash on `cat <sample>`) | exit 0 — blind | exit 1 |

### F3 — widened, not narrowed (Mason's call, 2026-09-06)

The review asked to narrow the shell regex so `scripts/check-*` stops at the first `/`, on the
premise that the settings globs stop there. That premise was measured false: a `*` in a settings
permission glob crosses `/` (five headless probes; the control `scripts/checkfoo/nested.txt`, one
hyphen different, was created silently while `scripts/check-probe/nested.txt` was denied). Narrowing
would have opened a seam where a nested check script stays ask-gated for the editors but becomes
shell-writable.

So the two narrow definitions were widened instead:

- `.claude/hooks/codex-push-lib.mjs` `RISKY_PATH_RES`: `scripts/(check|validate|verify)-[^/]+$` →
  also matches nested paths. **This is the real behaviour change**: `scripts/check-x/y.txt` was not
  risky before and is now. The new test case fails on the old regex.
- `.claude/hooks/review-proof-guard.mjs` path-field regex: made to cross `/` explicitly. Measured
  first: the old `[^/]*` form already denied nested paths as a prefix match (the trailing lookahead
  admits `/`), so this line is an alignment of stated intent, not a behaviour change.

No `.claude/settings.json` change; no new prompts. Nested-path deny cases were added to
`review-proof-guard.test.mjs` (shell and path-field) and `codex-push-lib.test.mjs`, with
near-miss controls (`scripts/checkfoo/…`, `scripts/zzz-probe/…`) that must stay non-risky.

### F1 — deferred to its own PR

`mcp-tool-guard.test.mjs:205`: a mutation deliberately named with a read verb on an unidentified
connector still reaches the permission classifier. `mcp-tool-guard.mjs:121-123` records this as an
accepted residual; closing it changes runtime permission behaviour for every unidentified connector,
which deserves isolated proof it cannot get inside a 42-file PR. Named open item, not work here.

### Also deferred, on the record

The Codex-connector P1 on `.claude/settings.json:307` (legacy `mcp__Claude_Preview__*` spelling still
allowed while `mcp__Claude_Browser__preview_start` is `ask`) is a permission change inherited from
`main` byte-for-byte; it goes to its own PR for Mason's decision. Answered in-thread, left unresolved.
