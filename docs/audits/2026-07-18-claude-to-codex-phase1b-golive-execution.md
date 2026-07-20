# Handoff — Supplier Pricing **Phase 1b** go-live (Claude → Codex execution)

**Date:** 2026-07-18
**Author:** Claude (orchestration session), handing execution to Codex CLI
**Worktree:** `C:\CRX_Phase1b`  **Branch:** `feat/supplier-pricing-phase1b`
**Live Supabase project ref:** `rhyzpcqhnizqbxphqdkr`

---

## 0. Why this handoff exists

Phase 1b is **built + 3-way reviewed + fixed** and sitting **uncommitted** on this branch.
Nothing about it needs more design judgment. What remains is a mechanical, gated
**go-live**: apply 2 migrations to the live DB through the proof gate, then commit /
PR / merge the frontend. This doc is the complete recipe so a **Codex CLI session**
executes it without spending the premium orchestration budget.

**Owner (Mason) has pre-authorized the Phase 1b go-live.** But the hard gates are NOT
waived — see §5 "Park-and-report rules". Codex must PARK and report (never self-certify)
if any gate returns findings.

---

## 1. What is already TRUE (do not redo)

- **Phase 1a is 100% live + merged to `main`** (harden `20260718154131`, cutover
  `20260718190000`, rescan `20260718193000`; PR #169 merged as `454af43b`). Governed
  pricing flow is live and proven end-to-end on the real UI.
- Phase 1b code is built and reviewed (Codex + Sol adversarial), including the
  package_quantity "who's cheapest" fix and the quote-correction / supersession feature
  (`correct_supplier_price_observation`).
- Backup of the reviewed tree: `scratchpad/phase1b-reviewed-uncommitted.patch`.

## 2. What must go LIVE (this job)

Two migrations, in this exact order — **both are additive / non-destructive** (verified:
no DROP, no DELETE FROM, no TRUNCATE; the vendor-alias file only RECORDS reviewed
aliases, it does not delete or merge vendor rows):

1. `supabase/migrations/20260718225511_supplier_price_evidence_phase1b.sql` (~2118 lines;
   applied with submitted name `20260718230000_supplier_price_evidence_phase1b`)
   — 6 RLS tables, 10 SECURITY DEFINER RPCs **+ `correct_supplier_price_observation`**,
   storage policies, append-only triggers.
2. `supabase/migrations/20260718235717_stage_supplier_vendor_aliases_phase1b.sql` (~181 lines; submitted as `20260718235900_stage_supplier_vendor_aliases_phase1b`)
   — vendor-alias staging data step (`The Andersons`; `Van Deist` / `Van Diest` aliases targeting active canonical vendor `Van Diest Supply`); records reviewed aliases only.

Then the frontend (`src/pages/SupplierPricing.tsx`, `src/components/products/ProductPriceHistory.tsx`,
`src/lib/supplierPricing.ts`, `src/lib/supplierPricingWorkbook.ts`,
`src/lib/productPricingSupplierEvidenceWorkbook.ts`, `src/lib/xlsxArchiveSafety.ts`,
`src/types/index.ts`, and tests) can be committed → PR → merged.

## 3. Ordering rule (WHY DB must go first)

The release gate `rpcFixtureLiveDiff.test.ts` **fails by design** while the frontend
references RPCs that are not yet live, and `QUEUED_MIGRATION_FUNCTIONS` must be empty at
commit. So the frontend **cannot be committed until 162114's RPCs are applied live**.
DB-first is mandatory, not a preference.

---

## 4. EXECUTION STEPS

### Preconditions Codex must VERIFY first (do not trust this doc blindly)
1. `git -C C:\CRX_Phase1b rev-parse --abbrev-ref HEAD` == `feat/supplier-pricing-phase1b`.
2. Supabase MCP is connected in this Codex session (`list_migrations` returns rows). **If it
   is NOT, STOP** — the live apply cannot happen from this session; report back so a short
   Claude session does only the apply step.
3. Confirm the 6 tables / RPCs from the evidence migration do **not** already exist live,
   record the current `list_migrations` high-water, and confirm both unapplied filename
   stamps are strictly greater. If any Phase 1b objects already exist, STOP and report
   (someone already started this). If the high-water has overtaken either filename, restamp
   both files in order, update their references/history, and rerun the full review gate.
4. Autopilot state: check `C:\CRX_Manager\.claude\session-state\AUTOPILOT.json`. Hands-free
   apply requires `AUTOPILOT.on` == true **and** the Codex review gate (below). If not armed,
   this is an interactive apply — report to Mason for the in-chat OK before the apply call.

### Step A — Review + mint the apply-proof for 230000
Run the sanctioned wrapper (it runs a REAL trusted-Codex review and only mints proofs on a
CLEAN machine verdict — you cannot hand-write proofs; `review-proof-guard` blocks that):
```
node scripts/write-apply-proofs.mjs 20260718230000_supplier_price_evidence_phase1b
```
- **CLEAN** → proof pair minted at `C:\CRX_Phase1b\.claude\session-state\`.
  **Copy the pair to the guard dir** the apply-guard actually reads:
  `C:\CRX_Manager\.claude\session-state\` (the guard reads `CLAUDE_PROJECT_DIR` = the MAIN
  checkout, not this worktree — this bit Phase 1a).
- **BLOCKERS / not-CLEAN** → **PARK. Do not apply.** Fix the findings on-branch, re-run the
  wrapper. If findings are judgment calls, report to Mason. (Precedent: a Phase-1a rescan
  migration came back non-CLEAN from `migration-drift-reviewer` and was correctly parked.)

### Step B — LF-normalize the apply content (CRLF trap)
The working-tree files may be CRLF; the proof binds `sha256` of the **exact bytes** you
transmit to `apply_migration`. Create an LF copy in scratchpad and confirm its sha256 ==
the proof `queryHash` before applying. (Phase 1a did exactly this.)

### Step C — Apply 230000 live
Call `apply_migration` (Supabase MCP) with `name` substring-matching the proof
(`20260718230000_supplier_price_evidence_phase1b`) and the LF-normalized SQL as `sql`.
The apply-guard will verify: proof fresh (<30 min), reviewers recorded, `queryHash` match,
and (hands-free) `AUTOPILOT.on` + a `codex-review-mig` proof. Additive migration → not
auto-refused.

### Step D — Repeat A→C for 230100
The same recipe was run for submitted name `20260718235900_stage_supplier_vendor_aliases_phase1b` (now B7-renamed on disk to live ledger version `20260718235717_stage_supplier_vendor_aliases_phase1b`). It's a small data
step; still goes through the full proof gate.

### Step E — Reconcile disk + docs (B7 rule)
The MCP stamps `schema_migrations.version` at apply time. After each successful apply,
read the assigned version from `list_migrations` and rename the corresponding disk file to
that exact version before commit; never rewrite the live migration ledger to fit an old
filename. Update all exact filename references, `docs/reference/migration-history.md`, and
`docs/CHANGELOG.md`. Refresh the schema registry via MCP introspection
(`--from-introspection`) — a plain run only stamps; `registry-freshness` flags stale after DDL.

### Step F — Commit the frontend (now unblocked)
With the RPCs live, `rpcFixtureLiveDiff.test.ts` should pass and `QUEUED_MIGRATION_FUNCTIONS`
is empty. Register/refresh the RPC fixtures if the release-gate helper needs it, then commit.
Note: pre-commit runs a disposable-DB smoke and can exceed a 2-min foreground cap — run the
commit in the background.

### Step G — PR + push-proof + merge
```
node scripts/write-codex-push-proof.mjs --timeout 1800
```
mints the HEAD+base-bound push-proof `pr-merge-guard` requires. Open the PR, let CI +
CodeRabbit run, then `gh pr merge`. **No direct push to `main`** (protect-main) — branch → PR
→ Vercel check → merge only.

### Step H — Prove it live (Done = ran and proven)
After merge + prod promote (prod does NOT auto-update on merge; promote + force-refresh the
PWA twice), open the real UI and exercise: record a supplier price observation, view product
price history (confirm pack-size-correct "cheapest"), and a quote correction/supersession.
Capture a PROOF line (what you ran + what you saw). Tests passing is NOT proof.

---

## 5. PARK-AND-REPORT RULES (non-negotiable)

- If **either** migration review returns findings → PARK, fix or escalate. Never self-certify.
- If Supabase MCP is **absent** in the Codex session → do everything up to the apply, then hand
  the apply step to a short Claude session. Report clearly.
- If any apply-guard check fails (stale proof, hash mismatch, missing codex proof) → STOP, fix
  the specific cause, re-mint. Do not weaken the guard.
- Anything **destructive** discovered mid-run (unexpected DROP/DELETE) → HARD STOP, report to
  Mason. (Verified today: neither file is destructive.)
- No secrets in logs/PR. No production DB writes outside the two gated migrations.

## 6. Definition of DONE

Both migrations live + ledger reconciled; frontend merged to `main`; prod promoted; the
supplier-evidence flow (record observation → price history with correct cheapest → quote
correction) **exercised on the live UI** with a captured proof line; memory
`project_supplier-pricing-variants-plan-2026-07-16.md` updated to "Phase 1b LIVE".

---

*Prepared by Claude to conserve premium orchestration budget. Codex executes; if any gate is
ambiguous, PARK and ask Mason rather than proceed.*
