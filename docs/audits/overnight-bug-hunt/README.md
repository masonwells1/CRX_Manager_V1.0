# CRX Overnight Bug Hunt

A self-sustaining, **Codex-gated** find→fix→re-review loop. It hunts the **8 recurring bug
classes** (distilled from ~90 fix commits in the last 20 days) across the **billing engine
first**, then the whole app — and lands safe fixes on a throwaway branch while Mason sleeps.
**It never touches production.**

The immense successor to `nightly-debug`. The upgrade Mason asked for: **Codex independently
re-reviews EVERY finding and EVERY fix before anything is applied** — not just the risky ones.

Branch: `claude/overnight-bug-hunt` (based on `main`). Run dir: this folder.

## The two Codex gates (the whole point)

1. **Finding-gate** — after Claude's own adversarial verification, the verified findings go to
   Codex (`codex exec`, read-only, gpt-5.5 — a different vendor/model) to independently confirm
   each is a REAL bug. Nothing proceeds on a finding Codex won't confirm.
2. **Fix-gate** — after a fix is drafted and staged, the actual diff goes to Codex to review
   before it is committed. No change is committed until Codex blesses that specific diff
   (hard cap 3 rounds; still-NEEDS-WORK → revert + re-tier to parked).

## The 8 bug classes it hunts

1. Idempotency (wrong cols / unscoped / declared-but-ignored / missing)
2. Forgeable actor (trusts `p_performed_by` without binding `auth.uid()` + `ACTOR_MISMATCH`)
3. Money-cents (float on `*_cents`, dollars↔cents mixups, penny-drift in splits, writing GENERATED `balance_cents`)
4. Concurrency (read-modify-write with no `FOR UPDATE` on inventory/holds/balances)
5. Stale derived state (edit recomputes one total, leaves profit/margin/commissions/`total_cost_cents` stale)
6. Lifecycle / segregation (status outside live CHECK, unenforced transitions, invoice-type leaks, edit-lock bypass)
7. Unchecked errors / type-guards (missing `checkMutationResult`/`assertRpcResult`, ignored `{error}`, blank-throw pages)
8. Audit-log completeness (money mutator that skips its `financial_audit_log` row)

## Safety model — 3 tiers (NEVER touches prod)

| Tier | What | Overnight action |
|---|---|---|
| 🟢 Green | frontend-only / docs / test — reversible | After both Codex gates + typecheck/build/test → **commit to `claude/overnight-bug-hunt`** |
| 🟡 Yellow | migration / edge-fn | Draft + rolled-back-validate vs live (zero prod footprint) + Codex note → **park for Mason** |
| 🔴 Red | push / deploy / live-apply / data delete | **Never autonomous** — waits for Mason |

## Scope order (Mason's choice, 2026-06-19)

- **Phase 1 — billing engine first:** invoices · jobs→billing · field/app invoices · commissions · deliveries · prepay+blend · splits/shares/allocation.
- **Phase 2 — broad sweep:** RLS/security · migration-drift · types-drift · frontend-safety · lifecycle · edge-fns+PDFs · docs/deps/tests.

## State files

- `LEDGER.json` — every finding ever seen, with `dedupeKey`, tier, status, cycle history.
- `REPORT.md` — the human-readable running report Mason reads in the morning.
- `accepted-findings.json` — known-accepted + already-fixed dedupeKeys; the noise filter so only NEW issues surface.
- `PHASE-PLAN.md` — the subsystem queue and what's been drained.

## How to start it

Tell Claude: **"start the overnight bug hunt."** (Or, to make it self-pace all night without
re-prompting: `/loop start the overnight bug hunt`.) It runs cycle 1 now, then schedules each
next cycle itself.

## How to stop it

Tell Claude **"stop the bug hunt."** (It also self-stops after 3 dry cycles or in the morning.)
Nothing it did needs rolling back — every green fix is a local commit on a non-prod branch.

## How to read results in the morning

Open `REPORT.md`. Per cycle: what was found, what was **auto-fixed** (green — already committed,
Codex-blessed, green toolchain) and what's **parked** (yellow — plain-English explanation +
validation proof + Codex note). Approve the parked items you want; I'll ship them via `/ship`.
One `git merge claude/overnight-bug-hunt` (or cherry-pick) lands the green fixes you like.
