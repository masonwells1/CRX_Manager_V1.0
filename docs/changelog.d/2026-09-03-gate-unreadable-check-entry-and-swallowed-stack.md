## 2026-09-03 — the review gate now fails closed on an unreadable check list, and prints the stack

Follow-on hardening for the `check_runs` pagination crash. **PR #573 fixes the cause**
(the paginate mapFn that read `.check_runs` off an already-flattened array); this change
addresses the three things that made that one bug take the whole gate down silently, none
of which are cause-specific.

**Files:** `.github/scripts/coderabbit-final-review.cjs`,
`.github/scripts/coderabbit-final-review.test.cjs`

### 1. An unreadable list entry BLOCKS the candidate — it is never filtered away

`evaluateChecks` now rejects a check-run or commit-status list containing a non-object
entry (or one that is not an array at all) before any loop reads a field off it.

The obvious hardening here is to filter the bad entries out and carry on. That would be a
**fail-open on the paid-review gate**: a dropped row is a row that cannot block, so
silently discarding a malformed check run could let the gate conclude "every required
check is green" while a required check was never seen at all. This is a security property
of the gate, not a tidy-up — a check answering *no information* must never be read as
*no problem*. So the entry becomes a blocker with a readable reason:

```
check-run listing returned 1 unreadable entry
```

The rule lives in exactly one place (`evaluateChecks`, which is exported and directly
unit-tested), not two that can drift.

### 2. The optional chain starts at the ELEMENT

`attachRequiredWorkflowProvenance` filtered on `check.app?.id`. That guards a nullish
`app` on an object that **exists**; it does nothing for an undefined *element*, which
throws before the `?.` is reached. It is now `check?.app?.id`.

This is not redundant with #1: `attachRequiredWorkflowProvenance` runs *before*
`evaluateChecks`, so it is what carries a malformed list far enough to be blocked
legibly instead of the gate dying at that line. Mutation-measured, not assumed —
reverting it to `check.app?.id` turns `an unreadable check-run entry blocks the candidate
instead of crashing the gate` red.

### 3. The stack is logged, and an internal crash says so

The catch handler reported only `error.message`. For this bug that was the entire
diagnostic surface: `Cannot read properties of undefined (reading 'app')` — no file, no
line, and every `.app` in the module is optional-chained, so the guard that was one level
too far right looked innocent. It now emits `error.stack` via `core.error` (a run
annotation) **before** any recovery work, so it survives even if recovery throws, and the
failure message distinguishes an internal gate bug from a blocked candidate.

### On clearing both labels — deliberate, and left alone

Raised as a possible defect: on an internal error the handler wipes both workflow labels,
so a labelled PR ends with no labels and nothing posted. Verified in source rather than
assumed, and it is **correct**. `coderabbit-final-review.cjs:210-213` records why: GitHub
fires no `labeled` event for a label that is already attached, so leaving
`ready-for-coderabbit` on would **wedge** the pull request — an operator could never retry
by re-applying it. Clearing it is what makes the retry possible.

The defect this crash exposed was never the clearing; it was that the run said nothing
useful about *why*. Fixed as legibility (items 2 and 3 above) rather than by preserving a
label that no longer triggers anything. Flagged for Mason rather than quietly changed.

### Proof

- Suite **92 pass / 0 fail** (88 on the #573 base, +4 added here).
- **Mutation-tested, all three, each restored after:**
  - disabling the fail-closed shape check → **3 red**
  - `check?.app?.id` → `check.app?.id` → **1 red**
  - removing the `core.error` stack log → **1 red**
- The paginate normalization itself was independently reproduced against **real Octokit**
  (`@octokit/core` + `@octokit/plugin-paginate-rest`, HTTP layer stubbed with the genuine
  `{ total_count, check_runs }` envelope): the mapFn form yields `[null]` and
  `.filter(c => c.app?.id)` throws `Cannot read properties of undefined (reading 'app')`
  verbatim; dropping the mapFn returns both check runs. That confirms #573's fix
  independently.

### Not verifiable from this PR

`pull_request_target` loads the workflow **and** this script from the default branch, so
neither this change nor #573 can be exercised by its own pull request. Both take effect on
the first ready-label event after merge. The mutation results and the Octokit reproduction
are the substitute.
