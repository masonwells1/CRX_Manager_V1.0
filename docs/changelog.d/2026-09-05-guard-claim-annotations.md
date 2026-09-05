## 2026-09-05 — Annotate 11 unbacked guard safety claims (and back out an unsafe blob re-pin)

`node scripts/guard-claim-audit.mjs` exited 1 on `main` with **24** NEW unannotated absolute safety
claims. The ratchet requires each to carry `@proven-by <test>`, `@speed-bump`, or `@unproven` within
3 lines, so nobody reads a guard as stronger than it is.

The count is HEAD-dependent — quote the SHA with it. It was 23 at `96fa0b424` and 24 at `cc5e94761`.
Most arrived with `0143896fe` (#563), one merged PR's worth of comments the 2026-09-01 baseline
predates, which is why none were owned.

### What this change does

Annotates **11** claims, in the two guard files that are not content-pinned:

| file | claims | annotation |
| --- | --- | --- |
| `.claude/hooks/pr-merge-guard.mjs` | 5 | `@speed-bump` — every one is the advisory fail-open path |
| `.claude/hooks/codex-bot-review-lib.mjs` | 6 | `@speed-bump`, plus `@proven-by` for the deadline-throw |

`--update-baseline` was **not** used. Re-baselining would launder all 24 unproven claims, which is
the exact failure the ratchet exists to prevent. The audit still exits 1 with 13 findings, which is
the honest state. It is a **local advisory, not a gate**: nothing under `.github/workflows/` or
`.husky` runs it, only its own unit test inside `test:correction-guards`.

### What this change deliberately does NOT do, after a review caught me

An earlier revision of this branch also annotated `.codex/hooks/production-action-guard.mjs` (11
claims) and `.claude/hooks/codex-push-lib.mjs` (1). Both files are **blob-pinned** by
`scripts/apply-live-testdata-maintenance-20260812.mjs`, so those comment-only edits changed their
hashes and I re-pinned `EXPECTED_PROTECTED_OUTPUT_BLOBS` to match.

**That was wrong, and the exact-SHA `gpt-5.6-sol` review caught it.** All three files are now
byte-identical to `origin/main` again.

Why it was wrong: the producer only transforms when the on-disk blob matches
`EXPECTED_PROTECTED_INPUT_BLOBS`; when it matches the OUTPUT pin it returns early as "already
protected". `origin/main`'s guard blob **is** the input pin (`a1ba52df7…`), so on `main` the
transform genuinely runs and injects `maintenanceProducerInvocationAllowed` plus its enforcement
check. Re-pinning the OUTPUT to the unhardened candidate made the script report success **without
installing that protection** — a false green on a production guard, bought to make a local advisory
audit look better. Bad trade.

### A correction to a claim this branch previously made

An earlier revision of this file asserted that `.codex/hooks/production-action-guard.test.mjs` fails
on `main`, "proven pre-existing". **That was wrong and is withdrawn.** The test **passes** on `main`
and passes here now (`OK - production action guard checks passed`). It failed only while the bad
re-pin was in place.

The mistake in the reasoning is worth recording, because it looked like proof: I extracted
`maintenanceProducerCommandMentioned` from the **on-disk** guard, compared it to the producer's
version, found them different, and concluded the guard was out of sync. But the test does not assert
anything about the on-disk file — it asserts against the **transform's output**. The on-disk guard is
the transform's *input*, and it is *supposed* to lack those functions. I compared the wrong two
things and got a confident, wrong answer. The "identical at HEAD and in the working tree" check that
seemed to confirm it only confirmed that I was measuring the same wrong thing twice.

### Left for its own PR

- The 11 claims in `.codex/hooks/production-action-guard.mjs` and 1 in
  `.claude/hooks/codex-push-lib.mjs`. Annotating them requires re-running the producer so the
  hardened output is regenerated and pinned only after its test passes — a real change to a live
  security guard, not a comment pass.
- `.claude/hooks/actor-binding-check.mjs:117`. Two open Codex branches edit that file
  (`codex/actor-binding-mixed-notation-repair-20260810`, PR #449, actively committing;
  `codex/harden-actor-binding-sql-reader`). Annotating it would collide.
- The `@unproven` finding that prompted the push-lib annotation still stands and is worth fixing
  there: `codex-push-lib.mjs:2170` says the fail-closed floor lives upstream in `gateRequest()`. That
  is accurate by inspection in both callers, but **no test asserts it** — `pr-merge-guard.test.mjs`'s
  "missing field does not block" case checks only the predicate's own return value and states the
  upstream behaviour in its **label**. A label is not a test: delete or reorder either caller's
  fetch-failure deny and nothing turns red.

### Gates

`test:correction-guards` clean. `.codex/hooks/production-action-guard.test.mjs` passes. Both edited
guards pass `node --check`. Hook-manifest parity passes. Typecheck, lint, the full vitest suite, and
the build all pass.
