Run a full, widespread review of CRX Manager's workflow logic, page/RPC connections, entity lifecycles, and cross-entity business flows — anchored on the workflow map at `docs/app-workflow-map.html` but NEVER trusting it. This is the "is my foundation solid enough to build the next feature on?" check. It is **read-only**: it analyzes and writes ONE report file. It does not edit code, apply migrations, deploy, or commit.

## The one rule that overrides everything

**Verify every finding against the actual source code and the live Supabase database before it goes in the report.** Do not trust:
- the auto-detected problems in the workflow map (they come from shallow regex grep),
- the lifecycle claims in `CLAUDE.md`,
- prior audit docs in `docs/audits/`,
- or the verification note already inside the HTML.

The map's own "Verification Note (2026-05-20)" documents that a previous grep-heuristic pass asserted ~6 problems that were all FALSE once someone read the code (Returns "broken" — false; /notifications "orphan" — false; "drop get_field_geojson" — would have caused an outage). Treat every flag as a *lead to confirm by reading the code/DB*, never as a fact. A finding with no `file:line` or migration/constraint citation does not belong in the report.

Lead with **recommendations**, not just lists — for every real issue, say what you'd do about it and why.

## Step 0 — Refresh ground truth (do these in parallel)

```bash
npm run generate-map
git status --short
```

- `npm run generate-map` rewrites `docs/app-workflow-map.html` from the current code so the graph + auto-detected problems reflect HEAD, not a stale commit. Capture the console output (route count, RPC-call count, problem count).
- Note: `.agents/`, `.codex/`, and `scripts/generate-workflow-map.mjs` are intentionally untracked — do NOT flag them.

Then read, for grounding (not as truth):
- `docs/app-workflow-map.html` — the regenerated graph data (`NODES`/`EDGES` arrays), the 8 lifecycle SVGs, and the auto-detected problems section.
- `.claude/schema-registry.json` — the cached schema (status enums, generated columns, tables, RLS). If it's >7 days old, say so; prefer the live DB over it.
- `CLAUDE.md` Business Logic Lifecycles + Schema Gotchas + the "Tables WITHOUT updated_at" list.

## Step 1 — Dispatch the four review layers IN PARALLEL

Send all four `Agent` calls in a single message so they run concurrently. Each agent must (a) read actual code, (b) query the live DB via Supabase MCP where stated, (c) return findings with `file:line` or constraint/migration citations, and (d) explicitly separate "verified real" from "looked suspicious but checked out fine." Give each agent the regenerated map data and the relevant reference docs (`docs/reference/database-schema.md`, `rpc-functions.md`, `pages-routes.md`).

### Layer A — Graph & connection integrity (subagent: Explore or general-purpose)
For the current codebase, verify:
- **Orphan pages** — for each route in `App.tsx` not reachable via sidebar, `navigate()`, `<Link to>`, nav-config `path:` arrays, or a mounted panel, confirm by reading code whether it's truly unreachable. Remember `/customers/new` resolves to `/customers/:id`, header-bell panels navigate from TopBar, and FinancialDashboard uses an array-config menu. Only report genuine orphans.
- **Broken navigation** — every `navigate('/literal')` resolves to a real Route (account for `:param` patterns).
- **Dead RPCs** — every RPC in `docs/reference/rpc-functions.md` is either called from `src/` OR is a legitimate trigger/cron/internal helper (the generator's `INTERNAL_RPCS` set lists the known-internal ones). Before calling any RPC "dead," grep `src/` for it — `get_field_geojson` was wrongly flagged before.
- **Page→RPC wiring** — for each major workflow page, confirm it actually wires the RPCs its lifecycle needs (e.g., a returns page must call approve/receive/issue_credit/cancel, each with idempotency + `assertRpcResult`).
- **Role gating** — admin-only pages (`month-end`, `commissions`, `settings`) are not reachable by `sales_rep`; `/payments` is intentionally admin+sales (do NOT flag that as a bug).

### Layer B — Lifecycle / state-machine integrity (subagent: general-purpose, uses Supabase MCP)
For each entity — **Quote, Order, Delivery, Invoice, Job, PurchaseOrder, Return, BlendTicket, Commission, CommissionPayment** — do a 4-way reconciliation:
1. **Live CHECK constraint** — query the actual allowed status values: `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = '<table>'::regclass AND contype = 'c';`
2. **CLAUDE.md lifecycle** — the documented `a → b → c` chain.
3. **Map SVG** — the diagram in `docs/app-workflow-map.html`.
4. **Actual transition RPCs** — which statuses the RPCs actually move between.

Flag where these four disagree. Specifically hunt for:
- **Ghost states** — a status set in code/RPC that isn't in the live CHECK (would crash). 
- **Orphan states** — a status in the CHECK that no RPC transitions into or out of (dead-end / unreachable).
- **Undocumented lifecycles** — e.g. `commission_payments` (unposted→posted→voided) was already noted as missing from CLAUDE.md; confirm it's still missing and check for others.
- **Status string drift** — `'void'` vs `'voided'`, `'pending'` vs `'requested'` (returns) — the exact class of bug the hooks guard.

### Layer C — Cross-entity flow integrity (subagent: general-purpose)
Trace the end-to-end chains by reading the conversion RPCs and confirming nothing leaves an entity stranded:
- **Quote → Order** (`convert_quote_to_order`): holds released, items copied, `source_id` linked, `is_planned` reservations resolved.
- **Order → Delivery** (`confirm_delivery`/`complete_delivery`): items locked after `scheduled`, inventory deducted on complete, `complete_delivery` requires `p_signed_by`.
- **Order/Delivery/Blend → Invoice**: invoice must have `order_id` OR `blend_ticket_id`; `balance_cents` is the GENERATED single source of AR truth.
- **Invoice → Payment**: allocation + prepay application update balance; `post_invoice` enforces `check_period_open`.
- **Order → Commission**: per-recipient records created; `commission_split` sums to 100%; entity recipients (CMCTW, Crop Rx) wired.
- **PO → Inventory** (receive) and **Return → Inventory** (restock/credit): transaction types correct, ledger immutable.
- **Blend ticket → Order/Invoice/Application record**: OCR path produces a linked entity, not a dangling row.
For each chain, answer: *can an entity get permanently stuck?* (a state with no exit, a hold never released, a created-but-never-linked row, a reversal path that's missing).

### Layer D — Business-logic invariant sweep (subagent: general-purpose, uses Supabase MCP)
Confirm the invariants that make the workflow safe to extend:
- **Money** — no `parseFloat`/float math on `*_cents`; money stored as `bigint` cents.
- **RLS** — every table has RLS enabled + at least one policy (cross-check live `pg_policies` against `list_tables`). Note the one intentional exception: `profile_public_view` SECURITY DEFINER semantics.
- **Idempotency** — every mutating RPC accepts `p_idempotency_key` and actually reads/writes `idempotency_keys` (columns `idempotency_key`/`operation`/`result`).
- **SECURITY DEFINER** — every such function has `SET search_path`.
- **Immutability** — `inventory_transactions` (UPDATE+DELETE blocked) and `financial_audit_log` (append-only) still enforced.
- **No function-overload collisions** — `SELECT proname, count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace GROUP BY proname HAVING count(*)>1;` should be empty.
- **Supabase advisors** — run `get_advisors` for security + performance; fold any NEW findings in.
- **updated_at** — no UPDATE references `updated_at` on the tables that lack it.

## Step 2 — Synthesize

Collect the four reports. De-duplicate. For each finding, assign severity:
- **BLOCKER** — data-loss, money-correctness, security/RLS bypass, or a workflow that can strand an entity. Fix before building anything new.
- **HIGH** — real bug or a missing transition that will bite a real user, but with a workaround.
- **MED** — drift, inconsistency, or a gap that's safe today but will cause confusion as you extend.
- **LOW** — docs/cosmetic.

Discard any finding the agents could not confirm against code/DB. Keep a record of disproven leads — they go in the "Verified safe" section.

## Step 3 — Write the report

Write to `docs/audits/<YYYY-MM-DD>-workflow-review.md` with this structure:

```markdown
# Workflow & Business-Logic Review — <YYYY-MM-DD>

## Verdict
<One paragraph: is the foundation solid enough to add features on? If not, what's the single thing to fix first?>

## Scope
Routes: <N> · RPC calls: <N> · Tables: <N> · Lifecycles checked: 10
Method: regenerated map + read live source + queried live Supabase. Every finding cited.

## Findings

### 🛑 BLOCKER (<n>)
- **<title>** — <what & where: file:line / migration / constraint>. Why it matters: <…>. **Recommendation:** <fix>. Confidence: <high/med>.

### 🔴 HIGH (<n>)
### 🟡 MED (<n>)
### ⚪ LOW (<n>)

## Lifecycle reconciliation table
| Entity | Live CHECK | CLAUDE.md | Map SVG | RPC transitions | Agree? |
|--------|-----------|-----------|---------|-----------------|--------|
<one row per entity; mark mismatches>

## Cross-entity flow status
<Quote→Order→Delivery→Invoice→Payment, +Commission/PO/Return/Blend — OK / where it can stall>

## Verified safe (leads checked, found correct)
<Document disproven flags so the next review doesn't re-chase them — mirror the HTML's existing note.>

## Before you add features — prioritized punch list
1. <highest-leverage fix>
2. …
```

## Step 4 — Report verdict to Mason (compact)

In chat, print only:
- the one-paragraph verdict,
- counts by severity,
- the top 3 punch-list items,
- the report path.

Keep full detail in the file, not the chat.

## Step 5 — Offer Codex cross-review (do not auto-run)

If there are any BLOCKER or HIGH findings, offer to run `/codex-cross-review` on them so a second LLM independently validates before Mason acts (per his standing preference that major findings get a Codex pass). Wait for his go-ahead.

## Hard rules
- **Read-only.** No `Edit`/`Write` except the one report file. No `apply_migration`, no deploy, no `git commit`.
- **Cite or cut.** Any finding without a `file:line`, migration name, or constraint name gets dropped.
- **Parallel dispatch.** Step 1's four agents go in ONE message.
- **Recommend, don't just list.** Every real finding carries a recommended fix.
- **Trust nothing pre-written.** Map, CLAUDE.md, and prior audits are leads, not facts — confirm against live code + DB.
