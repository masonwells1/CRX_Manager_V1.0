# Handoff — `save_job` server-side chemical-unit invariant + derived money totals

**Date:** 2026-08-23
**Branch:** `claude/save-job-server-side-chem-unit` (worktree `.claude/worktrees/save-job-enforcement`)
**Head:** see `git log -1` — round 8 landed on 2026-08-24; **unpushed**. Tree clean.
**Migration:** `supabase/migrations/20260820120000_save_job_enforce_chem_unit_invariant_and_derive_totals.sql`
**SQL sha256:** `e1cc0fed0e1e1420b163dfe83a612fd7daf45be7e4d31bfb37320242157f6623`
**Status: PARTIAL — written, proven, and parked at three gates that are not mine to open.**

## Approval state — carries nothing forward

- **Nothing has been applied to the live database.** Live is untouched.
- **Nothing has been pushed.** PR #446 is open and still shows only the first commit (`cd625238`); its body describes a two-migration design that no longer exists.
- A live apply, a push, a merge, and any live-data edit each need Mason's explicit OK **in the conversation where they happen**. This document is not that OK.

## What the migration does

Replaces the **body** of `public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text)` — identical signature, `CREATE OR REPLACE`, no new overload, ACL and owner preserved. Five changes:

1. A chemical line whose units provably disagree is refused (`CHEM_UNIT_MISMATCH`), naming the product and both units.
2. A rate measured per something other than acres is refused (`CHEM_RATE_DENOMINATOR_NOT_ACRES`) in the slash, spelled-out and hyphenated forms — **and in stacked forms** such as `oz/cwt/ac`. The test is subtractive: strip one trailing per-acre suffix, then refuse if any denominator survives.
3. A negative, `NaN` or `Infinity` quantity is refused (`CHEM_QUANTITY_NOT_FINITE`) before the unit comparison and regardless of its outcome.
4. `total_cost_cents` / `total_price_cents` are **derived** from `p_chemicals` via `safe_cents_qty` and the caller-supplied totals are ignored — this is what makes a stale tab harmless.
5. A line that actually bills but whose rate unit or stock `unit` is blank is refused (`CHEM_UNIT_UNSPECIFIED`). Three exemptions, all the same rule — a line that cannot bill cannot bill *wrongly*: `customer_supplied`, neither a cost nor a price, and quantity 0.

The live unit helpers (`normalize_rate_unit`, `field_app_priced_quantity`, `safe_cents_qty`) are **reused, not reimplemented** — a second server-side copy of the unit table would repeat the original 16x bug.

## Proof — committed and re-runnable

```bash
node scripts/smoke/prove-save-job-chem-unit-invariant.mjs
```

PostgreSQL 17 in a throwaway container (production is 17.6). Ends in `SAVE_JOB_CHEM_UNIT_PROOF_PASS`: the md5 pin reproduces from migration `20260706080000`; a drifted body is refused with `PREFLIGHT_BODY_DRIFT` and the installed function is left byte-identical; the apply corrects a deliberately bad ACL; a replay reinstalls the identical body; **25 behaviour tests** pass; **14 mutation phases** each fail in a *named* way — 9 turn a named test red, 5 abort the apply with the specific postflight assertion written to catch them.

`scripts/smoke/smoke-save-job-parity.sql` is the registered live chain and is **gated** on whether this migration is installed. The container prover is **manual** — `run-smoke.mjs --all` will not run it.

## Gates 1 and 2, and who opens them (gate 3 is below)

**Gate 1 — ordering: PR #436 must land first.** This is a real behaviour change, not a mirror of a shipped client guard. `main` has no save-blocking unit guard at all; the client half (`chemLineBillingHazard`, `rateDenominatorIsUnrecognized`, `centsTimesQuantity`) exists only on the unmerged PR #436 branch. Apply this first and the next operator to touch an affected job gets a hard save failure with no prior on-screen warning — and because `performSave` re-sends the whole chemical grid, one bad legacy line makes the **entire job** unsaveable. *Mason's call: land #436.*

**Gate 2 — pre-apply data obligation: one live row, correct it first.** Mason chose (2026-08-23) to fix the data before closing the hole, so the guard lands with zero operational impact. Exactly one `job_chemicals` row is in the refused shape: a `pt/ac` rate, blank Unit, both a cost and a price, not customer-supplied — on **JOB-2026-0002** (2026-06-30, status `invoiced`, product "1A TEST PRODUCT - FAKE PRODUCT", quantity 73.31). It is a **test product**, so the fix is nearly free; `isEditable` at `src/pages/JobDetail.tsx:286` is `role === 'admin' || role === 'sales_rep'`, so `invoiced` does not block editing it. *Mason's call: it is a live-data edit.*

Re-run the exact four-term count immediately before applying and require **zero** rows. It is in the migration header and in `docs/manual/KNOWN_ISSUES.md`, character for character in both. Do **not** re-derive it from memory — three earlier versions of that query were wrong, all in the same direction (reporting zero while a live row was still refused).

## Blocked, not forgotten

**Codex credits returned on 2026-08-24 and the gate has now run once — it returned BLOCKERS, and it was right.** `node scripts/write-codex-push-proof.mjs` refused to write a proof and captured the finding to `.claude/session-state/codex-review-latest.txt`; the stacked-denominator bug above came out of that run. It has been fixed and the container proof re-run green, so the proof must be **re-minted against the new HEAD** before any push.

One operational note worth keeping: the plain `codex review --base origin/main` form is a poor fit in this repo. A scope flag cannot carry a prompt, so Codex takes its direction from the repo instruction files — and those describe *how to run a review*, which it followed literally, reading `.claude/skills/codex-review/SKILL.md`, running a full `npm build`, compacting its own context and finally spawning a nested copy of itself. Twelve minutes of credits, no review. **Use the wrapper**, which carries a fixed prompt and produces the gate artifact in one run.

Sequence, in this order:

1. `node scripts/write-codex-push-proof.mjs` — never hand-write the JSON.
2. Push the branch; **rewrite the PR #446 body** (it still describes the withdrawn two-migration design and carries a stale proof transcript).
3. Read CodeRabbit's review on the *head* SHA and fix anything real.
4. Merge only under the standing push policy — which deploys production.

## Gate 3 — OPEN, and it is a scope decision for Mason

The round-8 gate raised a second finding that is **real, verified against live, and not fixed**: `save_job` does not use the repo's own idempotency helper.

What it does instead: an unlocked `SELECT` scoped to `operation = 'save_job'`, then at the end `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`. The live unique constraint is on `idempotency_key` **alone** — `idempotency_keys_idempotency_key_key`, verified read-only 2026-08-24 — not on the pair. So if a key has already been used by a *different* operation: the lookup filters it out and sees nothing, the job is created, the receipt insert is swallowed by the conflict, and a retry with the same key **creates a second job**. Two callers racing on the same key can also both pass the lookup.

Live already carries the fix and other RPCs already use it: `check_idempotency(text, text)` — `SECURITY DEFINER`, `search_path` pinned, md5 `2c93efc82ad63c906eab944e8b70c88e` — takes `pg_advisory_xact_lock` on the key and raises `IDEMPOTENCY_CROSS_OP_KEY_REUSE`. `draw_down_quote` calls it in exactly the shape this body would need:

```sql
IF p_idempotency_key IS NOT NULL THEN
  v_existing := check_idempotency(p_idempotency_key, 'save_job');
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
END IF;
```

No grant change is needed: `check_idempotency` is executable by `postgres` and `service_role` only, and `save_job` is `SECURITY DEFINER` owned by `postgres`, so the inner call runs with the owner's rights.

**Why it is not fixed here.** The current idempotency block is **byte-identical to the live pre-change body** (`20260706080000` lines 87–97 and 297–301), so this migration neither introduces nor worsens the defect. Closing it would change the concurrency behaviour of the most-used job RPC — cross-operation key reuse would start hard-failing — which is a scope and risk call, not a typo fix. The trade-off Mason has to settle: fold it in (one migration, one review, no second body-pin problem) versus a separate follow-up migration (smaller blast radius per change, but two migrations replacing the same function body, which is the non-atomic hazard round 3 already caught).

Recommendation: **fold it in.** A separate migration would face the same gate anyway, and two sequential replacements of one function body is the pattern that has already bitten this work once.

## Apply channel — this one bites

**Supabase MCP `apply_migration` ONLY.** The file is **seven** top-level statements (`DO $preflight$`, `CREATE OR REPLACE`, two `REVOKE`s, a `GRANT`, `DO $postflight$`, `COMMENT ON FUNCTION`). `execute_sql` returns only the last statement, so through that channel the pin, the replacement, the ACL correction and the postflight would all be silently skipped.

## What review actually caught — read before trusting a "clean" round

Eight rounds; **every** round found something real, including the ones that felt finished.

- **NaN acreage bypass (Codex P1).** PostgreSQL orders numeric `NaN` above every value and `NaN = NaN` is true, so `acres > 0` passed, the carried quantity came back `NaN`, and `NaN <= GREATEST(0.0001, NaN)` was true — waving a genuinely mismatched line through. Every operand on that path is now bounded to a finite range.
- **Non-atomic pin.** An earlier design split the body pin into its own migration. Two separately ledgered migrations are not atomic: a committed pin plus a failed replacement leaves the next run free to overwrite an unvalidated body. Folded in-file.
- **A retracted claim survived in three places** — including inside `COMMENT ON FUNCTION`, which installs into `pg_description`. Grep retracted wording *repo-wide*, and remember the PR body is a place it hides.
- **The file asserted an ACL it never established.** It now `REVOKE`s from `PUBLIC` and `anon` and `GRANT`s to `authenticated, service_role` before asserting.
- **A false refusal that blocks the whole job** (round 7, found independently by three reviewers): the zero-quantity skip sat *below* the blank-unit refusal, and that shape is reachable from the ordinary UI via `reconcileChemAutofillUnits`.
- **The mutation phases found a defect no reviewer did** (round 7): the postflight tested `anon` before `PUBLIC`, and a grant to `PUBLIC` reaches every role — so a PUBLIC grant reported itself under the anon message, naming one role while every role was exposed. The broadest grant is now reported first. A mutant that "passes" under the wrong assertion proves nothing; the prover requires the *named* assertion.
- **Stacked denominators bypassed the whole rule** (round 8, the exact-SHA `gpt-5.6-sol` proof gate, and the worst finding of the eight). The rule asked whether the rate unit *ends in* a per-acre suffix, so `oz/cwt/ac` satisfied it — and the unit derivation then took everything before the *first* slash and discarded `cwt`. The line became a plain `oz`, matched a stock unit of `oz`, and **saved**: a per-hundredweight rate billed as per-acre. Reproduced in the container before the fix (`T24`: `refused=f`). The lesson generalises — an *exclusion* list of good spellings is not the same as a *test* that nothing bad survives, and only the subtractive form is safe here.
- **A latent defect in the prover itself**, found in the same pass: mutants were applied with `String.replace(from, to)`, and JavaScript reads `$&`, `` $` ``, `$'` and `$1` in a *string* replacement as substitution patterns. SQL regex literals here end in `$'` routinely, so such a mutant silently spliced the rest of the migration into itself and failed to install with a syntax error far from the edit — which reads as "the mutant is broken", not "the harness is broken". The replacement now goes through a function.

## Known residuals, stated not hidden

- `job_fields.acres_to_treat` still carries no CHECK — a `NaN` acreage can no longer bypass the invariant but can still be stored.
- `save_job` is not the only writer. `_close_quote_as_applied` (`20260703200000`) and the recipe-pricing path (`20260618230000`) both `INSERT INTO job_chemicals` with prices and run none of these checks. "The database is the boundary" is true of the job-save path, **not yet of the table**.
- The page and the server do not agree to the cent until PR #436 lands the exact-cents client math: `main` displays totals via binary-float half-up, the server stores exact decimal half-away-from-zero. The stored value is authoritative and is what the invoice bills.
- `normalize_rate_unit` strips only `\s+per\s+acre$`; this migration's stripper is deliberately **wider**. The divergence runs in the permissive direction and cannot mis-bill (nothing downstream multiplies money by `rate_unit`). Aligning `normalize_rate_unit` and the client `baseUnitOfRate` is the correct follow-up and is deliberately not bundled into a money migration.

## One next step

**Land PR #436.** It is gate 1, it is the only step available before 2026-08-26, and nothing here should reach live before it does.
