# Decision Log

Last verified: 2026-08-09
Update triggers: append when an architectural/policy/business decision is made or reversed.

An ADR-style ("Architecture Decision Record") running log so future agents don't re-litigate
settled calls. Newest first. Each entry is a decision, why it was made, and the operative
rule it implies. This is a log of outcomes, not a design doc — see the cited source for detail.

---

## 2026-08-10 — Data migrations bind approval to a digest, not to row counts

**Source:** Codex exact-SHA review of PR #364, 2026-08-10 (`CODEX_PROOF_VERDICT: BLOCKERS`, finding 1).

**Background.** `20260810022500_backfill_stale_line_profit.sql` gates its write on three
cardinalities — 37 rows, 17 orders, 11 fractional-price rows — and only then captures the ids it
writes. Codex' objection is that cardinalities are not identity: a different population that happens
to have the same three counts would satisfy the guard, and the migration would rewrite rows nobody
approved.

**Decision.** The objection is accepted as a **forward-looking rule** and is *not* retrofitted to
that migration, which was already applied live (ledger version `20260810025159`). Editing an applied
migration is forbidden by `AGENTS.md`, and Codex' own remediation text says the same: if it has
already applied, do not edit it, reconcile forward. The concrete risk cannot now materialise on that
file either — it early-returns on zero stale rows, and the count guard raises `APPROVED_SET_DRIFTED`
rather than writing, so a re-run fails closed instead of touching an unapproved population.

**Operative rule.** Any future migration that rewrites existing business rows must bind its approval
to a **digest of the sorted approved record ids plus the material before-values** (for money, the
stored cents), asserted before the write. Row counts, order counts and similar cardinalities may
accompany that digest but may never be the only thing standing between an approval and a write.

**Enforcement (hard, not prose).** `scripts/validate-sql-migrations.sh` now fails any migration
stamped `20260811000000` or later that contains a top-level `UPDATE`/`DELETE` against a business-row
table unless the file either (a) carries `-- APPROVED_SET_DIGEST: <64 hex>` *and* asserts that same
hex in executable SQL before the write, or (b) explicitly waives it with
`-- APPROVED_SET_DIGEST: NOT-REQUIRED - <reason>` for the case where there is no before-value to
protect (backfilling a column the same migration just added). Rewrites inside a function body are
runtime logic and are not checked. The gate is scoped by **date, not an allowlist**, so it needs no
maintenance and leaves zero headroom for the next migration written; every migration before the
cutoff is history, including the already-applied `20260810025159_backfill_stale_line_profit.sql`,
which `AGENTS.md` forbids editing. This is the deterministic replay/baseline guard Codex asked for
in place of editing applied SQL.

**Hardened after review (same day).** The first cut of that guard did not enforce what it claimed,
and a round-3 Codex review (`CRX-GUARD-001`) was right to say so. Three bypasses, all now closed:

1. **Detection was line-anchored.** SQL is free-form, so `UPDATE`, the optional `ONLY`, and the table
   name can each sit on a different line, and the table can be quoted (`"public"."orders"`). Any of
   those walked straight past the check. Detection is now **token-based** over the flattened
   non-function-body text, with quoted identifiers and string literals stripped first — so prose
   inside a `RAISE NOTICE` cannot fabricate a match either.
2. **The digest was decorative.** It passed by appearing anywhere in executable SQL. Four things are
   now required together, and the failure message names which one is missing: the digest must be
   **compared** (a comparison operator on that line — mentioning or `SELECT … INTO` is not a check);
   the value it is compared against must be **computed** (a hash call over the approved set before
   the write, so it is not one literal compared to another); the comparison must sit **before the
   first write**; and a `RAISE EXCEPTION` must sit **inside that comparison's own `IF` block**, so a
   drifted set aborts. A `RAISE` that merely happens to be nearby, in an unrelated or unreachable
   branch, no longer counts.
3. **The opt-out was a silent blanket pass.** It must now **name every business table it waives**,
   and it emits a `WARNING` — a waived money rewrite belongs in the CI log where a reviewer sees it,
   not passing quietly.

The protected-table list was also too narrow: it covered the ordering and invoicing tables but not
`inventory`, `vendor_bills`, `vendor_payments`, `cost_history`, `prepay_credits`, and the rest of the
financial state. It now covers all of them.

**The guard has committed tests.** `scripts/validate-sql-migrations-approved-set.test.mjs` writes 18
synthetic migrations — twelve real bypass attempts, one waiver, and five shapes that must stay
silent — runs the actual script over them, and asserts what it printed for each. It runs in
`npm run test:correction-guards`. The test was itself verified by breaking the guard on purpose and
watching eight cases go red, then restoring it and watching them go green. Per the standing rule that
an untested guard is decoration, that red-then-green run is the evidence, not a reading of the diff.

**Also settled here.** The permission entry `Read(//c/CRX_Manager/**)` was removed from the tracked
`.claude/settings.local.json` (Codex finding 2). It had been added by an auto-approved prompt during
the backfill work. Because it is recursive, standing, and *tracked*, it silently granted every future
session in this repository read access to `C:\CRX_Manager\.env` — a real file holding live keys —
without an approval prompt. Rule: never commit a recursive `Read()` grant rooted above the checkout;
scope permission grants to tracked source paths.

---

## 2026-08-09 — Stale line-level profit is repaired to match the canonical rule

**Source:** Mason in chat, 2026-08-09. Migration `20260810022500_backfill_stale_line_profit.sql`.

**Background.** `order_items.profit` is a DERIVED field: the BEFORE trigger
`_round_money_to_whole_cents` discards whatever a caller passes and computes it from the row's own
rounded price and cost, and `trg_recalc_order_totals` sums the same two rounded quantities into the
order header. That rule went live 2026-08-09 but did not touch rows written before it existed.

**The decision.** Mason asked to "recompute the stale line level profit," and — shown the per-row
figures — chose to **include all 37 stale rows** rather than exclude the 11 whose price carries a
sub-cent fraction. Those 11 prices therefore also round to whole cents (well under a cent in total),
and eleven order headers are restated downward by up to a cent each. Sales Reports read the line
copy, so this is a **reporting correction**; no amount owed changes, because accounts receivable is
carried on `invoices.balance_cents`, which nothing in this path writes.

**Operative rules this implies.**

1. **The trigger is the single definition of a line profit.** The backfill re-saves stale rows so the
   trigger re-derives them; it does not recompute profit in the migration. Do not fork the formula
   into a second place.
2. **The approved set is 37 rows / 17 orders / 11 fractional-price.** The migration hard-codes those
   counts and aborts with `APPROVED_SET_DRIFTED` if live disagrees. That is deliberate — the counts
   bind the write to what Mason actually approved, and an abort on a clone, staging copy or restored
   backup is correct behavior, not a bug.
3. **Deliberately out of scope, and still open:** the other sub-cent-price rows whose profit is
   already correct; the separately parked pending-payout row; the 11 `pending` commission rows that
   keep a pre-backfill basis (the rescale lives in the `update_order_items` RPC, not a trigger, so a
   direct UPDATE does not reach it — drift is a fraction of a cent per row); and one fulfilled order
   whose header sits a cent above its own already-correct lines (the mirror bug — stale header
   rather than stale lines). None of these were approved for change. See
   `docs/manual/KNOWN_ISSUES.md`.
4. **Open question, not settled here.** Mason separately asked whether orders should book profit on
   delivery, or whether profit should be computed only on invoices, given that orders are edited
   before delivery and goods are returned after it. That is an unscoped accounting change and is
   **not** decided by this entry.
5. **Verify the live trigger in `pg_proc` *and* the repository migration history — they answer
   different questions.** `pg_proc` is the only evidence of what applied state actually does; the
   migration history is the only evidence of what a replay or a future apply will do. Two reviewers read the tracked
   `20260808150400_round_money_to_whole_cents.sql`, saw no `NEW.profit` assignment, and concluded
   the backfill was a no-op. Live disagrees: the trigger does assign profit, zero rows remain
   stale, and the deriving body arrived via `20260809230500_single_canonical_line_profit` (ledger
   version `20260810000427`), a file that is applied live but reaches `main` only with PR #354. A
   `CREATE OR REPLACE` body applied under a re-stamped version is invisible to filename analysis.
   The repository-replay gap this leaves is recorded in `docs/reference/migration-history.md`; it
   is closed by #354 and must not be papered over by re-emitting the same function in a second
   pending migration.
## 2026-08-09 — The order header is the canonical profit; line profit is derived to match it

**Source:** live measurement during the PR #354 takeover session, recorded in
`docs/manual/KNOWN_ISSUES.md` ("DECIDED 2026-08-09 — order header profit vs the sum of its own
lines") and history row 862. Mason answered the open question from the 2026-08-08 entry below.

**The question was** which stored copy of profit is canonical — `orders.total_profit`, or the sum of
`order_items.profit` — and which single rounding rule every writer uses.

**What measuring changed.** The disagreement is not a rounding artefact. `orders.total_profit` is
recomputed by a trigger on every write and is correct. `order_items.profit` is a **stored cache that
nothing refreshes**: change a product's cost or a line's quantity and the line keeps its old profit
indefinitely. 37 of 288 live line rows across 17 orders are stale, and most of the resulting gaps are
orders of magnitude larger than any rounding rule could produce. Exact figures are in the
access-controlled session record, not here — this repository is public.

**Decision.** The **order header is canonical.** Line profit is derived from the same inputs, using
one rule everywhere: round each line's revenue and each line's cost to whole cents, then subtract.
Rounding **per line** rather than rounding the sum is deliberate — it makes
`SUM(line profit) = header total_profit` hold *exactly*, by algebra rather than by coincidence.

**Operative rules:**
- `order_items.profit` is **derived, never authored.** No writer may set it independently; the
  canonical trigger owns it. A future writer that computes profit itself is a bug.
- Any writer that touches line revenue, cost, or quantity must let the profit derivation re-run.
  The trigger is scoped `BEFORE INSERT OR UPDATE OF total_price, profit, cost_per_unit,
  total_units_needed` for exactly this reason; narrowing that column list re-opens the stale cache.
- The header must sum **per-line rounded** revenue and cost. This supersedes the 2026-08-08 concern
  that per-line profit rounding could *widen* the header-vs-lines gap: it could, but only while the
  header still subtracted unrounded cost. It no longer does.
- `net_margin` stays a percentage and is deliberately excluded from whole-cent rounding.

**Implementation:** `20260809230500_single_canonical_line_profit.sql`, written and reviewed
2026-08-09 (both migration reviewers returned zero blockers) and **applied live 2026-08-09** as
Supabase ledger version `20260810000427`, with a post-apply live read confirming both function
bodies, the widened trigger, and unchanged row counts. **Forward-only — applying it moved no
live money.** Repairing the 37 already-stale lines is a **separate** decision that has NOT been
taken; its statement is deliberately commented out, because writing those rows would also round 11
of the 46 fractional-cent `order_items` rows that `20260809170800` is intentionally holding back.

**Explicitly still open, not covered by this decision:** `_update_order_items_impl`
(`20260617123503`) overwrites `orders.total_price` with the raw un-rounded line sum. The exactness
guarantee above is scoped to `total_profit` only.

## 2026-08-08 — Four foundation-ultra-review owner decisions settled

**Source:** `docs/audits/2026-08-08-foundation-ultra-review.md` §7. Mason answered all four in chat.

1. **Payment visibility (M1) — leave as is.** `payments_select` stays company-wide; it is not
   scoped down to the invoices a rep can already see. Do not re-open without a new business reason.
2. **Canonical rounding (M3) — round to two decimals (whole cents), half-up.** The largest pending
   commission resolves half-up to the nearest cent. `order_items.total_price` and
   `commissions.commission_amount` both round at this point, and a live invariant predicate should
   assert whole cents on both.
3. **`cancel_order` semantics (M4) — cancelling releases stock.** Mason's intent: a cancelled order
   must not hold stock. **Implementation note added 2026-08-08 after tracing the live chain — the
   audit overstated this.** Full cancel ALREADY releases prebooked stock and writes its `released`
   `inventory_transactions` row (confirmed live on ORD-2026-0330), and the `partially_fulfilled` path
   already handled both halves. Only `order_items.quantity_remaining` was genuinely stranded, and
   migration `20260809170600` zeroes exactly that (written as `20260808150200`; re-issued forward on
   2026-08-09 to clear the applied high-water mark). **Do NOT add a second stock-release path** — it
   would double-release inventory. The residual `quantity_prebooked = 36` on that product is March
   2026 historical drift (audit L2), not a cancellation defect.
4. **Negative inventory (L3) — the existing decision stands.** Keep the 19 negative
   `inventory.quantity_available` rows as they are; reconcile only from physical counts. No re-base
   scheduled. Revisit when a physical count happens.

**Operative rule:** decisions 2 and 3 imply forward migrations; both are unwritten as of this entry
and are parked alongside the two migrations named in the audit (restore the `batch_apply_prepayments`
actor guard, add a migration-ordering preflight guard). Decisions 1 and 4 are "no change" — an agent
proposing either change must cite a new reason, not re-derive the original one.

## 2026-08-07 — Governed Autonomous Software Factory REMOVED

**Decision (Mason, in chat — "release the stranglehold"; chose full removal over a rebuild):** remove
the factory entirely. It repeatedly locked up ordinary work — three fail-closed hooks ran on every tool
call and every prompt (one with a 120-second timeout), a job stuck at `needs-ticket-ok` blocked whole
categories of writes, and casual words like "factory" or "overnight" flipped governed state. Mason could
not operate it.

**What was removed:** all `scripts/factory*` code, the Factory Board, the three factory hooks on both
the Claude and Codex sides, the `factory:*` npm scripts, and every factory branch inside the surviving
guard hooks. The shared state directory `<git-common-dir>/crx-factory/` is archived, not deleted.

**Operative rule:** the ordinary safety net is unchanged and remains authoritative — GitHub `protect-main`
branch protection, PR + CodeRabbit review, exact-SHA `gpt-5.6-sol` proofs for risky diffs, and the
money/migration/bash-safety/RLS guards. Do not rebuild factory-style governance without Mason explicitly
asking; if autonomous batching is wanted later, design it around the existing `/ship` pipeline with
hooks that fail OPEN for coordination (never fail-closed on ordinary work). All factory entries below
this one are historical.

---

## 2026-08-05 — Factory execution is bounded at three concurrent active lanes

**Decision (Mason, in chat — requested full-speed recovery and more than one job at a time):**
lift the one-lane pilot limit to at most three concurrent active Factory lanes. Only `building`,
`verifying`, and `in-review` consume a slot. Queued, expired-pending, parked, owner-review, and
terminal jobs stay visible without consuming capacity.

**Why:** an orphaned or parked job must not globally freeze unrelated work, while unlimited
parallelism would make repository custody, evidence attachment, and landing races harder to prove.
Three lanes provide bounded throughput with tested third-lane admission and fourth-lane refusal.

**Operative rule:** every active lane uses a separate clean linked worktree and keeps job-scoped
compare-and-swap protection for long-running evidence and owner decisions. Global pause/resume still
halts all lanes. Landing remains serialized to exactly one `approved-to-land` job, and every existing
push, merge, production, migration, live-data, secret, permission, and destructive-action gate remains
independently authoritative. No dangerous bypass may weaken those gates.

---

## 2026-08-01 — Factory retains exactly two touchpoints and coordination-only authority

**Decision (Mason, in chat — “yes so the 2x touch point rule”):** keep ordinary
Claude/Codex chat as the only owner input/approval surface and one read-only
Factory Board as the only owner output surface. Do not add Windows Hello, a PIN,
a standalone app, commands, forms, or a third interface.

**Security meaning:** chat-derived factory records coordinate and audit work;
they are not cryptographic authentication against arbitrary code already
running as Mason's Windows account. Factory state may only add restrictions to
ordinary reversible work already authorized by Mason's request and repository
policy. It may never grant or replace push, merge, CI, deployment, migration,
live-data, secret, permission, or destructive-action authority. Those existing
gates remain independently authoritative.

**Why:** the official Claude/Codex command-hook contract supplies ordinary JSON
on standard input and documents no platform-signed user-event token. Strong
same-account human authentication would require another owner ceremony, which
would violate the chosen two-touchpoint product rule.

---

## 2026-07-30 — AP period-close hardening stays bounded to three sibling mutators

**Decision (Mason, in-chat — approved the recommended separate hardening job):**
extend the shared/exclusive accounting-month protocol to
`record_vendor_payment`, `void_vendor_payment`, and `void_vendor_bill`, and
remove browser-role direct writes to `accounting_periods`. Keep authenticated
read access and the governed close/reopen RPCs.

**Why:** these three AP paths were the documented sibling residual from the
vendor-bill release and share one coherent date rule: payments use the payment
date; bill voids use the original bill date. Each preserves its existing
business-row locks, then takes the shared month lock, checks the period, and
mutates. Close takes the same month lock exclusively and does not lock AP rows,
so there is no lock cycle.

**Boundary:** do not add the month lock to `reopen_accounting_period` in this
slice. Reopen currently locks the period row first; adding a later month lock
would deadlock with close's month-lock-first order. The other financial
`check_period_open` callers remain a separate global protocol review and this
AP fix must not be described as covering them.

---

## 2026-07-30 — Period-close month lock spans the atomic close result

**Decision (Mason, in-chat — "I approve pushing all of this and migrating and making it live",
after the release packet and lock behavior were presented):** retain the transaction-scoped
exclusive accounting-month lock through the close upsert, summary construction, idempotency save,
and return. The five summary aggregates do not read `vendor_bills`; keeping the lock until commit
preserves one atomic close/result boundary, while vendor-bill writers wait under the calling
request's statement timeout. Do not switch to a releasable session lock or move result construction
outside the transaction without a new concurrency and failure-path proof.

**Tradeoff:** a close temporarily blocks vendor-bill create/update for that month through its
bounded reporting queries. This is an accepted close-time latency cost, not an invitation to widen
the protocol to unrelated writers.

---

## 2026-07-30 — Empty search_path is the narrow fully-qualified SECURITY DEFINER exception

**Decision (Mason, in-chat — "I approve pushing all of this and migrating and making it live",
after the governed release packet and rule change were presented):** `SECURITY DEFINER`
functions normally use `public, pg_temp`; an exactly empty `search_path` is allowed only for a
deliberately fully schema-qualified body with current source and migration-review proof.
`check_period_open(date)` is the first explicit exception.
**Why:** this exception is safe because every application relation reference is
schema-qualified and a separate live guard enforces that requirement. PostgreSQL still
searches `pg_temp` implicitly first with an empty path, so full qualification — not the
empty path alone — is the protection.
**What this forbids/implies:** never remove a function from the pg_temp contract silently;
move a reviewed exception to the exact-empty allowlist and keep every relation schema-qualified.

---

## 2026-07-30 — SETTLED: active adversarial review uses independent Sol/high sessions

**Decision (Mason, in chat):** Claude/Fable credits are nearly exhausted, so all active adversarial
review gates now use `gpt-5.6-sol` at high reasoning effort. Claude/Fable review remains available
only when Mason explicitly asks for it; it is not a mandatory factory, publication, migration, or
overnight gate.

**Why:** the independent check must remain hard and reproducible without consuming a second paid
review pool that is no longer reliably available. This deliberately accepts the limitation that the
builder and reviewer may share a model family. Independence now comes from a separate ephemeral,
read-only review process with user configuration and project hooks disabled, plus exact
base/SHA/content binding and deterministic fail-closed proof validation.

**Operative rule:** factory acceptance, risky push/merge proof, migration review, and unattended
review explicitly pin `model: gpt-5.6-sol` and `reasoning_effort: high`. A proof missing either value,
or not bound to the exact reviewed bytes, is invalid. CodeRabbit remains the broad every-PR review.

---

## 2026-07-28 — SETTLED: revoking anon EXECUTE ships in two halves, and the RLS role helpers are the risky half

**Decision (Mason, in-chat — "ok continue and make it all live please", after the two-half split and
the blast radius of part 2 were put to him explicitly):** Codex's draft
`20260728185827_revoke_anon_security_definer_execute.sql` revoked anon EXECUTE on 43 functions in
one file with one justification sentence copy-pasted 43 times. It is **split into two migrations
and two PRs** rather than shipped as one.

**Why:** the 43 are not one risk class. A `REVOKE EXECUTE` does not make a function quietly return
"no rows" — a caller that lacks the grant gets a hard `42501 permission denied for function`. RLS
policy expressions are evaluated **as the querying role**, so revoking a function that a policy
calls turns every affected table into an error for that role, not an empty result.

Read-only check against live `rhyzpcqhnizqbxphqdkr`:

- 30 anon-reachable tables carry **70 policies with audience `{public}`** — i.e. evaluated by
  `anon` — that call `is_admin()` (30 tables), `is_applicator()` (6) or `is_driver()` (1).
- `require_admin` and `require_admin_or_sales_rep` appear in **zero** table policies. The
  original worry that they were load-bearing in row rules is not borne out.
- The login page is **not** the victim: `src/App.tsx:185` puts every route except `login` inside
  `<ProtectedRoute>`, and the login page reads no RLS-protected table.

**What this forbids/implies:**

- **Part 1** (authored `20260728193000`, PR #262 — **applied live as ledger `20260728231350`**)
  revokes the **40 functions that appear in no policy at all**. Safe by construction — the grant
  cannot be load-bearing in a row rule that does not reference it. Within it, GROUP 2 (8 ungated
  `SECURITY DEFINER` callables, including the six `next_*_number()` allocators,
  `calculate_billing_splits` and `check_period_open`) was the actual live exposure: a logged-out
  visitor could call those.
- **Part 2** (authored `20260728193100`, PR #263 — **applied live as ledger `20260728233459`**)
  revokes only `is_admin()`, `is_applicator()`, `is_driver()`. It carried the whole blast radius
  and merged on its own evidence, chiefly the **`is_sales_rep()` precedent** — `anon` already
  lacked EXECUTE on it across 24 tables and production was fine, which was the closest thing to a
  live experiment available without applying anything. Borne out after the apply: `authenticated`
  and `service_role` retained EXECUTE on all three, and a logged-out production load rendered the
  sign-in page with no console errors and no `42501`.
- **`handle_new_user()` is never revoked**, in either half. It runs as the signup trigger.
- **Every REVOKE must name both `PUBLIC` and `anon`.** The two grants are independent, and
  removing either one alone leaves `anon` still able to execute. Supabase's `ALTER DEFAULT
  PRIVILEGES` grants `anon` EXECUTE *directly* on each new public function, so revoking only
  `PUBLIC` leaves that direct grant standing; revoking only `anon` leaves the access it inherits
  through `PUBLIC`. (Revoking `PUBLIC` on its own is not useless — it does remove the inherited
  access for roles that hold no direct grant — it simply does not achieve the goal here.) Only
  revoking both removes `anon`'s effective access.
- **Prove a revoke with `has_function_privilege(...)`, never a `proacl` scan.** `proacl` is NULL
  for default privileges, so a scan reports "no anon grant" on a function anon can call.
- The safe default when in doubt is to revoke **fewer** functions, not more.

Source: `docs/manual/KNOWN_ISSUES.md` §0c; proof in PR #262 and this PR (whole schema rebuilt
from zero in a throwaway container, all six post-baseline migrations replayed, 43/43 verified).

## 2026-07-25 — SETTLED: Opus 5 harness tuning; Hermes not adopted; Claude/Codex hook asymmetry is by design

**Decision (Mason, in-chat):** tune the harness for Claude Opus 5 and drop Hermes — "we don't use Hermes really." No third-agent contract, entry point, or hook adapter will be built.
**Why:** an Opus 5 review found the harness already close to Anthropic's guidance, with the gaps being things that were *missing* (no effort policy, no subagent budget, no length calibration) rather than things that were wrong.
**What this forbids/implies:**
- `CLAUDE.md` gains a **Model Tuning (Claude Opus 5)** section: concise-response `<tone_preference>`, written-deliverable length calibration, a subagent budget capped at the fan-outs already defined in `.claude/workflows/`, and an effort mapping (`low` mechanical → `xhigh` foundation/migration review). The effort mapping is an unmeasured starting point; **never lower effort on a money/RLS/migration path to save tokens.**
- Redundant self-verification instructions are discouraged, but this **does not** relax the `AGENTS.md` Verification Standard, the Codex cross-model gate, or the adversarial skeptics on money/RLS/migration paths — those are production-safety and independent-check mechanisms, not model self-checks.
- Review prompts must request every finding and filter later; never instruct a reviewer to "only report high-severity issues" or "be conservative" (Opus 5 obeys literally and reports less). **SETTLED (Mason, 2026-07-25) — bounded overnight sweeps are exempt.** `overnight-bug-hunt.js:51`, `money-inventory-hunt.js:52`, and `whole-codebase-audit.js:29` keep their 8–10 "most significant" caps; the per-run cost of uncapped fan-out outweighs the tail findings. Accepted trade-off: a low-ranked correctness bug can be dropped before the skeptic pass on those runs. The rule binds everywhere else — do not add a cap to any other review prompt.
- **SETTLED (Mason, 2026-07-25) — night hunt stays at `high`.** `money-inventory-hunt.js` pins `effort: 'high'` at `:293` and `:334`. It stays there until an effort sweep on real CRX tasks measures otherwise; nothing indicates `high` is currently failing, and `xhigh` costs more on the largest fan-out in the repo. The `xhigh` row of the mapping therefore does not reach those agents by design, not by oversight.
- `AGENTS.md` gains a scope paragraph (deliver what was asked, at the scope intended) applying to Claude and Codex alike.
- **The six-hook Claude/Codex divergence is deliberate at the wiring level, not a gap.** `scripts/agent-manifest-parity.mjs` declares and build-enforces it; Codex runs its own `.codex/hooks/production-action-guard.mjs` covering pushes, PR merges, and live actions. A new guard must be wired on both sides or declared in `CLAUDE_ONLY_HOOKS`/`CODEX_ONLY_HOOKS` with a reason. **Do not re-open the wiring** — but this does not mean the two guards are behaviorally equivalent; see the open item below.

**RESOLVED (P1, 2026-07-25, PR #228) — Codex merge guard bound to a stale local base.** Codex's independent review of PR #227 refuted the "equivalent guard" claim, and the refutation was verified in source. `.claude/hooks/pr-merge-guard.mjs` binds its proof to GitHub's current `baseRefOid`; `.codex/hooks/production-action-guard.mjs` never requests `baseRefOid`, resolves the base from local `origin/main`, and never fetches. On a stale checkout Codex can therefore clear a risky money/RLS/migration merge on a proof reviewed against a base the change will not land on. **RESOLVED 2026-07-25** (Mason approved as its own PR; the file is in the guard's own `PROTECTED_HARNESS_SOURCE` set, so it did not ride along on the documentation change). `resolvePullRequest()` now requests `baseRefOid`; `gatePullRequestMerge()` requires it for main-bound merges and passes it to `gateMainChange()` as the authoritative base. Two things follow that the original finding did not spell out: the **risk diff** is now computed against that base too (it previously used the literal `origin/main` ref, so a stale local base could misclassify a risky diff as ordinary and skip the proof requirement entirely), and a base GitHub reports but the checkout lacks **fails closed** with `git fetch origin main` guidance rather than an opaque git error. `baseRefOid` is deliberately NOT required in `resolvePullRequest()` itself — that would fail-close PRs targeting non-`main` branches, which the gate does not cover.

**Second Codex P1 on the fix itself (2026-07-25), also confirmed and fixed:** binding the diff to `baseSha` is not enough, because `git diff A...B` is three-dot — `merge-base(A,B)..B`. When a PR head is BEHIND the real base, `staleBase...head` and `githubBase...head` produce **byte-identical** diffs (verified empirically), so base-only commits stay invisible to the risk classifier, and `run-claude-review.mjs --scope base-main` hands Claude the same merge-base patch. A risky merge could therefore land base changes no review ever saw. **Operative rule:** for risky main-bound merges the guard now requires `baseSha` to be an ancestor of `headSha` and fails closed with "update the branch" guidance otherwise — GitHub branch protection does not require up-to-date heads, so the guard enforces it. This ancestry requirement is what makes the base-binding meaningful; do not remove one without the other.

**Third Codex finding (P2, 2026-07-25), also confirmed and fixed:** `scripts/run-claude-review.mjs` derives `base_sha` from **local** `origin/main` (`baseSha = rev-parse origin/main`) and never fetches. So when a head contains GitHub's base but the local ref is stale — e.g. the branch was fetched but `main` was not — ancestry passes, the gate demands a proof naming GitHub's base, and the wrapper mints one naming the stale base: **every retry rejected, with no escape from following the printed instructions.** The proof guidance now leads with `git fetch origin main` whenever it is gating against an authoritative base. **Operative rule:** if the wrapper's base resolution ever changes, re-check this guidance — the guard's expected base and the wrapper's recorded base must agree or the gate deadlocks. Regression tests in `.codex/hooks/production-action-guard.test.mjs` drive real git repos through all five paths: stale-bound proof denied, risky head behind base denied, head updated to contain base allowed, unfetched base denied, missing `baseRefOid` denied.

Source: `docs/research/2026-07-25-opus5-harness-review.md` §1.1a. (Two corrections are recorded there: the first draft wrongly called the hook wiring a BLOCKER, and the first correction wrongly called the two guards equivalent. The cross-model gate caught the second — which is the gate working as designed.)

## 2026-07-22 — SETTLED: Codex plans, then proceeds; progress must expose remaining work

**Decision (Mason, in-chat):** a request to Codex to build, fix, finish, audit, or handle a CRX task authorizes its ordinary reversible local work; for substantial work, Codex states the plain-English goal, definition of done, plan, and expected files/systems, then begins without a second approval or "Should I continue?" while a safe in-scope step exists. Claude's existing plan-approval workflow is unchanged.
**Why:** sessions were stopping after plans and obscuring forward movement, remaining work, and the next action.
**What this forbids/implies:** keep a visible completed/current/remaining plan and use `PROGRESS` / `DONE` / `NOW` / `REMAINING` / `NEEDS MASON`; close with `COMPLETE` / `READY FOR APPROVAL` / `BLOCKED` / `PARTIAL`, work remaining, proof, and one next step. Investigate/reroute blocked lanes; stop only at the contract's live/destructive/outward-facing gates, a material owner choice, or exhausted safe progress; finish safe preparation and consolidate any question. Never call work complete while required work remains.

## 2026-07-19 — SETTLED: split-billing v1 edge-case policy — per-child commissions (no job-level clamp) + no extra job-less double-submit guard

**Decision (Mason, 2026-07-19, two calls):**

1. **Commissions on Option-B splits stay per-child, mirroring the live model — NO job-level clamp
   in v1.** Because each co-owner is priced at their own tier, an operator who deliberately
   overrides one co-owner BELOW cost creates a child with negative profit; the app's standing
   "commissions never go negative" rule then means total split commissions can exceed 
   commission-on-whole-job-profit (worked example: 50/50, A tier $15 → +$250 profit → $25
   commission; B overridden to $8 vs $10 cost → −$100 profit → $0; rep gets $25 where a single
   invoice would have paid $15). Mason accepted this for v1: the case requires a deliberate
   below-cost override (with a stored override reason), the exposure is capped by that deliberate
   loss, and commissions are human-reviewed at payout-batch time. **Operative rule:** do NOT add
   job-level commission netting/clamping to `save_field_app_split_invoice`; if a real below-cost
   split ever appears in a payout, build the job-level cap then as its own proven change.

2. **Job-less splits get NO extra double-submit exclusivity guard in v1** (two tabs could each
   bill a job-less split — same exposure as the rest of the app's non-job invoicing). Job-backed
   splits are already protected by the #E source-job consume guard. **Operative rule:** accept
   live parity; do not bolt an idempotency/exclusivity scheme onto the job-less path for v1.

Context: these were the last two open owner-decisions from the Fable adversarial review of the
then-parked per-line split-billing build (PR #164, at the time flag OFF and migrations not applied),
whose go-live was expected to gate on a CLEAN Codex round-6 verdict (~2026-07-24) + Mason's review.
**Superseded by events:** PR #164 merged 2026-07-21, its three migrations are applied live, and
`per_line_split_billing_enabled` was set to `true` the same day. Current status:
`docs/manual/KNOWN_ISSUES.md` §0.

## 2026-07-17 — SETTLED: split-billing model = per-line custom splits on the FIELD-APP path; order-side engine retired later

**Decision (Mason, 2026-07-17):** the app's real split-billing model is **per-line-item custom
splits at the field-application-invoice stage** — default each line from field ownership
(`field_billing_defaults`), adjust who-pays-what and one-off prices in the UNPOSTED draft, post =
the actual invoice, and **unpost stays reversible** (edit-then-repost, with an append-only post
snapshot). This **refines the 2026-06-17 "splits are order-side" decision below**: the FIELD-APP
path (`field_app_locations` → `invoice_shares`, one child invoice per customer) is the surface we
build on; the order-side engine (`order_shares` / `order_item_field_allocations` /
`create_split_invoices_from_order`) is **unproven (0 live rows), NOT dead — retire it LATER** in a
separate cleanup after confirming zero real executions, and `order_line_allocations` (dead twin,
only ever DELETEd) can't be dropped standalone until `_update_order_items_impl`'s delete refs go.
**Operative rule:** new split-billing work targets the field-app path; do not extend or newly
depend on the order-side engine; the full build spec (3 advisor passes — gpt-5.6-terra design +
xhigh plan-review, claude-fable-5 money-math) is `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`.
Money math is pinned there (half-away-from-zero, one shared numeric preview+post engine,
`amount_cents` display-authoritative, post-time SUM assertions, group total is reporting-only not a
5th balance lever). *(Status at the time of this decision: **not built**, to be built in Codex the
following week with the §6.1 baseline real-billing cycle first. It has since been built and shipped —
PR #164, merged 2026-07-21, live with the flag ON; see `docs/manual/KNOWN_ISSUES.md` §0.)*

## 2026-07-17 — SETTLED: CodeRabbit is the standing every-PR AI reviewer; FarmRx made public

**Decision (Mason, 2026-07-17):** enable CodeRabbit (AI PR reviewer) on both public repos and
fold it into the landing flow. `CRX_Manager_V1.0` was already public; `FarmRx` was flipped
**private → public** this session at Mason's explicit request (full 76-commit history was
secret-scanned clean first — no `.env` ever committed, no service-role keys / tokens / passwords;
only publishable + VAPID public keys in code; customer data lives in FarmRx's separate Supabase
project behind RLS, not the repo). Each repo carries a `.coderabbit.yaml` on `main` whose
`path_instructions` mirror that repo's hard rules; the file overrides CodeRabbit's dashboard
settings. CodeRabbit is **free for public repos**, so the account's Pro Plus trial is irrelevant
to cost.

**Enforcement choice (Mason picked "process now, hard-block soon"):** the landing flow now
includes reading CodeRabbit's review and fixing any real issue before merge (advisory — it does
not block; nitpicks may be dismissed with a reason). CodeRabbit is the broad every-PR pass;
the Codex cross-model proof stays the hard gate for money/RLS/migration diffs — both run.
Operative rule: after CI/Vercel go green, do not merge until CodeRabbit has posted its review and
its real findings are resolved. **Follow-up (open):** add a merge-blocking required status check
for CodeRabbit to the `protect-main` ruleset once its exact check name is confirmed on a live PR.
(Source: AGENTS.md "Standing CodeRabbit review policy"; PR #160 landed the CRX config; FarmRx
config commit 943e5688.)

## 2026-07-17 — SETTLED: save_customer edits are assigned-rep-or-admin only (no office-manager carve-out)

**Decision (Mason, 2026-07-17, relayed from the CRM loop session):** customer master-record
edits through the `save_customer` SECDEF RPC are RESTRICTED to admins (any customer) and the
assigned sales rep (`customers.assigned_sales_rep = auth.uid()` only). No office-manager
carve-out, no sensitive-field-only scoping. This closes the 2026-07-16 Codex gauntlet finding
that the RPC's role-only gate let any active sales rep edit any customer (credit limit,
finance-charge settings, commission split) in bypass of the assigned-rep-only `customers_update`
RLS policy. Grounding: rep SELECT was already assignment-scoped, and the activity feed shows no
rep has ever edited a customer — the restriction changes no real workflow.
Operative rule: the in-body gates (`NOT_CUSTOMER_OWNER` / `REP_CANNOT_REASSIGN` /
`REP_MUST_SELF_ASSIGN`) in migration `20260717123000_save_customer_ownership_enforcement.sql`
mirror the customers RLS policies; keep function-body authorization and RLS in lockstep if
either changes. APPLIED LIVE 2026-07-17 (ledger version 20260717123000) under Mason's
in-chat OK; post-apply live probe confirmed a rep is denied editing a non-assigned customer.
(Source: branch `claude/amazing-ptolemy-9e7e0a`; migration-history row 734.)

## 2026-07-17 — SETTLED (Mason, in-chat): five CRM owner decisions

**Decisions (Mason, in-chat, 2026-07-17 morning):**
1. **save_customer authorization:** restrict edits to the assigned sales rep + admins. No
   office-manager carve-out. (Relayed to the fix session working the pre-existing gap.)
2. **Grower crops:** crops are SELECTED and assigned per customer (a controlled list on the
   customer record) — NOT derived from field crop-history. Supersedes the parked
   "crop source of truth" question. Shipping as `customers.crops text[]` + UI chips + call-list filter.
3. **Prep-card top products:** show BOTH rankings — highest revenue AND highest volume
   (volume = per-product quantity, unit always displayed; cross-product raw-quantity caveat noted in SQL).
4. **AI disclosure wording:** default confirmed ("this call may be recorded" + AI self-identifies).
   Final sign-off still happens at voice-vendor go-live.
5. **Transcript retention: 15 months.** Purge mechanism gets built in Phase 5; retention_expires_at
   semantics = occurred_at + 15 months.

## 2026-07-17 — SETTLED: CRM read-aggregates are assignment-scoped (wider than row-level invoice RLS)

**Decision (loop orchestration under Mason's pre-authorized run; pattern inherited from
`get_customer_statement`):** the CRM purchase-intelligence and call-list SECDEF RPCs scope by
CUSTOMER ASSIGNMENT — an assigned rep sees their customer's full financial aggregates (revenue,
prepay, AR, top products) even where row-level `invoices_select` would only show them invoices
they personally wrote. Rationale: "the assigned rep owns the relationship" is the CRM's core
model, and the same widening already existed in `get_customer_statement`. Never cross-customer.
Operative rule: new CRM read RPCs follow assignment scoping; do not re-litigate per-RPC.
(Flagged by the final-gauntlet system RLS review 2026-07-17; source: loop ledger.)

## 2026-07-17 — CRM call-list filters: tier shipped client-side; crop parked as owner decision

**Decision:** the Phase-3 mission text listed rep/tier/crop/last-contact filters. Rep + tier +
last-contact shipped; CROP is parked for Mason because "what a grower grows" has no single source
of truth (field crop-history vs notes) — that's a business-data decision, not a build detail.
Operative rule: don't add a crop filter until Mason picks the source; tier lookups are
client-side against `customers.assigned_tier` (no RPC payload change needed).
(Sol 3.G rounds 1-2; source: loop ledger "Scope decisions".)

---

## 2026-07-13 — SETTLED & ACTIVE: Codex standing push/merge authorization (mirror of Claude's)

**Status: ACTIVE since 2026-07-14** — merged to `main` via PR #114 (harness through review round 4) and PR #118 (round-5 hardening delta), both through the `protect-main` ruleset with Mason's explicit approval. Mason authorized the design 2026-07-13, approved the GitHub protection change, and approved the merge; the final branch passed 5 adversarial Codex rounds and 4 Claude rounds. GitHub requires a pull request plus a passing **Vercel** status check (ruleset verified via the rulesets API), applies the rule to administrators, and disables force-push/deletion — so **direct pushes to `main` no longer exist for anyone**; all agents land work via branch → PR → green checks → merge. Follow-up for Mason: add the CI checks now confirmed on PR #118 — "Lint, Type Check, Test, Build" and "SQL Migration Validation" — as required checks in the ruleset ("E2E Smoke Tests" reports as skipped on docs-only PRs, so add it only if skipped counts as passing is acceptable), and enable "require branches to be up to date". Claude round 4 proved that repository-owned hooks cannot be the sole security boundary when the same local agent can edit files and spawn arbitrary processes; guard hooks, CI, Husky, and the review wrapper are classified as risky so self-modifications cannot avoid second-model review.

**Proposed decision:** Codex may push or merge ordinary reversible code to `main` once the full green pipeline passes. A main-bound diff classified as risky by the shared `.claude/hooks/codex-push-lib.mjs` path/content rules additionally requires a real Claude review of that exact commit in the current session and a fresh SHA-bound proof at `.claude/session-state/claude-review-push.json`. The Codex production guard applies this rule to direct pushes, `git -C` forms, `gh pr merge`, and GitHub MCP merge tools, and fails closed when it cannot verify the ref, diff, PR target, or proof.

**Review hardening:** force intent is checked before target/diff classification and denied for every branch (`--force`, `-f`, `--force-with-lease`, combined short flags, or `+` refspecs); bulk modes (`--all`, `--branches`, `--mirror`, `--prune`) are denied. Both agents recognize `git`/`git.exe`/quoted executable paths, resolve `git -C`, inspect every push in a chained command, use the hook payload/tool working directory, reject shell directory or `GIT_DIR`/`GIT_WORK_TREE` context changes, and fail closed when refs/diffs cannot be inspected. Server-side merge routes (`gh pr merge`, relative/full-URL `gh api .../pulls/<n>/merge`, and GitHub MCP merge tools) must report `mergeStateStatus=CLEAN` and a non-empty rollup with every check completed in an accepted green state before the risk/proof gate can allow them. GraphQL merges and unrecognized GitHub API/tool writes deny closed. Only a successful real `run-claude-review.mjs --scope base-main` run using the absolute installed Claude Code binary with `shell:false` and exactly one terminal `FINAL_VERDICT` can write the Claude proof; the standalone verdict writer was removed, the wrapper is covered by the ledger guard, and recognized direct tool/shell proof access plus contiguous/split interactive entry into the proof directory is denied for both agents.

**Unchanged boundaries:** this grant never covers deleting `main`, force-pushing, live migrations or data writes, edge-function deploys, secrets/auth/permission changes, direct GitHub writes that bypass Husky, or bypassing the reviewed push path. Codex's Supabase access remains strictly read-only: `execute_sql` rejects multiple statements and every custom/application function call, including mutating RPCs invoked through `SELECT`. Repository-scoped `node_repl` and Node eval/print modes are denied because they can launch uninspected write processes. The initial harness branch may only be pushed to its feature branch. Local hooks are deterministic honest-agent guardrails, not a cryptographic sandbox; GitHub branch protection is the external hard boundary and must require a pull request plus passing checks before this grant can activate.

**Why:** Mason wants the same momentum for either primary coding agent, while preserving a deterministic second-model gate on money, database, security, and other high-blast-radius changes.

---

## 2026-07-13 — SETTLED: pre-authorized runs may apply live migrations without a per-migration in-chat OK

**Decision (Mason, in-chat, 2026-07-13):** the migration-apply approval question flagged on
2026-07-13 is settled as option (b), with a hard carve-out. A live migration apply is authorized
when BOTH hold:

1. **The hard proof gate passes (never loosens):** a fresh same-session migration-apply-guard
   proof (rls-security-reviewer + migration-drift-reviewer), plus a real Codex verdict this
   session for any SQL/RLS/money change.
2. **Mason authorized the run**, in one of two forms:
   - his in-chat OK in the current conversation (the default whenever he is present), or
   - a **pre-authorized hands-free run**: Mason explicitly asked for the run and autopilot is
     armed (`node .claude/hooks/autopilot-arm.mjs --hours N`) — the unexpired armed flag is the
     durable record of that authorization. No per-migration in-chat OK is needed during such a run.

**Never autonomous, even in an armed run:** destructive migrations — apply-time DROP TABLE,
DROP COLUMN, TRUNCATE, or ANY top-level DELETE FROM (deliberately no table allowlist; deleted
data has no one-click rollback on the free Supabase plan — no PITR) — plus edge-function
deploys, data deletion outside migrations, and secrets/auth/permission changes. Those always
park for Mason's fresh in-chat yes. The dedicated read-only bug-hunt loop (`loop-guard.mjs`
worktrees) stays read-only by design — this decision does not touch it.

**Hard enforcement (same day, hardened across two Codex adversarial rounds):**
`migration-apply-guard.mjs` recognizes three states. Flag absent → interactive rules. Flag
ACTIVE → hands-free rules: destructive migrations refused outright (default-keep SQL
classifier — DROP TABLE/SCHEMA/TYPE/DOMAIN, DROP [COLUMN], TRUNCATE, any top-level DELETE,
MERGE; function bodies exempt, DO blocks always visible); non-destructive applies additionally
require BOTH a hash-bound reviewer proof (`queryHash` exactly matching the transmitted SQL)
AND a hash-bound Codex proof (`codex-review-mig-<name>.json`: matching `queryHash`, passing
`verdict`, fresh `timestamp`). Flag exists but EXPIRED/malformed → the authorization has
LAPSED: ALL applies are blocked (fail closed) until Mason re-arms or disarms in person
(`autopilot-arm.mjs --off` deletes the flag). The proof files remain self-attested —
an honest-mistake net, not malicious-agent proof (documented residual, KNOWN_ISSUES §4b).

**Why:** Mason wants overnight loops to run genuinely hands-free; the proof gate is the real
(hard, adversarial, same-session) safety layer, and the armed-autopilot flag makes his
pre-authorization explicit and expiring rather than an assumed standing blessing.

**What this forbids/implies:** never apply on a stale or prior-session proof; never treat a
past run's arming as covering a new run; an interactive session with Mason present still asks
in chat; destructive migrations always stop regardless of arming.

---

## 2026-07-12/13 — Backup strategy: weekly off-site + weekly in-DB snapshot

**Decision:** Two independent weekly backups run: an encrypted `pg_dump` pushed to the private
GitHub repo `masonwells1/CRX_Backups` (GitHub Action), and a same-database `pg_cron` snapshot
into a `backup_snapshots` table (migration `20260713050000`), pruned only on full success.
**Why:** Supabase's org plan is FREE, which has no PITR (point-in-time recovery) — these two
jobs are the only recovery path if data is lost or corrupted.
**What this forbids/implies:** don't assume PITR exists. Don't prune/trim `backup_snapshots`
on a partial run. Treat the off-site copy as the disaster-recovery copy (same-DB snapshot
doesn't survive a DB-level disaster).

---

## 2026-07-10 — Live migration apply is hands-free, gated by the apply-guard proof

**Decision:** Applying a live migration no longer needs an in-chat approval popup, but it is
still hard-gated: an agent may only call `apply_migration` after producing a fresh
migration-apply-guard proof file (this session's reviewer verdict), and SQL/RLS/money/edge-fn
changes require an actual Codex review verdict this session first.
**Why:** Mason wants momentum on reversible work without a popup for every migration, but a
live-DB apply is irreversible enough to need a real, current, adversarial second look — not a
rubber-stamp.
**What this forbids/implies:** never apply a live migration on a stale or "prior session"
verdict; the proof file must be generated in the current session. In an ordinary interactive
session, still get Mason's in-chat OK — the proof gate is a floor, not a substitute for his
authorization. (The wording ambiguity about pre-authorized loops is SETTLED — see the
2026-07-13 entry above: armed autopilot + proof gate suffices in a hands-free run.)

---

## ~2026-07-10 — Business time is America/Chicago; the live DB and pg_cron run UTC

**Decision:** All business-day logic (billing dates, "today" dashboards, cron schedules) must
convert explicitly from UTC to America/Chicago; never treat the database clock as local time.
**Why:** this bit twice on 2026-07-10 — date boundaries computed off the DB's UTC clock put
late-evening activity on the wrong business day. (Source: session memory — the fix pattern is
visible in the workflow-waves cron migrations; verify before relying.)
**What this forbids/implies:** any new query, RPC, or cron job that groups or filters by
business date must apply the timezone conversion explicitly; a bare `now()::date` on the live
DB is a bug.

---

## 2026-07-05 / 2026-07-11 — Migration/SQL/deploy permission prompts removed; hooks are the gate

**Decision:** In-chat approval popups for migrations, SQL execution, and edge-function deploys
were removed (commit `97f7bf94`, 2026-07-05) and the removal was reinforced (commit `9e3e8f10`,
2026-07-11) after tracked `settings.json` kept resurrecting the prompts in fresh worktrees.
**Why:** HARD guards (hooks that actually block) are more reliable safety than a SOFT prose
rule or a popup an agent can talk past — see AGENTS.md's HARD-vs-SOFT principle.
**What this forbids/implies:** don't re-add approval popups for these actions; if a fresh
worktree shows prompts again, that's the known `settings.json` gotcha, not a policy reversal —
fix the hook/settings file instead.

---

## ~2026-06-30 — New SECURITY DEFINER functions must explicitly revoke anon

**Decision:** Every new `SECURITY DEFINER` function must `REVOKE EXECUTE ... FROM PUBLIC` and
then explicitly `REVOKE ... FROM anon` — `REVOKE FROM PUBLIC` alone does not de-anonymize a
function that was separately granted to `anon`.
**Why:** repeated bug-hunt cycles (e.g. migration `20260713040000_revoke_anon_trigger_fn_exec`,
migration `20260616122108_revoke_execute_order_shares_guard_fn`) found SECDEF functions still
callable by the anonymous role after only a PUBLIC revoke.
**What this forbids/implies:** a migration that adds a SECDEF function and revokes only
PUBLIC is incomplete; always add the explicit anon revoke in the same migration.

---

## ~2026-06-28 — Internal-only product direction: no grower portal yet

**Decision:** CRX Manager's near-term roadmap targets internal/office users only; "beyond
parity" features (Office Cockpit, etc.) are built for staff, not growers.
**Why:** owner call — a grower-facing portal is a bigger investment than the current business
need justifies.
**What this forbids/implies:** don't design new features assuming grower login/self-service;
that's a future, separate decision. (Source: session memory — verify with Mason before relying
if this becomes load-bearing for a new feature.)

---

## 2026-06-23 — Two-acre model: full boundary acres vs. edited billable acres

**Decision:** Fields carry two acre figures — `measured_acres` (from the mapped boundary) and
an editable `override_acres`; per-acre billing always uses the edited/override figure via
`COALESCE(override_acres, measured_acres, total_acres)`.
**Why:** a GPS/satellite boundary's raw acreage often doesn't match what the grower is billed
for (buffers, waterways, etc.), so billing needs a human-correctable number distinct from the
mapped one.
**What this forbids/implies:** never bill off the raw boundary acreage directly; always read
the billable figure through the override-first COALESCE, and any new acre-consuming feature
must respect the same precedence (verified: migration `20260623120000`).

---

## 2026-06-17 — Split invoices modeled order-side, allocated by field/acre

**⚠ SUPERSEDED by the 2026-07-17 split-billing decision (top of log).** Kept for historical rationale
only. The operative surface is now the FIELD-APP path (per-line custom splits); the order-side
`order_shares` engine is unproven and slated for retirement. Do NOT treat the guidance below as current.

**Decision:** Multi-customer billing splits live on the order side (`order_shares` /
`invoice_shares`), allocated by field/acre rather than by dollar percentage alone.
**Why:** the real-world unit of split billing on a farm job is the field each customer's acres
were treated on, not an arbitrary percentage.
**What this forbids/implies:** `order_shares`/`invoice_shares` are the split-billing surface;
don't reach for one of the other dormant split tables (`order_item_field_allocations`,
`field_app_location_shares`, `job_field_shares`) for new split-billing work without checking
which one is actually live for that flow first (verified: docs/CHANGELOG.md 2026-06-17 entry).

---

## 2026-06-16 — Auto-push to `main` authorized for green, reversible code

**Decision:** Once a code change (not a migration) passes the full gate — lint, typecheck,
build, tests, Codex review — an agent may push it to `main` without a further in-chat OK.
Vercel's one-click rollback is the safety net.
**Why:** Mason wants momentum on ordinary reversible work; a frontend push to a Vercel-hosted
app is trivially undoable, unlike a live migration or data mutation.
**What this forbids/implies:** this authorization is code/frontend only. Live migration apply,
edge-function deploy, deleting data, and force-push remain hard-gated behind explicit
in-conversation approval every time (verified: referenced as "Mason 2026-06-16" across
docs/loops/*, docs/build-loops/*).

---

## 2026-06-14 — Prepay "earmark" engine SHELVED pending a reserved-pool redesign

**Decision:** The booking-prepay earmark engine (3 migrations: `20260613240000`,
`20260613250000`, `20260613280000`) and its frontend controls were pulled from the go-live
batch and parked in `docs/roadmap/shelved-earmark-engine/`.
**Why:** Codex review found it could double-spend and misreport funds because it trusted
per-credit balances while a second legacy code path (`apply_remaining_prepayments`) spent the
same money from an aggregate balance with no shared guard — a real money-integrity bug, not a
style nit.
**What this forbids/implies:** do not re-apply the 3 parked migrations or re-add the earmark
UI as-is. Any revival needs the reserved-pool redesign described in that README (a dedicated
reserved balance, not a patch) plus a fresh Codex-gated build.

---

## Foundational (~2026-05, still current) — Core engineering invariants

**Decision:** Four rules fixed at the project's foundation and never revisited: (1) money is
always `bigint` cents, never floating-point; (2) business invariants (balances, inventory,
state transitions) are enforced in Postgres RPCs/triggers/constraints, not React; (3)
`src/lib/db.ts` is the only Supabase client, and `assertRpcResult()`/`checkMutationResult()`
are mandatory after every RPC call/`.update()`/`.delete()`; (4) every mutating RPC accepts and
actually enforces `p_idempotency_key text DEFAULT NULL` (added after repeated double-submit
bugs, e.g. the 2026-07-10 `save_job_applied_record` fix).
**Why:** these are the recurring bug classes (money bugs, invariant bypass via a second code
path, double-submits from retries/flaky networks) that have cost the most rework historically.
**What this forbids/implies:** any new RPC, migration, or money-touching code that violates
one of these four is a defect, not a style choice — these are enforced in AGENTS.md as CRX
Hard Rules, not just convention.

---

## Foundational (still current) — Docs & tooling: AGENTS.md is canonical, HARD over SOFT

**Decision:** `AGENTS.md` is the one hand-maintained, cross-agent contract; `.agents/` and
`.codex/hooks.json` are generated adapters (via `scripts/sync-agent-workflows.mjs`) and must
never carry an independent copy of workflow logic. Separately, whenever a safety rule matters,
it should be encoded as a hook/test/type-check (HARD, actually blocks bad output) rather than
added as another line of prose (SOFT, just advises and dilutes over time).
**Why:** two competing hand-written rule sets drift out of sync silently; prose rules pile up
and get skimmed past, while a hook can't be forgotten.
**What this forbids/implies:** never hand-edit `.agents/` or `.codex/hooks.json` directly to
add logic — edit the source under `.claude/` and regenerate. When tempted to add a new prose
rule for something that really matters, prefer writing a hook/check instead.

---

## How to add an entry

Append a new entry at the **top** of the decision list (right after this file's header, before
the newest existing entry) whenever Mason makes an irreversible, architectural, or
business-policy call — not for routine bug fixes or ordinary feature work. Use the format:

```
## YYYY-MM-DD — <decision title>

**Decision:** one sentence — what was decided.
**Why:** plain English — the reasoning, in terms a non-coder owner would recognize.
**What this forbids/implies:** the operative rule an agent must follow because of this decision.
```

Keep each entry under ~8 lines total. **Never rewrite or delete a past entry** — if a decision
is later reversed or superseded, add a **new** entry describing the reversal, and reference the
old entry by its date/title (e.g. "Supersedes 2026-06-14 — Prepay earmark engine SHELVED").
Update the "Last verified" date at the top whenever you review this file, even if you add
nothing.
