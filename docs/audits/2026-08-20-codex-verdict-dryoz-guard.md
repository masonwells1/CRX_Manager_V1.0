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

## Still open

- **Server-side enforcement of the unit invariant, and server-side job totals** — findings 4
  and 5 above. Migration work.
- **F06** — a reloaded rate line goes stale on an acreage change. Needs the driver persisted
  on `job_chemicals` (migration + `save_job`).
- **F07 / F08** — stale rate on a quantity-driven `rate_unit` edit; a cross-product
  replacement carrying the previous chemical's dose. Real on `main`; edit-path behaviour
  changes that want their own review.
- **F15 / F16** — `recipeHelpers` invents `unit: row.unit || 'gal'`; recipe cost paired with a
  possibly-different unit. Real on `main`.
- **F01–F04, F13, F14, F18–F24** — belong to the parked redesign branch
  (`claude/zealous-agnesi-aa7423`).
