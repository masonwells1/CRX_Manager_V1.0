# Full-Codebase Review Plan — CRX Manager V1.0

**Date:** 2026-05-28
**Author:** Claude Code (grounded pass before planning)
**Goal:** Establish a strong, verified foundation before adding more features. "No stone unturned."
**Mode of this document:** A prioritized, copy-paste-ready review plan. Each domain below has (a) what to look for, (b) why it matters in plain English, (c) how to run it, and (d) a ready-to-use prompt.

> This plan is **grounded**, not generic. Before writing it, I ran your real build/lint/type/test toolchain, pulled the live Supabase advisors, compared disk migrations to the live database, and surveyed file sizes. The findings below are facts I observed on 2026-05-28, not guesses.

---

## 0. Reality Check (read this first)

You said "we have a lot of errors." Here is what is **actually** true as of 2026-05-28:

### ✅ Verified clean (don't waste review effort here)
| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | **0 errors** |
| ESLint | `npm run lint` | **0 errors** |
| Production build | `npm run build` | **Succeeds** (one bundle-size *warning* on the 1.68 MB Mapbox chunk — not an error) |
| Unit tests | `npm run test` | **All pass** (exit 0; 130 test files / ~1,918 tests) |
| Doc counts | grep vs `CLAUDE.md` | **Accurate** — 66 pages, 356 migration files, 130 test files, 94 E2E specs all match |
| Supabase performance advisor | live | **0 WARN / 0 ERROR** (148 INFO "unused index" only — mostly preemptive FK indexes, harmless) |

**Takeaway:** Your compile-time foundation is *green*. The "errors" you feel are **not** broken builds or red TypeScript. They are one or more of: (1) **runtime bugs hitting real users** (Sentry — not yet triaged), (2) **structural fragility** from oversized files, and (3) **drift between what's live and what's in the repo**. That reframes the whole review — and it's a much more tractable problem than "everything is broken."

### 🟥 Concrete cracks found during this grounding pass (your head start)
These are real, verified findings — the review starts here, not from zero:

1. **Live database is ahead of the repo (migration drift).** The live DB contains a migration `20260528042000` named `20260528000001_preserve_quote_price_overrides` that **has no `.sql` file on disk**. Your repo *cannot rebuild your live database* — which directly undermines the still-pending Phase 4 restore drill and violates Architecture Rule #1 ("database changes = migrations only, files in `supabase/migrations/`"). **This is the single most important thing to fix.**

2. **89 SECURITY DEFINER functions are still executable by `anon` (public).** The 2026-05-25 ultra review found 215 such functions and flagged them P0 (anon can bypass RLS). Remediation has knocked that down to 89 — real progress — but 89 remain un-dispositioned. Each needs a yes/no answer: *should the public internet really be able to call this?*

3. **One accepted security ERROR** — `profile_public_view` (SECURITY DEFINER view). This is **documented as intentional** in CLAUDE.md. Leave it; just confirm it hasn't changed.

4. **Leaked-password protection is disabled** (Supabase auth advisor). One-click toggle in the dashboard. Trivial win.

5. **A dozen oversized components** are the source of the "feels fragile" intuition — any edit risks side effects:
   - `QuoteBuilder.tsx` — 2,616 lines
   - `src/types/index.ts` — 2,557 lines
   - `DeliveryDetail.tsx` — 2,433 lines
   - `BlendTicketDetail.tsx` — 1,707 · `OrderDetail.tsx` — 1,588 · `InventoryPage.tsx` — 1,562 · `TeamBoard.tsx` — 1,500 · `CustomerDetail.tsx` — 1,497 · `InvoiceDetail.tsx` — 1,415 · `Deliveries.tsx` — 1,312 · `PurchaseOrderDetail.tsx` — 1,242 (and more over 1,000).

6. **Production error triage is a blind spot.** No Sentry MCP is connected in the current session, so live runtime errors haven't been pulled. This is the #1 thing to do (see Domain D1) because it's the only place "real users hitting bugs" actually shows up.

### Note on the prior review
A thorough `2026-05-25-full-codebase-ultra-review.md` already exists and is excellent prior art. **Do not treat its findings as still-current** — remediation has partially landed (anon-SECDEF dropped 215 → 89), so several of its P0/P1 claims are now partly closed. Re-verify against *today's* live state, don't re-fix what's already done. (This matches the standing rule: verify audit/handoff claims before acting.)

---

## 1. How to run this review (recommendation)

Run it in **priority waves**, not all at once. Within each wave, dispatch the independent domains in parallel.

**Recommended tooling per domain:**
- **Project subagents** (already built, run in their own context): `rls-security-reviewer`, `migration-drift-reviewer`, `typescript-types-drift-reviewer`, `pdf-output-reviewer`. Use these for D2, D3, D8, D10 — they're purpose-built for exactly those bug classes.
- **Fresh Claude Code session per domain** for the larger investigative domains (D4, D5, D6, D7) — paste the domain prompt, let it report, then act.
- **`/spot-check-prod`** skill for D1 (or the sentry.io dashboard if no Sentry MCP).
- **`/codex-cross-review`** on every **P0/P1 finding before you apply a fix** — your standing preference is that major findings get a second-LLM pass, and the prompt + handoff land in `docs/audits/`.

**Recommended order (my pick):**
1. **Today, before anything else:** D1 (Sentry triage) + D2 (recover the missing migration). These are the two that mean "real users are affected" and "your repo doesn't match production."
2. **Wave A (P0):** D3 (anon-SECDEF disposition).
3. **Wave B (P1):** D4, D5, D6 in parallel (money, RPC contracts, state machines).
4. **Wave C (P2):** D7 (refactor giants), D8, D9, D10.
5. **Wave D (P3):** D11, D12, D13, D14.

**Why waves, not one giant prompt:** a single "review everything" prompt produces shallow, generic output and blows past context limits. Scoped domain prompts produce findings you can actually act on, and you can stop after any wave with a coherent result.

> **Should you use `/ultrareview`?** It's the billed multi-agent cloud review and it's well-suited to P0/P1 (D2–D6). But it reviews the **current branch** — and you're on a clean `main` with no diff, so it has nothing to compare. For a whole-codebase audit, the domain prompts below (run via subagents / fresh sessions) are the better fit. Save `/ultrareview` for when you've made changes on a branch and want them vetted before merge.

---

## 2. The Review Domains

Legend: **P0** = foundation/blocking · **P1** = correctness/money · **P2** = structure/maintainability · **P3** = hardening/hygiene.

---

### D1 · P0 · Production error triage (Sentry + live logs)
**What to look for:** The actual errors real users are hitting in `croprxsolutions.app` over the last 7–30 days. Group by frequency; a single high-count error matters more than many one-offs.
**Why it matters:** This is the *only* place "we have a lot of errors" can be objectively measured. Everything else is preventative; this is "what's bleeding right now."
**How to run:**
- Run `/spot-check-prod` (it pulls Sentry if the MCP is connected; otherwise it tells you to use the sentry.io dashboard).
- If no Sentry MCP: open the sentry.io CRX Manager project, sort issues by events (24h / 7d / 30d), and for the top 5 use `posthog:investigating-replay` to watch the actual user session that triggered each.
- Also scan Supabase logs: `get_logs` for `service: api`, `edge-function`, `postgres` — look for repeated error-level events.

**Prompt (fresh session):**
```
Triage production errors for CRX Manager (croprxsolutions.app). Pull the top 10 Sentry
issues by event count over the last 30 days (use the sentry.io dashboard if no Sentry MCP).
For each: error message, count, first-seen, affected page/route, and whether it's user-facing
or background. Cross-reference Supabase api/postgres/edge-function logs for the same window.
Output a ranked table (worst first) with a one-line root-cause hypothesis per issue and a
suggested owner-domain (money / RPC / frontend / edge). Do NOT fix anything — triage only.
```

---

### D2 · P0 · Migration drift reconciliation (disk vs live)
**What to look for:** Every migration that exists in the live DB but not on disk (confirmed: `preserve_quote_price_overrides`), and vice-versa. Confirm the repo can faithfully reproduce production.
**Why it matters:** If the repo and live DB disagree, your backups/restore drill are unreliable, future migrations can collide, and "it works in prod but not from a fresh checkout" bugs become possible. This breaks the core promise of Architecture Rule #1.
**How to run:** `migration-drift-reviewer` subagent + a direct disk-vs-live diff. **Recover the missing migration's SQL from live and commit it as a file** (do not invent it — pull the real definition).

**Prompt (subagent `migration-drift-reviewer` or fresh session):**
```
Reconcile CRX Manager's migration files (supabase/migrations/*.sql) against the live Supabase
database (project rhyzpcqhnizqbxphqdkr) via MCP list_migrations.
1. Produce two lists: (a) versions live-but-not-on-disk, (b) files-on-disk-but-not-live.
   Known case to confirm: live version 20260528042000 / name 20260528000001_preserve_quote_price_overrides
   has NO file on disk.
2. For each live-only migration, retrieve the actual object definitions it created/altered from
   live (pg_get_functiondef / table DDL) so the SQL can be reconstructed faithfully — do NOT guess.
3. Check for version/name mismatches (the B7 class: MCP-stamped version != disk filename prefix).
4. Report a remediation plan: which files to add to the repo, exact content sourced from live,
   and whether any disk file was never applied. Report only — do not apply or commit.
```

---

### D3 · P0 · RLS & SECURITY DEFINER surface (the 89 anon-executable functions)
**What to look for:** For each of the 89 functions where `anon` can EXECUTE, decide: is it (a) a legitimately-public read (fine), (b) a trigger function not callable via the API (fine), or (c) a mutating/data-exposing function that should be revoked? Confirm the canonical strict-actor block (`auth.uid()` check) on every mutating RPC.
**Why it matters:** SECURITY DEFINER bypasses RLS. The anon key is embedded in the shipped frontend, so anyone can call these. This is the exact class behind your B4–B9 incidents and the 2026-05-25 P0.
**How to run:** `rls-security-reviewer` subagent. Enumerate the 89 first.

**Enumerate the 89 (read-only SQL via MCP `execute_sql`):**
```sql
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_exec,
       (pg_get_functiondef(p.oid) ILIKE '%auth.uid()%') AS refs_auth_uid
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY refs_auth_uid, p.proname;
```

**Prompt (subagent `rls-security-reviewer`):**
```
Audit the 89 SECURITY DEFINER functions in CRX Manager (project rhyzpcqhnizqbxphqdkr) that
anon can EXECUTE (use the enumeration query in docs/audits/2026-05-28-full-codebase-review-plan.md
D3). For each, classify: PUBLIC-READ-OK / TRIGGER-NOT-API-CALLABLE / REVOKE-ANON / NEEDS-ACTOR-GATE.
Flag any that mutate data or expose PII and lack an auth.uid() actor check. Produce a single
migration draft that REVOKEs EXECUTE from anon/PUBLIC on the REVOKE-ANON set and lists which
functions additionally need the canonical strict-actor block. Report + draft only — do not apply.
```

---

### D4 · P1 · Money & financial integrity
**What to look for:** All money as `bigint` cents (no floats); `parseDollarsToCents` vs `parseDollarsToCentsSigned` used correctly; ledger immutability (`inventory_transactions`, `prepay_applications`) holds; `invoices.balance_cents` is the single AR source; rounding in commission splits reconciles to order totals; `reconciliation.ts` (947 lines) is correct.
**Why it matters:** This is an ag-retail accounting system. A cents/float bug or a split that doesn't reconcile is real money lost or mis-billed to a customer.
**How to run:** Fresh session, deep read of `src/lib/reconciliation.ts`, `invoicePdf.ts`, `statementPdf.ts`, and money RPCs. The `money-safety.mjs` hook already blocks `parseFloat` on `*_cents` — verify coverage.

**Prompt (fresh session):**
```
Audit money handling in CRX Manager for correctness. Verify: (1) all monetary values are bigint
cents end-to-end, never float; (2) parseDollarsToCents (positive-only) vs parseDollarsToCentsSigned
are each used at the right callsites; (3) commission split rounding reconciles exactly to order
totals (no lost/gained pennies); (4) invoices.balance_cents (GENERATED) is the only AR source —
no code reads dropped orders.total_paid/balance_due; (5) ledger immutability triggers on
inventory_transactions and prepay_applications are enforced. Read src/lib/reconciliation.ts,
src/lib/invoicePdf.ts, src/lib/statementPdf.ts and the relevant RPCs. Report findings ranked by
financial blast radius with file:line citations. Report only.
```

---

### D5 · P1 · RPC contract correctness
**What to look for:** Zero duplicate function overloads (the query in CLAUDE.md should return 0 rows); every `SECURITY DEFINER` has `SET search_path = public, pg_temp`; every mutating RPC takes `p_idempotency_key` and actually uses it; error tokens registered in `RpcErrorCodes`; consistent return shapes; callers wrap with `assertRpcResult`.
**Why it matters:** Overload collisions and column-name drift caused the March 2026 40-bug incident. Inconsistent contracts are where silent failures hide.
**How to run:** Fresh session + the `rpcContracts.test.ts` / `rlsContracts.test.ts` suites as a baseline. `typescript-types-drift-reviewer` for the type side (D8).

**Prompt (fresh session):**
```
Audit CRX Manager's ~184 RPC contracts for drift and consistency (live project
rhyzpcqhnizqbxphqdkr). Check: (1) no duplicate overloads — run the pg_proc count>1 query from
CLAUDE.md and report any hits; (2) every SECURITY DEFINER has SET search_path = public, pg_temp;
(3) every data-mutating RPC declares p_idempotency_key AND reads/writes idempotency_keys with the
correct columns (idempotency_key/operation/result); (4) error tokens raised by SQL are all
registered in RpcErrorCodes in src/lib/db.ts and callers use hasRpcCode, not message.includes;
(5) return shapes follow the jsonb_build_object('success', true, ...) convention. Output a table of
violations with the RPC name and fix. Report only.
```

---

### D6 · P1 · State-machine integrity
**What to look for:** Each lifecycle (quote, order, delivery, invoice, job, PO, return, commission payment) only allows valid transitions; CHECK constraints are supersets of all historical values; delivery items lock once `in_progress`; the confirm→complete flow can't be skipped; closed periods block backdating.
**Why it matters:** A bad transition can strand inventory holds, double-count AR, or let a closed accounting period be edited. These are the rules the whole business runs on.
**How to run:** Fresh session, cross-check `CLAUDE.md` Business Logic Lifecycles against the live CHECK constraints and the RPCs that perform transitions.

**Prompt (fresh session):**
```
Audit CRX Manager's state machines (quote, order, delivery, invoice, job, PO, return, commission
payment). For each: list the live CHECK-constraint allowed statuses, compare to the lifecycle
documented in CLAUDE.md, and verify the transition RPCs reject invalid jumps. Specifically confirm:
delivery items are editable only while 'scheduled'; confirm_delivery -> complete_delivery cannot be
skipped; post_invoice calls check_period_open; voided/cancelled paths release inventory holds and
restore quantity_available. Flag any transition reachable from the UI that the DB doesn't guard.
Report with file:line + RPC names. Report only.
```

---

### D7 · P2 · Structural refactor of oversized files ("feels fragile")
**What to look for:** The 12+ files over 1,000 lines. Extract sub-components, hooks, and pure helpers so each file has one clear job. **Behavior-preserving only** — this is restructuring, not redesign.
**Why it matters:** This is the literal source of the "fragile" feeling. A 2,600-line component means every change touches code you can't hold in your head, so edits cause regressions. Smaller files = safer future feature work (your actual goal).
**How to run:** One file at a time, lowest-risk first. Lean on the existing test suite as a safety net; add characterization tests where coverage is thin *before* refactoring. Do **not** batch — refactor, run `npm run test` + `npm run build`, commit, repeat.

**Prompt (fresh session, per file):**
```
Refactor src/pages/<FILE>.tsx (currently <N> lines) for maintainability WITHOUT changing behavior.
Identify cohesive seams: extract sub-components, custom hooks (data fetching, form state), and pure
helper functions into co-located files. Preserve all props, RPC calls, assertRpcResult/
checkMutationResult usage, ConfirmModal patterns, and activity logging exactly. After each
extraction run npm run typecheck && npm run test. Produce the smallest set of commits that each
leave the suite green. Show me the proposed seam breakdown BEFORE editing so I can approve scope.
```

---

### D8 · P2 · TypeScript types vs live schema drift
**What to look for:** Every column/type in `src/types/index.ts` (2,557 lines) matches the live DB; no missing tables; no stale columns.
**Why it matters:** Type drift is silent — code compiles and "works" until a real query hits a field that doesn't exist. This is the quiet failure mode behind a lot of "weird" production bugs.
**How to run:** `typescript-types-drift-reviewer` subagent (purpose-built).

**Prompt (subagent `typescript-types-drift-reviewer`):**
```
Cross-check src/types/index.ts against the live Supabase schema (project rhyzpcqhnizqbxphqdkr).
Report every column-name mismatch, type mismatch, missing table, and stale (dropped-in-DB but
still-in-types) field, with file:line citations and a proposed src/types/index.ts edit for each.
Pay attention to the documented gotchas (commissions.commission_amount is numeric dollars;
invoice_items.extended_cents; orders.total_paid/balance_due dropped). Report only.
```

---

### D9 · P2 · Frontend integrity
**What to look for:** Every `.update()`/`.delete()` followed by `checkMutationResult`; every RPC result wrapped with `assertRpcResult`; no bare `confirm()`/`alert()`; Sentry imported from `lib/sentry`; error states handled with toasts; loading/empty/error UI states present.
**Why it matters:** Missing result checks = silent data-loss; bad error handling = users see blank screens or stale data. Most of this is enforced by ESLint + hooks already, so this domain is mostly *verifying the enforcement has no gaps*.
**How to run:** Fresh session; lean on `eslint-local-rules` and the validate-frontend script as the baseline, then hunt for what they miss (e.g., result checks inside `Promise.all`).

**Prompt (fresh session):**
```
Audit CRX Manager frontend (src/) integrity. Confirm: every supabase .update()/.delete() is
followed by checkMutationResult; every supabase.rpc() result is wrapped with assertRpcResult
(including inside Promise.all / map); no confirm()/alert()/window.confirm() anywhere; Sentry only
imported from ../lib/sentry; user-facing async actions have toast error handling and loading/empty
states. ESLint already enforces some of this — focus on the gaps it can't catch statically. Report
violations with file:line. Report only.
```

---

### D10 · P2 · PDF outputs
**What to look for:** Invoices, statements, tank labels, application reports render correct branding (`crx-green` #28A26A), no page overflow, all image assets resolve, money shown ÷100 (not raw cents), font fallbacks safe.
**Why it matters:** These are customer-facing documents. A PDF that "looks fine in dev" but breaks on a real customer print is a direct hit to the business's professionalism — and a raw-cents amount on an invoice is a billing error.
**How to run:** `pdf-output-reviewer` subagent (purpose-built).

**Prompt (subagent `pdf-output-reviewer`):**
```
Review CRX Manager's PDF generation (src/lib/invoicePdf.ts, statementPdf.ts, reportPdf.ts, and any
jspdf/jspdf-autotable usage). Check for: off-brand colors (must use crx-green #28A26A), page/column
overflow, missing or wrong image asset references, money rendered as raw cents instead of ÷100, and
unsafe font fallbacks. Report each issue with file:line and the customer-visible symptom. Report only.
```

---

### D11 · P3 · Edge functions & secrets
**What to look for:** All 7 functions have `ALLOWED_ORIGIN` CORS (fail-loud, not silent-allow); JWT auth where required; idempotency on mutating ones; deployed version matches source (the B8 class: guard in source but not deployed); no `service_role` leakage.
**Why it matters:** Edge functions run with elevated privilege. A CORS slip or a deployed-vs-source drift (B8) is a security hole that the frontend tests can't catch.
**How to run:** Fresh session + `list_edge_functions` to compare live versions against `CLAUDE.md`'s recorded versions. `env-guard.mjs` already blocks service_role in `src/`.

**Prompt (fresh session):**
```
Audit CRX Manager's 7 Edge Functions (supabase/functions/) + _shared. For each: confirm fail-loud
ALLOWED_ORIGIN CORS, correct JWT/auth gating, idempotency on mutating handlers, and that the
DEPLOYED version (MCP list_edge_functions, project rhyzpcqhnizqbxphqdkr) matches current source —
flag any deployed-vs-source drift (the B8 class where a guard exists in source but isn't deployed).
Confirm no service_role key is exposed to any client path. Report findings + which functions need
redeploy. Report only — do not deploy.
```

---

### D12 · P3 · Test coverage gaps
**What to look for:** Which critical RPCs, money paths, and state transitions have **no** test. Generate a coverage report; target the financial and RLS-sensitive code first.
**Why it matters:** 1,918 tests sounds like a lot, but coverage can still be lopsided — the scary gaps are in money/permissions, not in well-tested utility code. Knowing the gaps tells you where a refactor (D7) is actually risky.
**How to run:** `npm run test -- --coverage` (the `@vitest/coverage-v8` dep is installed), then map uncovered critical paths.

**Prompt (fresh session):**
```
Run npm run test with v8 coverage for CRX Manager. Identify the lowest-coverage files among the
financially- and security-critical code (money RPCs, reconciliation.ts, state-machine transitions,
RLS-sensitive flows). Produce a ranked list of "critical code with thin/no test coverage" and
propose the specific test cases that would close the highest-risk gaps. Do not write tests yet —
just the prioritized gap list.
```

---

### D13 · P3 · Dependencies & supply chain
**What to look for:** `npm audit` findings; outdated/abandoned packages (the pending #38 `shpjs` swap); the 1.68 MB Mapbox bundle (code-split candidate); any package with a known CVE.
**Why it matters:** Supply-chain and stale deps are slow-burn risk. The Mapbox bundle is a real performance cost on mobile (your users are in the field).
**How to run:** `npm audit`, `npm outdated`, and review `vite` chunking for the Mapbox vendor split.

**Prompt (fresh session):**
```
Audit CRX Manager dependencies. Run npm audit and npm outdated; summarize actionable CVEs and
major-version gaps (don't list every patch bump). Assess the abandoned-package swap tracked as #38
(shpjs and the .shp/.dbf/.prj/.kml handling). Evaluate code-splitting the 1.68 MB vendor-mapbox
chunk (lazy-load only on map routes) for mobile field users. Report a prioritized action list; do
not modify package.json.
```

---

### D14 · P3 · Dead code, doc drift & cleanup
**What to look for:** Unused exports/files, orphaned components, stale TODOs, doc references that no longer match code. (Counts are currently accurate — this is about content drift, not numbers.)
**Why it matters:** Dead code makes the codebase feel bigger and scarier than it is, and misleads future edits.
**How to run:** `/update-docs` skill for the doc side; a fresh session with an unused-export scan for the code side.

**Prompt (fresh session):**
```
Find dead code and doc drift in CRX Manager. (1) Identify unused exports, unreferenced files, and
orphaned components in src/. (2) Spot-check the reference docs (docs/reference/*) and CLAUDE.md
Business Logic sections for statements that no longer match the code (lifecycles, gotchas, schema
notes). Report a cleanup list ranked by safety (safe-to-delete vs needs-confirmation). Report only.
```

---

## 3. After each finding (your standing workflow)

1. For any **P0/P1** finding, run **`/codex-cross-review`** to get a second-LLM verification and drop the prompt + handoff in `docs/audits/` before fixing.
2. Apply fixes as **new migrations** (never edit existing ones) and **new commits** — the pre-commit hook (lint + build + test) is the gate; never `--no-verify`.
3. Any migration goes through `rls-security-reviewer` + `migration-drift-reviewer` (the `migration-apply-guard.mjs` hook enforces this) and a plain-English `/explain-migration` pass before `apply_migration`.
4. Re-run `npm run build && npm run test` and update the doc counts in `CLAUDE.md` per the Documentation Maintenance Rules.
5. Re-run the Supabase advisors after DDL changes (`/spot-check-prod`).

---

## 4. One-line summary for the top of your next session

> Toolchain is green; the real work is: **(P0)** triage Sentry, recover the live-only `preserve_quote_price_overrides` migration into the repo, and disposition the 89 anon-executable SECDEF functions; **(P1)** verify money/RPC/state-machine correctness; **(P2)** break up the 2,600-line components so future features are safe to add.

---

## 5. Findings Log — All 14 Domains Executed (2026-05-29)

**Method:** P0 → P3 in four waves. Independent reviewers (Agent subagents) ran each P2/P3 domain in parallel; the orchestrator did D1/D2/D3 directly and **independently re-verified every P1 claim against the live database** via Supabase MCP `execute_sql`. Reviewers cited file:line throughout. Read-only — no production code/schema/deploy changed during the review itself.

### Headline verdict
**The foundation is solid.** The "lots of errors" feeling was perception (big files + 3 untriaged DB errors), not actual fragility. Per-dimension: toolchain green, frontend "one of the most consistently disciplined" the reviewer had seen, types in sync, state machines sound, money math broadly correct, edge functions in the strongest state in the codebase's review history. The genuine bugs are concrete, bounded, and fixable — no catastrophic foundation issues.

### Per-domain verdict
| # | Domain | Verdict | Worst finding |
|---|---|---|---|
| 1 | Production error triage (live logs) | 🟡 3 real errors found | `o.blend_ticket_id`, `jsonb_array_length(record)`, `recipient_id` failing live |
| 2 | Migration drift (disk vs live) | ✅ FIXED in-session | Recovered `preserve_quote_price_overrides` (lost real bug-fix); 440-vs-357 gap is benign packaging |
| 3 | Anon-SECDEF surface | 🟡 44 over-exposed reads | Zero anon-callable mutators (B4–B9 closed). 44 read-only RPCs expose customer/financial/GPS/RUP data |
| 4 | Money & financial integrity | ✅ broadly clean | P1 `reverse_write_off` forgeable actor (only mutating-financial RPC missed by 2026-05-26 sweep) |
| 5 | RPC contract correctness | ✅ largely clean | P1 `save_job` (+5) declare `p_idempotency_key`, body never uses it; coverage test has a blind spot |
| 6 | State-machine integrity | ✅ CHECK constraints all sound | P1 cancelling a planned quote orphans inventory holds (latent today) |
| 7 | Giant-component refactor | 📋 plan delivered | DeliveryDetail (2433) + InventoryPage (1562) have ZERO unit tests — characterization tests needed first |
| 8 | TypeScript type drift | ✅ in sync (0 high/medium) | 3 optional enum-narrowing polish items only |
| 9 | Frontend integrity | ✅ CLEAN, zero findings | — |
| 10 | PDF outputs | 🟡 money clean, address split | P1 Martinsville (invoices/statements) vs Robinson (quotes/deliveries) — customer-visible |
| 11 | Edge functions & secrets | ✅ strongest state ever | Only P3: `validateSentryDsnOrThrow()` not at boot for 3 security-critical fns |
| 12 | Test coverage gaps | 🟡 lib code 78%/80%; gaps in audit code | reconciliation.ts lines 613-947 (the drift-checker) at 47.99% line coverage |
| 13 | Dependencies & supply chain | 🟡 3 prod CVEs (auto-fixable) | dompurify (via jspdf), ws + protocol-buffers-schema (via mapbox-gl) — `npm audit fix` resolves |
| 14 | Dead code & doc drift | ✅ codebase clean | Doc drift fixed in-session (see §6). 1 dead export (`compressImages`), 3 TODO stub handlers |

### P1 findings — verified live, fix soon
| # | Finding | Source | File / RPC |
|---|---------|--------|-----------|
| P1-A | `reverse_write_off` uses forgeable `COALESCE(p_performed_by, auth.uid())` → non-admin can spoof admin to reverse write-offs; audit log records the forged admin | D4 | `supabase/migrations/20260506200000_reverse_write_off_overdue_status.sql:50` |
| P1-B | `save_job` (+`save_blend_ticket`, `batch_apply_all_prepayments`, `batch_void_invoices`, `create_invoice_from_delivery`, `generate_rup_sales_records`) declare `p_idempotency_key`, body never touches `idempotency_keys`. **`save_job` create-path: double-click = 2 jobs.** `rpcContracts.test.ts:1335` lists them as covered — test only checks param exists, not body usage | D5 | `save_job` (LIVE), `save_blend_ticket` etc. |
| P1-C | `release_holds_on_quote_status_change` fires only on `accepted/declined/expired`. `draft/sent/revised → cancelled` is legal → planned-quote cancel leaves inventory holds active forever (latent: 0 orphaned in prod today) | D6 | trigger fn `release_holds_on_quote_status_change` |
| P1-D | Customer-facing PDFs disagree on the company's own address: invoices/statements/year-end = **Martinsville, IL** (incl. remit-to PO Box 123); quotes/deliveries/order-summary/receiving = **Robinson, IL**. Settings already has `company_*` fields — PDFs hardcode literals instead | D10 | 8 files in `src/lib/*Pdf.ts` (specific lines listed) |
| P1-E | 3 moderate prod-bundle CVEs: `dompurify <3.4.0` (via jspdf), `ws 8.0.0-8.20.0` (via mapbox-gl), `protocol-buffers-schema <3.6.1` (via mapbox-gl). `npm audit fix` resolves all — minor bumps | D13 | package-lock.json |
| P1-F | 3 live Postgres query errors in 1-hour window: `column o.blend_ticket_id does not exist`, `function jsonb_array_length(record) does not exist`, `column "recipient_id" does not exist`. Real users likely hitting. Full frequency/impact needs sentry.io dashboard | D1 | unknown sources — needs per-error debug |

### P2 findings — hardening
| # | Finding | Source |
|---|---------|--------|
| P2-A | 44 anon-callable read-only SECDEF RPCs expose customer financials / statements / GPS / RUP data (CRX has no anonymous user features → these should not be anon-EXECUTE-able) | D3 |
| P2-B | PDF `didDrawPage` / `didDrawCell` / `didParseCell` callbacks not wrapped in try/catch — a throw aborts the whole document, single-document downloads have no try/catch in the caller either | D10 |
| P2-C | `statementPdf.drawRemittanceStub` draws at fixed `pageH - 155` with no page-space guard → for customers with 8+ open invoices the stub overdraws the last transaction's table; comment at line 659 acknowledges "we'll draw over content (acceptable for tear-off)" — not safe | D10 |
| P2-D | `delivery_items` RLS has no parent-status guard — admin/sales could INSERT/UPDATE/DELETE items on an `in_progress` delivery via direct PostgREST API (UI only uses guarded `edit_delivery()` RPC, so not currently exploited) | D6 |
| P2-E | `approve_return` / `receive_return` lack explicit role check (rely on RLS); a sales_rep who filed the return could self-approve/receive it. Sibling `issue_return_credit` correctly enforces `role IN ('admin','sales_rep')` | D6 |
| P2-F | `reconciliation.ts` lines 613-947 (the **drift-checker tool itself**) at 47.99% line coverage | D12 |
| P2-G | `DeliveryDetail.tsx` (2433 LOC) and `InventoryPage.tsx` (1562 LOC) have **zero unit tests** — characterization tests needed before any refactor (D7 plan) | D12 |
| P2-H | `save_blend_ticket` returns `jsonb_build_object('status','saved')` not the canonical `('success', true, …)` — return-shape inconsistency | D5 |
| P2-I | Local `parseDollarsToCents` duplicate in `src/pages/ApplicationServiceDetail.tsx:19-22` bypasses the hardened canonical parser | D4 |

### P3 findings — hygiene / polish
- D11: `validateSentryDsnOrThrow()` not called at module boot for `create-user`, `reset-user-password`, `send-email` (silent Sentry degradation if DSN unset). The shared lib already provides the strict variant.
- D10: 7pt fonts borderline on inkjet printers (acceptable); `deliveryPdf` signature force-fit to 200×60 squashes tall captures; batch download relies on sequential `doc.save()` (browsers may throttle).
- D13: `pdfjs-dist` (~3 MB raw) has **zero `src/` consumers** — candidate for removal (`npm uninstall pdfjs-dist`); `CustomerDetail.tsx` is high-traffic and pulls the 1.68 MB mapbox vendor chunk → lazy-load the map components inside it for mobile-UX win.
- D14: dead `compressImages` (plural) export in `src/lib/imageCompression.ts`; 3 TODO stub button handlers (FieldApplicationInvoice print button, FieldAppChemicalEntry recipe picker + save-recipe).
- D14: `pages-routes.md` header "66 total" → could read "66 pages / 68 routes" (multiple routes per page is fine, just clearer wording).

### Recommended fix order
1. **Quick wins (~30 min):** `npm audit fix` (closes P1-E); answer Martinsville-or-Robinson (closes P1-D after a unifying edit pass); toggle Supabase leaked-password protection in dashboard.
2. **SQL P1 sprint (3 migrations + 1 test):** P1-A (`reverse_write_off` strict actor), P1-B (`save_job` + 5 idempotency wrappers, tighten the coverage test), P1-C (add `cancelled` to `release_holds_on_quote_status_change`). Each routed through `rls-security-reviewer` + `migration-drift-reviewer` + `/explain-migration` per the migration-apply-guard hook.
3. **D1 root-cause:** per-error debug for the 3 live Postgres errors; cross-reference Sentry dashboard for affected users/pages.
4. **P2 sprint:** REVOKE anon EXECUTE on the data-exposure subset of the 44 read RPCs (P2-A); wrap PDF callbacks in try/catch (P2-B); add page-space guard to remit stub (P2-C); add status trigger to `delivery_items` (P2-D); add role check to return RPCs (P2-E); fix the small frontend P2s.
5. **Test coverage sprint:** the 5 specific cases proposed in D12 — start with `reconciliation.ts` boundary tests.
6. **Refactor sprint (long-running, separate):** D7 plan in order — inventory modals → order tables → driver delivery view → `quoteCalc.ts` (after characterization tests for DeliveryDetail + InventoryPage).

---

## 6. Housekeeping applied in-session (2026-05-29)
- Recovered & wrote `supabase/migrations/20260528042000_preserve_quote_price_overrides.sql`; synced `src/types/index.ts` `QuoteItem.price_override`. Typecheck passes.
- **CLAUDE.md** Current State date 2026-05-25 → 2026-05-29; counts 95 → 97 tables, ~184 → ~204 RPCs, 356 → 357 migrations; added live Edge Function version table; both "Pending live apply/deploy" notes on the 2026-05-26 migrations updated to "Applied live and verified"; removed completed `#38 abandoned-package swap` from "Pending Mason."
- **docs/reference/migration-history.md** header 356 → 357.
- **docs/reference/database-schema.md** header 95 → 97.
- Memory: feedback note `feedback_ground-reviews-before-planning.md` added (ground reviews in real checks before writing the plan — surfaced the live-vs-disk drift a generic plan would have missed).
