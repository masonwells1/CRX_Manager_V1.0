# Architecture-Weakness Audit — Reusable Prompt

> **What this is (plain English):** A reusable instruction set that walks **every connection** in the
> app-workflow-map (`docs/app-workflow-map.html` — read the live NODES/EDGES arrays for the exact, current worklist; counts drift as the app grows) and judges each
> one for **fragility**, not correctness. For every connection and node it asks: *what breaks if this
> fails, gets called twice, two people hit it at once, or it's left half-finished — and is there a
> guard or recovery path?* It hunts single points of failure, double-submit gaps, silent failures,
> race conditions, non-atomic flows, missing reversals, and missing defensive wiring.
>
> **How to run it:** Start a fresh Claude Code session and say:
> *"Run the architecture-weakness audit — follow `docs/audits/architecture-weakness-audit-prompt.md`."*
>
> **What you get back:** A dated, read-only findings report at
> `docs/audits/<YYYY-MM-DD>-architecture-weakness-audit.md`, ranked BLOCKER / HIGH / MED, every finding
> backed by a real citation (file:line, RPC name + body excerpt, constraint) and verified against the
> live DB before it's allowed in. **Nothing is changed** — you review and decide what to harden.
>
> **How it relates to your other two tools — READ THIS, it's the whole point:**
> - **`/map-drift-audit`** checks *consistency* — does the map match reality?
> - **`/review-workflow`** checks *correctness* — does the workflow logic have bugs / can an entity get stranded?
> - **This** checks *robustness* — even when the map matches reality AND the logic is correct, is the
>   architecture **resilient**? A connection can be perfectly accurate and perfectly correct and still
>   be **fragile** (no idempotency, no error handling, a race, a missing reversal). That fragility is
>   what this audit owns. **Do not re-run drift detection or generic bug-hunting here** — those have homes.

---

## 0. Mission & non-goals

**Mission:** Treat the map's full NODES/EDGES arrays as an exhaustive worklist. For each, ask the
**weakness questions** below and report every connection/node whose failure, double-invocation,
concurrency, or partial completion is **unguarded**.

The weakness lens, in one sentence per connection: **"If this breaks, runs twice, races another caller,
or dies halfway — what's the damage, and what stops it?"**

**Non-goals (do NOT do these here — they belong elsewhere):**
- **Consistency / drift** (map vs live, missing/renamed RPCs, status-vs-CHECK) → that's `/map-drift-audit`.
- **Generic correctness bugs / can-an-entity-get-stranded** → that's `/review-workflow`.
- **Pure security** (RLS bypass, anon-SECDEF, actor forgery) → that's the `rls-security-reviewer`
  subagent. You MAY note a robustness-relevant security weakness, but defer the deep security sweep.
- **Editing anything.** Read-only. Findings only — hardening is a separate, human-approved step.
- **Manufacturing findings.** A clean/short result is valid. The project has been burned more by
  confident-but-wrong findings than by missed ones — prefer a true short list over a padded one.

---

## 1. Hard rules

1. **Read-only.** Allowed: `Read`, `Grep`, `Glob`, Supabase MCP **read** tools (`execute_sql` with
   `SELECT`/catalog queries only, `list_tables`, `get_advisors`). **Forbidden:** `apply_migration`, any
   `INSERT/UPDATE/DELETE/DDL`, `Edit`, `Write` (except the single final report file), `deploy_edge_function`.
2. **Every finding describes a concrete failure scenario.** Not "this could be more robust" — instead
   "if two reps click *Post* on invoice X within the same second, both inserts succeed because
   `post_invoice` has no idempotency and no status-guard, producing two `financial_audit_log` rows."
   A finding with no concrete failure path does not belong in the report.
3. **Verify before you report.** Read the actual RPC body / callsite that proves the gap. Quote it. If
   you can't confirm the weakness is real read-only, it goes in "Unconfirmed / needs human check."
4. **Cite everything.** `file:line`, RPC `proname` + body excerpt, trigger name, or constraint. No citation → not a finding.
5. **Live DB is the truth.** Read function bodies from `pg_proc.prosrc`, not from migration files
   (which can be superseded). Project ID `rhyzpcqhnizqbxphqdkr`, `public` schema.
6. **Single-statement SQL.** Supabase MCP `execute_sql` returns only the LAST statement's rows.

---

## 2. Ground-truth sources

| Source | How | Tells you |
|--------|-----|-----------|
| The worklist | `Read docs/app-workflow-map.html` — `NODES` (`// __NODES_START__`) + `EDGES` (`// __EDGES_START__`) arrays | Every node + every connection to walk; edge `type` = nav / rpc / data |
| RPC bodies | `execute_sql` on `pg_proc` (queries in §3) | Idempotency usage, status-guards, audit-log writes, transaction shape, `SET search_path` |
| RPC signatures | `pg_get_function_arguments` | Whether a mutating RPC even accepts `p_idempotency_key` |
| Callsite robustness | `Grep` over `src/` for `.rpc(` / `.from().update(` + `assertRpcResult` / `checkMutationResult` / `useIdempotencyKey` / `toast` | Whether a connection's failure is surfaced or swallowed; whether the button is double-submit-guarded |
| Triggers | `execute_sql` on `pg_trigger` / `information_schema.triggers` | Whether atomic side-effects (holds release, audit rows) ride a trigger vs. app code |
| Money tables / audit sink | `list_tables`, `pg_proc.prosrc ILIKE '%financial_audit_log%'` | Which mutations are connected to the audit trail and which aren't |

> Optional accelerator: dispatch independent passes as parallel subagents if it helps — but this audit
> must be completable in one session. Keep the raw evidence in your own context so the report is grounded.

---

## 3. Snapshot queries (run once, cache for all passes)

```sql
-- A. Every public function: body + signature + key robustness signals, in one pass.
SELECT p.proname,
       pg_get_function_arguments(p.oid)                         AS args,
       (p.prosrc ILIKE '%idempotency_key%')                     AS uses_idempotency,
       (p.prosrc ILIKE '%financial_audit_log%')                 AS writes_audit_log,
       (p.prosrc ~* 'status\s*(=|<>|!=|IN|NOT IN)')             AS has_status_guard,
       (p.prosrc ILIKE '%FOR UPDATE%')                          AS uses_row_lock,
       p.prosecdef,
       length(p.prosrc)                                         AS body_len
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
ORDER BY p.proname;
```

```sql
-- B. Which functions mutate (candidate weak points) vs. read-only (lower stakes for most passes).
SELECT proname,
       (prosrc ~* '\m(INSERT|UPDATE|DELETE)\M') AS mutates
FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY proname;
```

Then, from the map's `EDGES` array, compute **fan-in per node** (count edges where the node is the
target `t`) and **fan-out per node** (source `s`). High fan-in = many connections depend on it = SPOF candidate.

---

## 4. The weakness passes

Walk these in order. For each item: **extract from the worklist → verify against the live body/callsite
→ classify**. Track "checked & robust" so a clean pass proves coverage.

### Pass 1 — Single points of failure (node-level)
Rank nodes by fan-in (Pass 3 snapshot). For the highest-fan-in RPC groups, entities, and shared
dependencies, ask: *if this one node misbehaves, how wide is the blast radius, and is there any
fallback / retry / guard?* CRX hot spots to check explicitly:
- `check_period_open()` — gates every post; if it wrongly rejects, all posting stops.
- `post_invoice` / `next_invoice_number` / invoice sequences — funnel for all AR.
- The idempotency helpers (`check_idempotency` / `save_idempotency`) — if they fail, every guarded RPC degrades.
- `financial_audit_log` — single audit sink; what happens to a mutation if its audit insert fails?
- `auth.uid()` actor derivation; the single `src/lib/db.ts` client.
A high-fan-in node with **no failure isolation** is a HIGH (or BLOCKER if its failure corrupts money/state).

### Pass 2 — Double-submit fragility (idempotency)
For **every page→RPC connection whose RPC mutates** (snapshot A `uses_idempotency=false` + snapshot B
`mutates=true`): a button that fires a money/state mutation with no working idempotency is fragile
(double-click / retry / offline-replay → duplicate effect). Confirm BOTH sides:
- RPC body actually reads+writes `idempotency_keys` (declaring `p_idempotency_key` but ignoring it is the
  worst case — looks safe, isn't; the project's `idempotency-body-check` hook exists for exactly this).
- The calling page passes a key via `useIdempotencyKey`.
A money-mutating connection unguarded on either side → **BLOCKER**; a non-money state mutation → HIGH.

### Pass 3 — Silent-failure fragility
For **every page→RPC and page→table-write connection**: is the result checked (`assertRpcResult` /
`checkMutationResult`) and the failure surfaced to the user (toast / error UI)? A connection that can
fail while the UI reports success is fragile (the user re-tries or assumes done → data divergence).
The repo enforces this via ESLint + a safety-net test, so expect high coverage — **flag only the genuine
gaps** (e.g. a fire-and-forget `.rpc()` whose error is dropped). Cite the exact callsite.

### Pass 4 — Concurrency / race fragility
For connections where two actors can hit the **same entity** at once — complete the same delivery, post
or void the same invoice, allocate the same payment, receive the same PO line, approve the same blend
ticket, apply the same prepayment — is there a **status-transition guard** that rejects the second actor
(snapshot A `has_status_guard`), a row lock (`uses_row_lock`), or idempotency? A two-actor connection
with none of these → HIGH (BLOCKER if the double-action duplicates money or inventory).

### Pass 5 — Atomicity / partial-failure fragility
For **data-flow connections that do several writes** (one action touching multiple entities) — e.g.
`convert_quote_to_order` (order + hold release + commissions), `complete_delivery` (status + inventory
txn + invoice link), `create_quick_delivery` (order + delivery + draft invoice) — confirm they run as a
**single atomic unit** (one SQL function / one transaction). A multi-write flow that can fail halfway and
leave partial state (order with no commissions; delivery completed but inventory not moved) is fragile.
Most CRX mutations are single `plpgsql` functions (atomic by default) — **flag the exceptions**: app-side
multi-step sequences in `src/` that fire several `.rpc()`/writes without a server-side transaction.

### Pass 6 — Missing reversal / compensation connections
For each **forward** connection (create / post / issue / apply / link), confirm a **reverse** exists
(void / cancel / reverse / unapply / unlink) AND that the reverse fully unwinds the *downstream*
connections. The classic weaknesses to check:
- void invoice → do its `commissions` move off `pending`? does it reverse `prepay_applications`?
- void payment → is the allocation reversed and the invoice balance restored?
- cancel order / quote → are `inventory_holds` released? (the documented quote-cancel-hold fix is the pattern)
- void delivery → is the inventory transaction reversed?
A missing or partial reversal = a **missing connection + a real weakness** (state strands when the happy path is undone).

### Pass 7 — Missing defensive connections (resilience gaps)
Connections the architecture *should* have for robustness but doesn't:
- A money/state mutation **not connected to `financial_audit_log`** (snapshot A `writes_audit_log=false`
  among money RPCs) — no forensic trail when it goes wrong.
- An entity/flow with **no reconciliation/repair path** (the app has `reconcile_*` RPCs — which critical
  entities lack one?).
- A critical mutating RPC with **no idempotency** that *should* have it (overlaps Pass 2 — report once).
- A high-value flow with **no error-recovery/retry** connection (e.g. an Edge-Function call with no
  fallback when the function is down).
Severity by money/data blast radius.

---

## 5. Adversarial verification gate (every BLOCKER & HIGH)

Before a BLOCKER/HIGH is written, **try to refute it**:
- Re-read the exact body/callsite. Is there a guard you missed — a trigger that enforces atomicity, a
  status CHECK that blocks the race, an `app.admin_override` hatch, a UI-level disable-on-submit, an
  `INTERNAL_RPCS` exemption, a documented accepted-risk note in `CLAUDE.md`?
- Construct the **concrete failure sequence**. If you can't write a plausible "two clicks / two users /
  fails here" story that actually causes damage, it's not a real weakness — drop it.
- Survives only if you cannot refute it. Under 80% confident → "Unconfirmed / needs human check."

This gate is the point: a fragility finding that turns out to have a guard you didn't see is noise.

---

## 6. Severity rubric

| Severity | Meaning | Example |
|----------|---------|---------|
| **BLOCKER** | A realistic failure/double-call/race **corrupts money or state, or causes an outage** | Money-mutating RPC reachable from a button with no idempotency + no status-guard → duplicate `financial_audit_log` rows on a double-click |
| **HIGH** | Real fragility → wrong behavior under a plausible condition, not corruption | Two-user race on a non-money status with no guard; a silent-failure callsite that hides a real error |
| **MED** | Robustness gap masked today but risky | Missing reversal that's rarely exercised; a SPOF with no fallback but currently reliable; a mutation missing its audit-log connection |

---

## 7. Output — the report file

Write **one** file: `docs/audits/<YYYY-MM-DD>-architecture-weakness-audit.md` (real date — read the clock,
e.g. `(Get-Date).ToString("yyyy-MM-dd")`; never fabricate). Nothing else is written or changed.

```markdown
# Architecture-Weakness Audit — <YYYY-MM-DD>

**Map worklist:** <N nodes / N edges> (nav <n> · rpc <n> · data <n>)
**Live snapshot:** <N public funcs, N mutating, N missing idempotency, N missing audit-log, N with status-guard>
**Verdict:** <ROBUST | N findings (B BLOCKER / H HIGH / M MED) + U unconfirmed>

## Top single points of failure (by fan-in)
| Node | Fan-in | Blast radius if it fails | Guard / fallback? |
|------|--------|--------------------------|-------------------|

## Summary
| Pass | Connections/nodes checked | Robust | Findings |
|------|---------------------------|--------|----------|
| 1 SPOFs | … | … | … |
| 2 Double-submit | … | … | … |
| 3 Silent failure | … | … | … |
| 4 Race | … | … | … |
| 5 Atomicity | … | … | … |
| 6 Missing reversal | … | … | … |
| 7 Missing defenses | … | … | … |

## Findings (ranked)
### [BLOCKER] <id> — <title>
- **Pass / connection:** <which connection or node>
- **Concrete failure scenario:** <the two-clicks / two-users / fails-here story>
- **Evidence:** <file:line / proname + body excerpt / trigger / constraint>
- **Why it's unguarded:** <the guard that's absent>
- **Verification performed:** <the body/callsite read that confirmed it, quoted>
- **Suggested hardening (NOT applied):** <pointer — e.g. "add idempotency via check/save_idempotency", not a patch>

### [HIGH] … ### [MED] …

## Unconfirmed / needs human check
- <candidate> — <why it couldn't be confirmed read-only>

## Coverage note
<What was walked and found robust — so a clean verdict proves work. State honestly what deep
transactional/timing reasoning could not be fully settled read-only.>
```

---

## 8. Close-out (in chat, after writing the report)

Give Mason a 5-line summary: verdict, counts by severity, the single most dangerous weakness (or
"robust"), and the suggested next step (e.g. "harden the top BLOCKER on its own branch"). Remind him
**nothing was changed** — read-only — and that hardening is a separate, approved step. If the top
finding is a money double-submit or a missing reversal, say so plainly: those are the ones that bite.
