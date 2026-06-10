# Foundation Ultra Review — Reusable Prompt (Dynamic Multi-Agent Audit)

Run the **foundation ultra review** — an orchestrated, read-only audit that covers the
**blind spots** the other three audit tools never look at, using a *dynamic* agent
pipeline: a recon phase decides what to inspect, a parallel fan-out inspects it, and
findings in one layer trigger targeted deep-dives in another.

This is the "am I safe to build the next 6 months of features on this?" check.
Run it before every major feature-building stretch.

## 0. Mission & non-goals

**Mission:** find latent foundation problems in the four places no other tool checks:

| Layer | Question | Why no other tool covers it |
|-------|----------|------------------------------|
| **A. Live-data integrity** | Are the *rows* in production consistent with the invariants the code assumes? | All prior audits reviewed code/schema, never data. Fixed bugs leave corrupted rows behind. |
| **B. Disk-vs-live drift** | Do the disk migrations actually describe the live database? | B7-class incidents + the 2026-05-29 "vulnerable body was disk-only" episode prove they can diverge. |
| **C. Edge-function bundle drift** | Does each *deployed* Edge Function match `supabase/functions/`? | B8-class — guard in repo, deployed bundle routes elsewhere. |
| **D. Deferred-ledger reconciliation** | Is every "deferred / NOT applied / owner action" claim in CLAUDE.md + docs still accurate? | Stale ledger entries cause double-work and false confidence. |
| **E. Frontend runtime safety** | Route-guard matrix vs roles, error/loading paths, unguarded async races | The layer the 2026-06-09 foundation audit touched lightest. |

**Non-goals (do NOT redo these here):**
- Workflow *correctness* → `/review-workflow`
- Architecture *fragility* (races, SPOFs, double-submit) → `/architecture-weakness-audit`
- Map *consistency* → `/map-drift-audit`
- Per-migration review → `/migration-review` + the 5 reviewer subagents

If recon (Phase 0) shows one of those tools hasn't run since the last substantive
code change, *recommend* running it in the report — don't run it inline.

## 1. Hard rules

1. **Read-only.** The ONLY file you may write is the one dated report. No `Edit` of
   code, no `apply_migration`, no `deploy_edge_function`, no DML. All live SQL must be
   pure SELECT (or EXPLAIN). Never wrap probes in transactions that write.
2. **Every finding carries a hard citation** — `file:line`, a live SQL result, or an
   MCP output. No "probably" findings.
3. **Adversarial verification gate:** every BLOCKER and HIGH must survive an attempt
   to *refute* it against live before it reaches the report (Phase 3). The project's
   audit history is full of refuted scares (`allocate_payment`, `record_payment`,
   the `'void'`/`'voided'` regression test) — assume your first read is wrong.
4. **A clean verdict is valid.** Do not manufacture findings to justify the run.
5. **Real clock for the report date** — never fabricate.
6. **Subagents are read-only too.** Instruct every spawned agent explicitly: no
   writes, no migrations, SELECT-only SQL, return findings with citations.

## 2. Ground-truth sources

- Live DB: Supabase MCP (project `rhyzpcqhnizqbxphqdkr`) — `execute_sql` (SELECT only),
  `list_migrations`, `list_edge_functions`, `get_edge_function`, `get_advisors`
- Repo: `supabase/migrations/`, `supabase/functions/`, `src/`, `src/types/index.ts`
- Ledger: `CLAUDE.md` Current State + Deferred sections, `TODO.md`, `docs/audits/*`
- Registry: `.claude/schema-registry.json`

## 3. Phase 0 — Recon & risk-weighting (orchestrator, no subagents)

Build the target list before spawning anything:

1. `git log --oneline <last-ultra-review-or-last-audit>..HEAD` — what changed since
   the last clean audit? Domains with zero change since their last clean verdict get
   a spot-check, not a deep dive.
2. `get_advisors` (security + performance) — note counts; deltas vs the accepted
   baseline in CLAUDE.md Schema Gotchas (52 anon-SECDEF grant-debt is accepted).
3. `list_migrations` count vs `ls supabase/migrations/*.sql | wc -l` — first drift signal.
4. `list_edge_functions` versions vs the versions recorded in CLAUDE.md.
5. Skim CLAUDE.md "Current State" + "Deferred" + "Pending Mason" for the deferred
   ledger to hand to Agent D.

Output of Phase 0: a short worklist per layer (A–E) with risk weights, plus the exact
deferred-claim list for Agent D.

## 4. Phase 1 — Parallel fan-out (one message, all agents at once)

Spawn ALL of the following in a single message so they run concurrently. Each gets:
the read-only rules, its rubric below, and the instruction to return findings as
`SEVERITY | claim | citation | suggested-next-step`.

### Agent A — Live-data integrity sweep (`general-purpose`)
Run SELECT-only invariant probes against live. Minimum probe set (extend per recon):
- **Money:** any `invoices` where `balance_cents` disagrees with
  `total_cents − amount_paid_cents` semantics; payments/prepay applications referencing
  voided/cancelled invoices; negative `amount_*_cents` outside `credit_memo`;
  `write_offs` on invoices with non-matching balances.
- **AR:** sum of posted-invoice balances vs what `get_ar_aging` / customer statements
  would report (spot-check 3 large customers).
- **Inventory:** negative `quantity_on_hand`/`quantity_available`; `inventory_holds`
  active but linked (via `source_id`) to declined/expired/cancelled/converted quotes;
  holds with no surviving source row; `inventory_transactions` whose running effect
  disagrees with current product quantities for the 5 highest-volume products.
- **Lifecycle orphans:** `delivery_items` whose parent delivery is voided but items
  uncompensated; invoices with neither `order_id` nor `blend_ticket_id` that are not
  `credit_memo`; orders `fulfilled` with zero deliveries; commissions whose
  `commission_split` percentages don't sum to 100; blend tickets in impossible 4-axis
  combos (e.g. `review_status='approved'` while `status!='completed'`;
  `payment_status='billed'` with no surviving linked invoice).
- **Referential strays:** child rows whose parent FK target is gone (only where FKs
  are absent or deferred); `idempotency_keys.result` pointing at entities that don't exist
  (informational).
Severity: corrupted money/AR rows = BLOCKER; corrupted inventory = HIGH;
lifecycle orphans = MED unless money-bearing; informational strays = LOW.

### Agent B — Disk-vs-live drift (`general-purpose`)
- **Version parity:** `list_migrations` vs disk filenames — any live-only or disk-only
  versions (B7 class).
- **Function-body drift:** for every live `public` function (`pg_get_functiondef`),
  find the LATEST disk migration that defines it and compare normalized bodies
  (strip whitespace/comments; md5). Report: live functions with NO disk definition;
  disk-latest ≠ live (note which is newer); identity-argument mismatches (overload drift).
- **CHECK-constraint drift:** live `pg_constraint` (contype='c') values vs the latest
  disk statement of each constraint.
- **Grant drift:** live EXECUTE grants on SECDEF mutators vs what the latest disk
  migrations established (spot-check the strict-actor + REVOKE sets from 2026-06-09).
Severity: live function whose behavior differs from any disk reconstruction = HIGH
(it means a rebuild-from-disk would silently change prod behavior); cosmetic/whitespace = LOW.

### Agent C — Edge-function bundle drift (`general-purpose`)
For each of the 7 functions: `get_edge_function` (deployed source) vs
`supabase/functions/<name>/` on disk. Diff meaningfully (ignore bundler artifacts).
Report per function: IN-SYNC / REPO-AHEAD (committed but not deployed — name the
missing change) / DEPLOYED-AHEAD (live code not in repo — serious) / DIVERGED.
Known expectation: `process-blend-ticket` M3 atomic-claim may be REPO-AHEAD (L1).
Severity: DEPLOYED-AHEAD = HIGH; REPO-AHEAD on a security guard = HIGH; other
REPO-AHEAD = MED.

### Agent D — Deferred-ledger reconciliation (`general-purpose`)
Take the Phase-0 deferred-claim list (CLAUDE.md Current State/Deferred/Pending,
TODO.md, recent `docs/audits/*` "deferred/follow-up" sections). For each claim,
verify its CURRENT truth against live/repo/git: still open? silently fixed? worse
than recorded? Output a reconciled ledger table: `claim | recorded status | verified
status | evidence`. Severity: a "deferred-as-LOW" item that verification shows is
actually exploitable/broken = escalate to its true severity; stale-but-harmless
ledger entries = LOW (doc fix).

### Agent E — Frontend runtime safety (`general-purpose`)
- **Route-guard matrix:** every `<Route>` in `App.tsx` × `allowedRoles` vs the
  CLAUDE.md role rules (month-end/commissions/settings admin-only; `/payments`
  admin+sales_rep). Flag any route whose page mutates data but has no role guard.
- **Error paths:** RPC callsites missing `assertRpcResult`; mutations missing
  `checkMutationResult`; catch blocks that swallow errors without toast/Sentry.
- **Async races:** unguarded `useEffect` fetches without cancellation/staleness
  guards on pages with rapid param changes; double-submit surfaces lacking
  `useIdempotencyKey` on money-mutating buttons.
- Sample deeply rather than skim everything: the 10 money-heaviest pages first.
Severity: missing role guard on a mutating page = HIGH; swallowed money-path error = MED.

### Delta reviewers (conditional)
If Phase 0 found code/migration changes since the last clean audit, also dispatch the
relevant standing reviewers (`rls-security-reviewer`, `migration-drift-reviewer`,
`typescript-types-drift-reviewer`, `compliance-reviewer`, `pdf-output-reviewer`)
scoped ONLY to the delta. Skip any with an empty scope.

## 5. Phase 2 — Dynamic escalation (the "dynamic" part)

After Phase 1 returns, the orchestrator decides what to spawn next. Rules:

- **Data anomaly → causal trace.** Agent A finds bad rows ⇒ spawn a deep-dive agent
  to identify which RPC/trigger produced them (git/migration archaeology + live fn
  body) and whether the producer is still buggy or the rows are historical residue.
  The fix class differs (code fix + data repair vs data repair only) — the report
  must say which.
- **Drift → blast radius.** Agent B finds a live≠disk function ⇒ spawn an agent to
  determine which is *correct* (live often is — post-MCP-apply renames) and what a
  naive rebuild-from-disk would break.
- **REPO-AHEAD guard → exposure check.** Agent C finds an undeployed security change
  ⇒ spawn an agent to test (read-only) whether the live gap is exploitable now.
- **Ledger escalation → full verification.** Agent D escalates a deferred item ⇒
  treat it as a new Phase-1 finding and verify per Phase 3.
- Cap: max 2 escalation waves. If wave 2 still spawns new threads, record them as
  explicit "unverified leads" in the report rather than recursing.

## 6. Phase 3 — Adversarial verification gate

Every BLOCKER/HIGH from any phase goes to a FRESH agent (or the orchestrator with
fresh eyes) whose explicit job is to **refute** it: re-run the probe independently,
check for an exempting pattern (admin_override, accepted-finding list in CLAUDE.md
Schema Gotchas, regression-test fixtures, `[E2E]` data), and confirm the cited
evidence reproduces. Findings that fail verification are listed in a "Refuted"
appendix with the refutation — that appendix is as valuable as the findings.
`[E2E]`-prefixed rows are test data — exclude from data-integrity findings.

## 7. Phase 4 — Synthesis & report

Write ONE file: `docs/audits/<YYYY-MM-DD>-foundation-ultra-review.md` containing:

1. **Verdict:** `SOLID` / `SOLID-WITH-FOLLOWUPS` / `NEEDS-WORK` (any BLOCKER ⇒ NEEDS-WORK)
2. **Counts** by severity, per layer A–E
3. **Findings** — each: severity, layer, claim, citation, verified-by, suggested fix
   route (`/ship` job description for each actionable finding)
4. **Refuted appendix** (Phase 3 kills)
5. **Reconciled deferred ledger** (Agent D's table — this replaces stale claims)
6. **Escalation trace** — what Phase 2 spawned and why (audit of the audit)
7. **Unverified leads** (if the wave cap hit)

### Severity rubric
- **BLOCKER** — corrupted money/AR data; deployed-ahead edge code; live function whose
  behavior contradicts both disk and documented intent; exploitable gap reachable now
- **HIGH** — corrupted inventory data; live≠disk on a money/security function;
  undeployed security guard; missing role guard on a mutating page
- **MED** — lifecycle orphans; non-security repo-ahead drift; swallowed money errors
- **LOW** — stale ledger entries; cosmetic drift; informational strays

## 8. After the report

Give Mason a 5-line summary: verdict, counts, the single most dangerous finding (or
"solid"), whether any finding blocks feature work, and the suggested next step.
Remind him nothing was changed (read-only). For NEEDS-WORK: remediation goes through
`/ship` one finding at a time, and a `/codex-cross-review` packet should be drafted
for the batch (the Codex round-trip has caught real misses in every prior cycle).
