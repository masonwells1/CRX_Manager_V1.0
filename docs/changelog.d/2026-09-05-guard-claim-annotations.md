## 2026-09-05 — Annotate 23 unbacked guard safety claims (audit red on main)

`node scripts/guard-claim-audit.mjs` exited 1 on `main` (`cc5e94761`) with **24** NEW unannotated
absolute safety claims. The ratchet requires every such claim to carry `@proven-by <test>`,
`@speed-bump`, or `@unproven` within 3 lines, so nobody reads a guard as stronger than it is.

The count is HEAD-dependent — quote the SHA whenever citing it. At `96fa0b424` it was 23; the 24th
(`actor-binding-check.mjs`) arrived between there and `cc5e94761`. Most of the batch arrived with
`0143896fe` (#563), one merged PR's worth of comments the 2026-09-01 baseline predates, which is why
none were owned.

### What was annotated

| file | claims | annotation |
| --- | --- | --- |
| `.codex/hooks/production-action-guard.mjs` | 11 | `@proven-by` for the round-12/round-13 fail-closed rules; `@speed-bump` for the advisory Codex-App lookups |
| `.claude/hooks/pr-merge-guard.mjs` | 5 | `@speed-bump` — every one is the advisory fail-open path |
| `.claude/hooks/codex-bot-review-lib.mjs` | 6 | `@speed-bump`, plus `@proven-by` for the deadline-throws behaviour |
| `.claude/hooks/codex-push-lib.mjs` | 1 | `@unproven` — see below |

`--update-baseline` was **not** used. Re-baselining would have laundered all 24 unproven claims,
which is the exact failure the ratchet exists to prevent.

### The one left unannotated, deliberately

`.claude/hooks/actor-binding-check.mjs:117` (`fail-open`) is untouched. Two open Codex branches edit
that file — `codex/actor-binding-mixed-notation-repair-20260810` (PR #449, actively committing) and
`codex/harden-actor-binding-sql-reader`. Annotating it would collide. The audit therefore still exits
1 with exactly one finding, which is the honest state. It is a **local advisory**, not a gate: no
workflow under `.github/workflows/` and no `.husky` hook runs `guard-claim-audit.mjs`; only its own
unit test runs, inside `test:correction-guards`.

### The `@unproven` one is the finding worth reading

`codex-push-lib.mjs:2170` claimed "the fail-closed floor lives upstream instead — `gateRequest()`
denies outright if the PR's JSON cannot be fetched at all, so this predicate is never reached with an
unknown verdict."

That sentence is **accurate by inspection** — `pr-merge-guard.mjs` `gateRequest()` denies in its
catch, and `production-action-guard.mjs` has the matching `baseRefName`/`baseRefOid` denials. But
**no test asserts it.** The nearest, `pr-merge-guard.test.mjs`'s

```
ok(!pullRequestReviewBlocked({}), "missing field does not block — gateRequest already denied an unfetchable PR");
```

checks only the predicate's own return value and states the upstream behaviour in its **label**. A
label is not a test. Delete or reorder either caller's fetch-failure deny and nothing turns red, so
this predicate's safety currently rests on an untested assumption. Annotated `@unproven` rather than
softened, because the sentence is true; what is missing is caller-level coverage.

### Blob re-pin (read this one carefully)

`scripts/apply-live-testdata-maintenance-20260812.mjs` pins the exact git blob of both guard files it
once transformed, and refuses to run against drift. Comment-only edits changed those blobs, so
`EXPECTED_PROTECTED_OUTPUT_BLOBS` was re-pinned:

- `codexGuard` `d96b6353…` → `1abd32b4…`
- `pushLib` `05914254…` → `80800b41…`

Re-pinning on a legitimate guard change is the established pattern — the constant's own comments
record re-pins on 2026-08-14 and twice on 2026-08-19 (PR #423), and the 2026-09-02 changelog entries
for the same guard touch this same trio of files.

What makes it safe here is that **both diffs are comment-only**, verified mechanically rather than by
eye: `git diff -U0 <file>` filtered to lines that are not `//` comments returned **nothing** for both
(`production-action-guard.mjs` 15 insertions / 0 deletions; `codex-push-lib.mjs` 9 / 0). No
executable line, no protection anchor, and no matcher changed. The new hashes were derived
independently in Python (LF-normalise, then `sha1("blob <len>\0" + bytes)`) and reproduced the
`codexGuard` value the script itself reported, which validates the method.

### Pre-existing failure found while doing this — NOT caused by this change

`.codex/hooks/production-action-guard.test.mjs` fails on `main`, before any edit here. After the
re-pin it gets past the blob check and fails on:

```
AssertionError: generated guard embeds the invocation matcher exercised below
```

The guard's embedded copy of `maintenanceProducerCommandMentioned` is an **older, different
implementation** than the producer's current one (233 chars vs 19,246; the guard's begins
`const compact = …`, the producer's `const value = … hasDynamicSyntax`), and
`maintenanceProducerInvocationAllowed` is **absent from the guard entirely**.

Proven pre-existing by extracting both functions from the working tree **and from `HEAD`** and
comparing: byte-identical results at both revisions. Not fixed here — resynchronising a
producer-protection function inside a live security guard is not something to slip into a comment
pass. Tracked for its own PR.

This test is not in `test:correction-guards` and does not run in pre-commit for this worktree, which
is why it has stayed red unnoticed.

### Gates

`test:correction-guards` clean (including `guard-claim-audit`'s own 41 assertions, `pr-merge-guard`
97, `codex-bot-review-lib` 125, `actor-binding-check` 30). All four edited guard files pass
`node --check`. Typecheck, lint, 4,976 tests across 349 files, build, and `agent-health` all green.
