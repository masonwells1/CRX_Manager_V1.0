# Codex adversarial verdict — `claude/dryoz-failclosed-guard` @ `7aa00fd5`

Date: 2026-08-20
Reviewed: `git diff origin/main...7aa00fd5` — the chem-unit fail-closed guard, exact decimal
money, and driver-provenance work.

## Did the gate genuinely run?

Yes, at the pinned model and effort. From the session header of
`.claude/session-state/codex-review-latest.txt` (in this worktree, not the main checkout):

```text
OpenAI Codex v0.148.0-alpha.15
workdir: C:\CRX_Manager\.claude\worktrees\dryoz-failclosed-guard
model: gpt-5.6-sol
provider: openai
approval: never
sandbox: danger-full-access
reasoning effort: high
```

Codex did not take the branch's claims on trust: it independently ran `npm run typecheck`
(passed) and `npx vitest run` over the three touched test files (3 files / 102 tests passed)
before forming a verdict.

### Two deviations from the intended invocation, recorded rather than glossed

1. **The sandbox was `danger-full-access`, not `read-only`.** This is a real deviation from
   the review policy and from what was reported in-session at the time. It was verified
   afterwards that the run left nothing behind: at the moment the fixes were staged, `git
   status` showed only the six files edited by hand, HEAD was still `7aa00fd5`, and there
   were no untracked files. No harm resulted, but the next run must pass `--sandbox
   read-only` explicitly.
2. **A nested `codex review` was spawned mid-run.** The reviewer read this repo's own
   `codex-review` skill document as part of the diff context and then executed its
   instructions, launching a second review inside itself. Harmless to the verdict — the
   findings below are specific and were independently confirmed against source — but it
   wasted a large amount of the run, and it means repo documentation is steering the
   reviewer. Worth prompting around directly in future runs.

An MCP connector also failed to authenticate at startup (`AuthRequired`). It plays no part
in a source review.

## Verdict

Two findings. **Both confirmed against source before acting. Both fixed in `711d9e8a`.**

### P1 — `inferChemDriver` cannot recover provenance (CONFIRMED — my fix was wrong)

> When a user edits `quantity`, `applyChemEdit` back-solves `rate_per_acre`, so the persisted
> values also satisfy `quantity == rate × acres`. This equality therefore cannot distinguish a
> rate-driven row from a quantity-driven row.

**Agree, and this invalidates the F06 fix entirely.** Verified at
`src/lib/chemCalculator.ts:54-59`: editing `quantity` returns
`{ ...row, driver: 'qty', rate_per_acre: fmt4(qty / acres) }`. A hand-entered total therefore
satisfies `quantity == rate × acres` **by construction**, not by coincidence.

The original commit message claimed the collision was "harmless: re-deriving it reproduces
the same number." That holds only at the acreage the row was saved against — and an acreage
change is the whole scenario. At any new acreage the inference rewrites the operator's typed
chemical amount, which is the precise harm the driverless branch of
`recomputeChemRowForAcres` exists to prevent. Under-billing is a money error; silently
changing how much chemical goes on a field is a safety one.

**Action taken:** `inferChemDriver` deleted (not merely unused), with a
do-not-reintroduce note where it stood. Two regression tests pin the safe behaviour: one
proves a hand-entered quantity produces the very equality the heuristic relied on, one proves
a driverless row is untouched at any acreage.

**F06 returns to OPEN.** No client-side heuristic can close it. The driver must be
**persisted on `job_chemicals`**, which needs a migration plus a `save_job` change — not yet
approved, not started.

### P2 — the save gate and the money helper disagreed about what a number is (CONFIRMED)

> For a quantity entered in valid number-input exponent notation such as `1e3`,
> `chemRowDefects` accepts it via `Number(text)` ... but this regex rejects it and returns
> zero.

**Agree, and it is reachable by typing.** `chemRowDefects` gated on
`Number.isFinite(Number(text))`; `Number('1e3')` is a finite `1000`, so it passed.
`centsTimesQuantity` refuses exponent notation and returns `0`. `buildJobChemicalsPayload`
uses `parseFloat`, which accepts it. Net effect: the line saved a quantity of 1000 while
`jobs.total_cost_cents` / `total_price_cents` were written as **0** — a nonzero chemical line
behind a zero total, saved silently.

Not theoretical: the quantity field is `<input type="number">`
(`src/pages/JobDetail.tsx:3760`), and the HTML number input accepts `1e3` as a valid value.

**Action taken:** `money.ts` now exports `isExactDecimalText`, backed by the same
`PLAIN_DECIMAL` constant `centsTimesQuantity` multiplies with, and `chemRowDefects` gates on
it. One grammar, one gate — they cannot drift apart without changing a shared constant.
Fails closed.

**Mutation-pinned:** restoring the loose `Number.isFinite` gate makes the new exponent page
test fail on the real page with `save_job` never called. Restored after.

## Proof

`npm run typecheck`, `npm run lint`, `npm run build`, and the full suite — **336 files /
4,652 tests passed**, 123 skipped — all green on `711d9e8a`.

**Not verified in a browser.** Both fixes are proven by mounting the real `JobDetail`
component and driving it through real events, and the mutation test proves those assertions
are load-bearing. This was not opened in a live browser against real data.

## State

Nothing is pushed. `claude/dryoz-failclosed-guard` is 6 commits ahead of `origin/main`.

Landing this still requires, in order: a HEAD-bound push proof from
`scripts/write-codex-push-proof.mjs` (the readable transcript above does not satisfy the push
guard), push the branch, open a PR, Vercel check green, read and resolve CodeRabbit, merge.
The merge deploys production, so it needs Mason's explicit approval.

## PR #436 review round (CodeRabbit + Codex connector)

Both bots reviewed `b55ad40d`. CodeRabbit's review is genuine — bound to that SHA, Pro Plus
plan, not rate-limited. Five findings; all five confirmed against source.

Fixed in the follow-up commit:

1. **Fractional cents were accepted and silently truncated.** `isExactDecimalText('150.7')` is
   true, but both the saved total and `buildJobChemicalsPayload` use `parseInt`, so `150.7`
   became `150` with no warning — the operator's number changing under them, visible only
   after a reload. Cents are whole, so the gate now requires an integer for `cost` and `price`
   while still allowing a decimal quantity.
2. **A test could have passed for the wrong reason.** The exponent test clicked
   `saveButtons[0]`; "Save as Recipe" also leaves `save_job` uncalled, so an index-based click
   proved nothing if the match order shifted. Now selects the job Save explicitly, matching
   the sibling tests. (Not a false pass today — the mutation test shows the click does reach
   the real save — but fragile.)
3. **MD040** — the session-header fence had no language. Cosmetic; fixed.

**Two P1s accepted as real, and NOT fixed here — both need a migration:**

4. **The unit-mismatch guard is client-side only.** It lives in `JobDetail`, so an already-open
   tab on the previous bundle, or any other authenticated `save_job` caller, can still submit a
   `Dry oz` quantity priced per pound. `save_job` inserts `p_chemicals` without comparing `unit`
   against `rate_unit` (`20260706080000_customer_supplied_chemicals.sql:264-293`), and
   `transfer_job_to_invoice` then multiplies the stored quantity by the per-unit price directly
   — so the 16× error remains reachable around the UI. This is squarely the AGENTS.md rule that
   inventory and financial invariants belong in RPCs/triggers, not only in React.

   **The PR description originally called this guard "fail-closed" without qualification. That
   overstates it** — it is fail-closed *in the UI*. Corrected on the PR.

5. **`save_job` accepts caller-supplied job totals verbatim**
   (`20260706080000_customer_supplied_chemicals.sql:138-140,187-189`). Making the React
   calculation exact does not make it authoritative: a stale client can still store 14¢ where
   `transfer_job_to_invoice` computes 15¢ via `safe_cents_qty`
   (`20260713060000_harden_field_split_sum100.sql:544-552`), leaving an invoice header
   inconsistent with its own items. The totals should be recomputed or validated server-side.

Both are the same shape as F06: the durable fix is in the database, needs a migration plus the
Codex SQL gate, and is not in this PR. This PR still strictly improves on `main` — it closes
the UI path that produces the bad data — but it is not a complete fix, and the record should
not pretend otherwise.

### Second round on `48b31982` — one new finding, partly taken

CodeRabbit confirmed all three fixes above as addressed and closed those threads. It raised one
more: **cents beyond 2^53**. `Number('9007199254740993')` has already rounded to `…992` by the
time it returns, yet still reports as an integer — so the gate would admit a value that lost
precision before any arithmetic ran.

**Taken, in the cheap form.** The gate now uses `Number.isSafeInteger`, which refuses the whole
unsafe range. One line, fails closed, covered by a test asserting the two checks disagree on
exactly that value.

**Declined, with reason: the full `bigint`-through-the-totals refactor it also asked for.**
`centsTimesQuantity` already does the multiply in `BigInt` and is exact; the only `Number` in
the path is the cents operand and the accumulator, and with the gate above every operand is now
exactly representable. A total would have to exceed ~$90 trillion before the accumulator lost a
cent. Converting the totals path and the RPC boundary to `bigint` is a real improvement but a
heavy lift that would roughly double this PR's blast radius on a money path, which is the
opposite of what a focused fix should do. Recorded as a follow-up instead of half-done.

## Push-proof gate, round 2 — BLOCKED, and it was right

The first proof attempt (`fb17a7a0`) returned BLOCKED with three High findings, but **two of
them were phantoms from a stale base**: PR #431 (draw-down) had merged to `main` while this
branch worked, leaving it 9 commits behind. The gate diffed the candidate against the *new*
main, so #431's own migrations read as though this branch had reverted them. Verified before
believing it — this PR's diff touches **zero** files under `supabase/` or `scripts/`. Fixed by
merging `origin/main` (clean, no conflicts), not by arguing with the reviewer. This is the
[[project_review-regression-may-be-stale-base]] failure mode exactly.

The second attempt (`a62d5e40`, base `15e41d09`, eight manifest-differing paths) is the honest
one. Still BLOCKED, and the lead finding is a genuine hole in this branch's own guard:

### The guard had two everyday bypasses

1. **The error message taught one.** The banner ended "…or change the rate unit to
   `{priceUnit}/ac`." Following that advice on the live shape turns `Dry oz/ac` into `Lb/ac`,
   which makes the two units match, which silences the guard — while `rate` and `quantity` are
   untouched. The row then saves as 32 lb/ac billing 3,200 lb: **the identical 16× error, now
   silent instead of blocked.** The guard's own remediation text converted a loud failure into
   a hidden one.

2. **An acreage change switched it off.** `chemLineBillingHazard` returned NO_HAZARD whenever
   the quantity matched neither `rate × acres` nor the carried value — "unprovable, do not
   block". But a reloaded row deliberately keeps its saved quantity when the acreage moves
   (the P1 revert above), so the quantity stops equalling `rate × acres` and the warning
   vanished — on precisely the mislabelled row it exists to catch.

Each decision was defensible alone. Together they left the guard defeatable by ordinary work.

**Fixed.** The units disagreeing is now itself the hazard; the only exit is a positive proof of
safety (the quantity equals `rate × acres` carried into the price's unit). `billedRatio` is
derived from the **quantity** rather than from `rate × acres`, so it stays truthful on a stale
row — the acreage-change case now reports 16× correctly. The banner keeps the safe remedy and
states plainly that relabelling the unit alone does not change the amount.

The deliberate cost: a hand-entered quantity in a third unit is now flagged, and a row missing
its rate or acreage stays flagged rather than escaping. Both are clearable by making the units
agree. A guard that switches itself off during normal use is worse than one that occasionally
asks a question.

**Two existing tests asserted the old permissive behaviour — those assertions *were* the
bypass, and they are inverted.** Mutation-pinned: restoring the old bail-out turns both
regressions red.

## Push-proof gate, round 3 — BLOCKED, and it caught a half-done fix

`752a8124`. Two findings. One was mine to fix and I had already half-fixed it.

**The relabel-only remedy lived in TWO places, and round 2 corrected only one.** The on-row
banner was fixed; the **save-time toast** still ended "…or change the rate unit to
`{priceUnit}/ac`." So the operator got the safe wording on the row and the dangerous wording at
the exact moment they were blocked from saving. Fixing one phrasing of an instruction is not
fixing the instruction — the sweep should have been for the *concept*, across every string that
carries it. `grep` for the advice now returns exactly two sites and both are correct.

Fixed, and pinned by a mounted regression that asserts **both** surfaces carry the "re-enter the
rate" instruction and neither ends with a bare relabel remedy. Mutation-pinned: stripping the
warning from the toast turns it red.

**The second finding is the database one, unchanged** — `save_job` still accepts caller-supplied
quantity, units and prices without validating their relationship. Nothing in this branch touches
it, so the gate will keep returning BLOCKED until a migration does. A fourth proof was **not**
minted: the outcome is known, and spending ~20 minutes and a review quota to be told something
already understood is waste, not diligence.

## Still open

- **Server-side enforcement of the unit invariant, and server-side job totals** — findings 4
  and 5 above. Migration work.
- **Carry job totals as `bigint` end to end**, rather than `Number` with a safe-integer gate.
  Correct as stated; deferred as scope. See the second-round note above.
- **F06** — a reloaded rate line goes stale on an acreage change. Needs the driver persisted
  on `job_chemicals` (migration + `save_job`).
- **F07 / F08** — stale rate on a quantity-driven `rate_unit` edit; a cross-product
  replacement carrying the previous chemical's dose. Real on `main`; edit-path behaviour
  changes that want their own review.
- **F15 / F16** — `recipeHelpers` invents `unit: row.unit || 'gal'`; recipe cost paired with a
  possibly-different unit. Real on `main`.
- **F01–F04, F13, F14, F18–F24** — belong to the parked redesign branch
  (`claude/zealous-agnesi-aa7423`).
