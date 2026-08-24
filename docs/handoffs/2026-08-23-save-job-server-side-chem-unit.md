# Handoff — `save_job` server-side chemical-unit invariant + derived money totals

**Date:** 2026-08-23
**Branch:** `claude/save-job-server-side-chem-unit` (worktree `.claude/worktrees/save-job-enforcement`)
**Head:** see `git log -1` — round 13 landed on 2026-08-24 on `claude/save-job-server-side-chem-unit` (PR #446). Tree clean. (Push state is deliberately not recorded here: it is volatile, it was wrong in this header for a full round, and `git status -sb` answers it exactly.)
**Migration:** `supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql`
**SQL sha256:** `8e5f439ed27c675bc711d5737c1b8d52b74ed06f4b27558f177996ee14860a7f`
**Status: PARTIAL — written, proven, and parked at two gates that are not mine to open.**

## Approval state — carries nothing forward

- **Nothing has been applied to the live database.** Live is untouched.
- **Nothing has been pushed.** PR #446 is open and still shows only the first commit (`cd625238`); its body describes a two-migration design that no longer exists.
- A live apply, a push, a merge, and any live-data edit each need Mason's explicit OK **in the conversation where they happen**. This document is not that OK.

## What the migration does

Replaces the **body** of `public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text)` — identical signature, `CREATE OR REPLACE`, no new overload. The **owner** carries through untouched; the **ACL is established and corrected**, not preserved — the file revokes `PUBLIC` and `anon` and grants `authenticated` and `service_role`, which is the point of the round-3 finding that it asserted an ACL it never set. Eight changes:

1. A chemical line whose units provably disagree is refused (`CHEM_UNIT_MISMATCH`), naming the product and both units.
2. A rate measured per something other than acres is refused (`CHEM_RATE_DENOMINATOR_NOT_ACRES`) in the slash, spelled-out and hyphenated forms — **and in stacked forms** such as `oz/cwt/ac`. The test is subtractive: strip one trailing per-acre suffix, then refuse if any denominator survives.
3. A negative, `NaN` or `Infinity` quantity is refused (`CHEM_QUANTITY_NOT_FINITE`) before the unit comparison and regardless of its outcome.
4. `total_cost_cents` / `total_price_cents` are **derived** from `p_chemicals` via `safe_cents_qty` and the caller-supplied totals are ignored — this is what makes a stale tab harmless.
5. A line that actually bills but whose rate unit or stock `unit` is blank is refused (`CHEM_UNIT_UNSPECIFIED`). Three exemptions, all the same rule — a line that cannot bill cannot bill *wrongly*: `customer_supplied`, neither a cost nor a price, and quantity 0.
6. The idempotency lookup routes through a canonical, advisory-locked helper instead of a raw unlocked `SELECT`, closing a pre-existing duplicate-job hole (round 8, below).
8. A **DRY** product measured or priced in fluid ounces on **either side** is refused (`CHEM_UNIT_FORM_MISMATCH`). The alias is right on a liquid product and wrong on a dry one, where `oz` is a weight and `fl oz` a volume (rounds 10 and 12, below).
7. That lookup is `check_idempotency_intent`, so the key is bound to the **calling actor** and to a **sha256 fingerprint of the request** (job id, job payload, fields and chemical lines, each array order-normalised). Reusing a spent key from another actor raises `IDEMPOTENCY_ACTOR_MISMATCH`; reusing it with a *changed* payload raises `IDEMPOTENCY_INTENT_MISMATCH` instead of silently returning the earlier success and saving nothing (round 9, below). An unchanged retry still replays to the same job.

The live unit helpers (`normalize_rate_unit`, `field_app_priced_quantity`, `safe_cents_qty`) are **reused, not reimplemented** — a second server-side copy of the unit table would repeat the original 16x bug.

## Proof — committed and re-runnable

```bash
node scripts/smoke/prove-save-job-chem-unit-invariant.mjs
```

PostgreSQL 17 in a throwaway container (production is 17.6). Ends in `SAVE_JOB_CHEM_UNIT_PROOF_PASS`: the md5 pin reproduces from migration `20260706080000`; a drifted body is refused with `PREFLIGHT_BODY_DRIFT` and the installed function is left byte-identical; the apply corrects a deliberately bad ACL; a replay reinstalls the identical body; **58 behaviour tests** pass; **31 mutation phases** each fail in a *named* way — 25 turn a named test red, 6 abort the apply with the specific preflight/postflight assertion written to catch them.

`scripts/smoke/smoke-save-job-parity.sql` is the registered live chain and is **gated** on whether this migration is installed. The container prover is **manual** — `run-smoke.mjs --all` will not run it.

## The two gates, and who opens them

**Gate 1 — ordering: PR #436 must land first.** This is a real behaviour change, not a mirror of a shipped client guard. `main` has no save-blocking unit guard at all; the client half (`chemLineBillingHazard`, `rateDenominatorIsUnrecognized`, `centsTimesQuantity`) exists only on the unmerged PR #436 branch. Apply this first and the next operator to touch an affected job gets a hard save failure with no prior on-screen warning — and because `performSave` re-sends the whole chemical grid, one bad legacy line makes the **entire job** unsaveable. *Mason's call: land #436.*

**Gate 2 — pre-apply data obligation: DONE 2026-08-24.** One `job_chemicals` row was in the refused shape (**JOB-2026-0002**: `pt/ac` rate, blank Unit, both a cost and a price, not customer-supplied). Mason gave his explicit OK and a separate session made the one-row change — `unit` set to `'Pt'`. Re-verified read-only here: the count returns **zero**, and the job totals did not move (`219930` / `278578` before and after), because the per-unit amounts were already quoted per pint and only the label was missing. Test `T28` replays the corrected row and asserts those same two totals, so **all four live rows are now proved by execution** to save with the correct money, not merely asserted to.

**The check is not retired.** Re-run the exact four-term count immediately before applying and require **zero** rows — zero today is a property of the data on one day, not of the migration, and a legacy import or hand-built call can recreate the shape. It is in the migration header and in `docs/manual/KNOWN_ISSUES.md`, character for character in both. Do **not** re-derive it from memory — three earlier versions of that query were wrong, all in the same direction (reporting zero while a live row was still refused).

## Blocked, not forgotten

**Codex credits returned on 2026-08-24 and the gate has now run once — it returned BLOCKERS, and it was right.** `node scripts/write-codex-push-proof.mjs` refused to write a proof and captured the finding to `.claude/session-state/codex-review-latest.txt`; the stacked-denominator bug above came out of that run. It has been fixed and the container proof re-run green, so the proof must be **re-minted against the new HEAD** before any push.

One operational note worth keeping: the plain `codex review --base origin/main` form is a poor fit in this repo. A scope flag cannot carry a prompt, so Codex takes its direction from the repo instruction files — and those describe *how to run a review*, which it followed literally, reading `.claude/skills/codex-review/SKILL.md`, running a full `npm build`, compacting its own context and finally spawning a nested copy of itself. Twelve minutes of credits, no review. **Use the wrapper**, which carries a fixed prompt and produces the gate artifact in one run.

Sequence, in this order:

1. `node scripts/write-codex-push-proof.mjs` — never hand-write the JSON.
2. Push the branch; **rewrite the PR #446 body** (it still describes the withdrawn two-migration design and carries a stale proof transcript).
3. Read CodeRabbit's review on the *head* SHA and fix anything real.
4. Merge only under the standing push policy — which deploys production.


## Apply channel — this one bites

**Supabase MCP `apply_migration` ONLY.** The file is **seven** top-level statements (`DO $preflight$`, `CREATE OR REPLACE`, two `REVOKE`s, a `GRANT`, `DO $postflight$`, `COMMENT ON FUNCTION`). `execute_sql` returns only the last statement, so through that channel the pin, the replacement, the ACL correction and the postflight would all be silently skipped.

## What review actually caught — read before trusting a "clean" round

Twelve rounds; **every** round found something real, including the ones that felt finished.

- **NaN acreage bypass (Codex P1).** PostgreSQL orders numeric `NaN` above every value and `NaN = NaN` is true, so `acres > 0` passed, the carried quantity came back `NaN`, and `NaN <= GREATEST(0.0001, NaN)` was true — waving a genuinely mismatched line through. Every operand on that path is now bounded to a finite range.
- **Non-atomic pin.** An earlier design split the body pin into its own migration. Two separately ledgered migrations are not atomic: a committed pin plus a failed replacement leaves the next run free to overwrite an unvalidated body. Folded in-file.
- **A retracted claim survived in three places** — including inside `COMMENT ON FUNCTION`, which installs into `pg_description`. Grep retracted wording *repo-wide*, and remember the PR body is a place it hides.
- **The file asserted an ACL it never established.** It now `REVOKE`s from `PUBLIC` and `anon` and `GRANT`s to `authenticated, service_role` before asserting.
- **A false refusal that blocks the whole job** (round 7, found independently by three reviewers): the zero-quantity skip sat *below* the blank-unit refusal, and that shape is reachable from the ordinary UI via `reconcileChemAutofillUnits`.
- **The mutation phases found a defect no reviewer did** (round 7): the postflight tested `anon` before `PUBLIC`, and a grant to `PUBLIC` reaches every role — so a PUBLIC grant reported itself under the anon message, naming one role while every role was exposed. The broadest grant is now reported first. A mutant that "passes" under the wrong assertion proves nothing; the prover requires the *named* assertion.
- **A pre-existing duplicate-job hole, closed on Mason's call** (round 8). `save_job` did its own unlocked idempotency lookup filtered to `operation = 'save_job'`, then recorded with `ON CONFLICT (idempotency_key) DO NOTHING` — while the live uniqueness is on the **key alone** (`idempotency_keys_idempotency_key_key`, verified live 2026-08-24). A key already spent by another operation was therefore invisible to the lookup: the job got created, the receipt was swallowed by the conflict, and the next retry created a **second job** — a duplicate bill. That block was byte-identical to the live pre-change body, so the migration did not cause it; Mason decided on 2026-08-24 to close it here rather than in a follow-up, since a second migration replacing the same body is the non-atomic hazard round 3 already caught. It now calls an advisory-locking helper that raises `IDEMPOTENCY_CROSS_OP_KEY_REUSE`. `T26` pins the refusal *and* that nothing was written; `T27` pins that ordinary same-key replays still return the same job. The preflight also asserts the helper exists — PL/pgSQL resolves that call at run time, so otherwise a database missing it would apply cleanly and fail on the first real save.
- **The key was still unbound to what was actually asked for** (round 9, Mason's scope decision on 2026-08-24). Round 8's `check_idempotency(text, text)` matches on key **and operation only**. So a key spent by an earlier `save_job` and then reused for a *different* job or an *edited* payload returned the earlier success — the operator saw "saved" while the changed quantities, cents or job details went nowhere, and a second person's key could be replayed by anyone. The call now goes to `check_idempotency_intent(text, text, uuid, text)`, already used by nine live money RPCs (the whole return family plus create/post/void commission payment, read read-only from `pg_proc` 2026-08-24), which additionally binds the calling actor and a sha256 fingerprint of the request. Three consequences worth knowing before applying: (a) that helper returns a **wrapper** `{"found": true, "result": ...}`, not the bare result, so the body unwraps it and refuses a malformed receipt rather than returning it; (b) the receipt write now stamps `request_fingerprint` and `request_actor_id`, and raises `IDEMPOTENCY_RECEIPT_MISSING` if that stamp lands on no row; (c) the helper **fails closed** on a receipt carrying neither column — a pre-binding receipt cannot have its intent reconstructed, so it raises `IDEMPOTENCY_INTENT_MISMATCH` rather than replaying. `T29` pins the actor mismatch, `T30` pins A→B→A payload reuse, and the preflight asserts the helper, `extensions.digest` (pgcrypto lives in the `extensions` schema while this body pins `search_path` to `public, pg_temp`, so the call is schema-qualified) and both receipt columns.
- **Stacked denominators bypassed the whole rule** (round 8, the exact-SHA `gpt-5.6-sol` proof gate, and the worst finding of the eight). The rule asked whether the rate unit *ends in* a per-acre suffix, so `oz/cwt/ac` satisfied it — and the unit derivation then took everything before the *first* slash and discarded `cwt`. The line became a plain `oz`, matched a stock unit of `oz`, and **saved**: a per-hundredweight rate billed as per-acre. Reproduced in the container before the fix (`T24`: `refused=f`). The lesson generalises — an *exclusion* list of good spellings is not the same as a *test* that nothing bad survives, and only the subtractive form is safe here.
- **A latent defect in the prover itself**, found in the same pass: mutants were applied with `String.replace(from, to)`, and JavaScript reads `$&`, `` $` ``, `$'` and `$1` in a *string* replacement as substitution patterns. SQL regex literals here end in `$'` routinely, so such a mutant silently spliced the rest of the migration into itself and failed to install with a syntax error far from the edit — which reads as "the mutant is broken", not "the harness is broken". The replacement now goes through a function.

- **Fluid ounces could be billed as dry ounces** (round 10, the proof gate again, and the worst finding since the stacked denominators). `normalize_rate_unit` collapses `fl oz` to `oz` form-blind, and the equality shortcut ran *before* the `product_form` lookup — so a dry product with a `fl oz/ac` rate against an `oz` stock unit compared equal and billed with nothing proven, while `field_app_priced_quantity` refuses that pair as not convertible. The guard was more lenient than the SQL that bills. An earlier round had cleared this same alias — correctly for liquids, and it never checked dry. Fixed by moving the form lookup above the shortcut and adding a narrow `CHEM_UNIT_FORM_MISMATCH`; `T33`/`T34` exist to prove the rule does not over-fire, because the wide form of it would refuse a liquid product priced in pounds and block whole jobs.
- **Two findings from the gate were rejected on evidence** (stale base): it reported this branch rolls back the `codex-review` skill hardening and deletes the draw-tier prover. The proof wrapper diffs a snapshot of `origin/main` against a snapshot of HEAD — a two-dot comparison — so everything `main` gained since the merge base reads as a rollback. `git diff origin/main...HEAD` is **empty** for every file named. Merging current `origin/main` made both disappear. Worth knowing before believing the next "regression" this gate reports.

- **The stacked-denominator rule was reopened** (round 11, the gate again). Round 8 stated the rule as "strip exactly one trailing per-acre suffix, then refuse if any denominator survives" and then implemented **two** unconditional strips. So `oz per acre/ac` — one denominator in each spelling — lost both, came back a bare `oz`, and billed a per-acre-**squared** rate as per-acre. The lesson is narrow and reusable: *remove one and refuse what survives* is not the same rule as *remove every spelling and then look*, and only the first is safe. The second strip is now conditional on the first not firing; `T35`/`T36` pin both spellings. Also fixed from that verdict: the prover force-removed a **fixed-name** Docker container before proving it owned it, which could destroy a developer's unrelated container. Unique name per run plus a `crx.prover` label now.

- **The round-10 fix was a HALF-fix and came back as a fresh HIGH** (round 12). It made the alias form-aware only at the *equality shortcut*, and the path it missed was worse: `field_app_priced_quantity` is called with the **normalised** units, so `fl oz` is already `oz` before the converter sees it — handed the raw spelling its dry branch refuses, handed `oz` it converts **16:1 into pounds**. A dry `fl oz/ac` rate against an `lb` stock unit therefore never touched the shortcut, went through the conversion, and turned a volume into a weight. The rule is now unconditional on dry products. **And a test had to be inverted:** round 10's `T34` *required* the both-sides-`fl oz` dry shape to save, which froze the half-fix in place and would have defended it against the next reviewer. Writing an exemption into a test is how a partial fix becomes permanent.

## Known residuals, stated not hidden

- `job_fields.acres_to_treat` still carries no CHECK — a `NaN` acreage can no longer bypass the invariant but can still be stored.
- `save_job` is not the only writer. `_close_quote_as_applied` (`20260703200000`) and the recipe-pricing path (`20260618230000`) both `INSERT INTO job_chemicals` with prices and run none of these checks. "The database is the boundary" is true of the job-save path, **not yet of the table**.
- The page and the server do not agree to the cent until PR #436 lands the exact-cents client math: `main` displays totals via binary-float half-up, the server stores exact decimal half-away-from-zero. The stored value is authoritative and is what the invoice bills.
- `normalize_rate_unit` strips only `\s+per\s+acre$`; this migration's stripper is deliberately **wider**. The divergence runs in the permissive direction and cannot mis-bill (nothing downstream multiplies money by `rate_unit`). Aligning `normalize_rate_unit` and the client `baseUnitOfRate` is the correct follow-up and is deliberately not bundled into a money migration.

## One next step

**Re-mint the Codex proof against the new HEAD** (`node scripts/write-codex-push-proof.mjs`), then push and rewrite the PR #446 body. Landing PR #436 remains gate 1 for the *apply* and is Mason's call; nothing here should reach live before it does.
