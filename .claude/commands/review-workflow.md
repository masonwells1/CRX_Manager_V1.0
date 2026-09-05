Run a full, widespread review of CRX Manager's workflow logic, page/RPC connections, entity lifecycles, and cross-entity business flows — anchored on the workflow map at `docs/app-workflow-map.html` but NEVER trusting it. This is the "is my foundation solid enough to build the next feature on?" check. It is **read-only**: it analyzes and writes ONE report file. It does not edit code, apply migrations, deploy, or commit.

The heavy lifting now runs as the deterministic **`review-workflow` Workflow** (`.claude/workflows/review-workflow.js`): it dispatches the four review layers in parallel and adversarially verifies every BLOCKER/HIGH finding (same-model skeptics try to refute each one to cut false positives) before it can reach the report. This command refreshes ground truth, runs that workflow, then synthesizes + writes the report.

## The one rule that overrides everything

**Verify every finding against the actual source code and the live Supabase database before it goes in the report.** Do not trust:
- the auto-detected problems in the workflow map (they come from shallow regex grep),
- the lifecycle claims in the docs (`docs/manual/ARCHITECTURE.md`, `docs/reference/`),
- prior audit docs in `docs/audits/`,
- or the verification note already inside the HTML.

The map's own "Verification Note (2026-05-20)" documents that a previous grep-heuristic pass asserted ~6 problems that were all FALSE once someone read the code (Returns "broken" — false; /notifications "orphan" — false; "drop get_field_geojson" — would have caused an outage). Treat every flag as a *lead to confirm by reading the code/DB*, never as a fact. A finding with no `file:line` or migration/constraint citation does not belong in the report. The workflow's adversarial-verify phase helps enforce this — but you still drop any uncited finding yourself in Step 2.

Lead with **recommendations**, not just lists — for every real issue, say what you'd do about it and why.

## Step 0 — Refresh ground truth (do these in parallel)

```bash
npm run generate-map
git status --short
```

- `npm run generate-map` rewrites `docs/app-workflow-map.html` from the current code so the graph + auto-detected problems reflect HEAD, not a stale commit. Capture the console output (route count, RPC-call count, problem count).
- Note: `.agents/` and `.codex/` are tracked generated adapters (regenerated via `scripts/sync-agent-workflows.mjs`); `scripts/generate-workflow-map.mjs` is tracked too. Flag hand-edits to generated files, not regeneration diffs.

Then, for grounding (not as truth), make sure the regenerated `docs/app-workflow-map.html`, `.claude/schema-registry.json` (flag if >7 days old; prefer the live DB), and the lifecycle/business-logic docs (`docs/manual/ARCHITECTURE.md`, `docs/reference/database-schema.md`, `docs/reference/gotchas.md`) are available — the workflow's layer agents read these themselves.

## Step 1 — Run the review-workflow Workflow

Invoke the `review-workflow` Workflow (no args needed). It runs four layers concurrently, each reading actual code + querying the live DB via Supabase MCP, then verifies BLOCKER/HIGH findings adversarially. The four layers it encodes (full prompts live in the script):

- **Layer A — Graph & connection integrity** (orphan pages, broken navigation, dead RPCs, page→RPC wiring, role gating). Knows the false-positive traps: `/customers/new`→`:id`, TopBar bell panels, FinancialDashboard array-config menu, `INTERNAL_RPCS`, `/payments` is intentionally admin+sales, `get_field_geojson` is live.
- **Layer B — Lifecycle / state-machine integrity** (4-way reconciliation per entity: live CHECK vs documented lifecycle (`docs/manual/ARCHITECTURE.md`) vs map SVG vs actual RPC transitions; ghost states, orphan states, status-string drift like `'void'` vs `'voided'`).
- **Layer C — Cross-entity flow integrity** (Quote→Order→Delivery→Invoice→Payment + Commission/PO/Return/Blend; can any entity get permanently stranded?).
- **Layer D — Business-logic invariant sweep** (money-as-cents, RLS on every table, idempotency, SECURITY DEFINER `search_path`, immutability, no overload collisions, advisors, `updated_at` on the wrong tables).

It returns:
`{ confirmed[], refuted[], unverified[], blocked[], lowerSeverity[], verifiedSafe[], layers[], overallStatus, complete, clean, counts }`.

Each finder layer must explicitly return `executionStatus=VERIFIED` plus a non-empty `evidenceSummary`, or `executionStatus=BLOCKED` with the unavailable source named. A schema-shaped empty result without that proof is incomplete, not clean.

- `confirmed` — BLOCKER/HIGH findings that survived adversarial verification. These go in the report.
- `refuted` — flagged but disproven on re-check. These go in the report's **"Verified safe"** section (so the next review doesn't re-chase them).
- `lowerSeverity` — MED/LOW reported once in their severity bucket and marked `UNVERIFIED`; because this workflow does not adversarially verify them, any entry prevents a clean/complete verdict.
- `unverified` — findings whose required evidence or verifier output is incomplete. These stay visible and never count as refuted or clean.
- `blocked` — missing/malformed review layers or unavailable required evidence. Any entry forces `overallStatus=BLOCKED`, `complete=false`, and `clean=false`.

Only `VERIFIED` and evidence-backed `REFUTED` are terminal evidence states. A missing layer, missing verifier, timeout, tool denial, malformed structured response, or uncited finding is `UNVERIFIED`/`BLOCKED`; it must never satisfy a clean/dry/ship gate.
- `verifiedSafe` — leads the layers self-disproved while reviewing.

## Step 2 — Synthesize

De-duplicate across layers. The workflow already assigned severity and verified BLOCKER/HIGH, so:
- Keep `confirmed` (BLOCKER/HIGH) + `lowerSeverity` (MED/LOW) as findings, and put `unverified` / `blocked` in a visible incomplete-evidence section.
- Move `refuted` + `verifiedSafe` into the "Verified safe" section — do NOT report them as problems.
- If `overallStatus=BLOCKED`, the report verdict must say the audit is incomplete even when `confirmed` is empty.
- Severity definitions: **BLOCKER** = data-loss / money-correctness / RLS bypass / an entity that can get stranded (fix before building anything new). **HIGH** = real bug with a workaround. **MED** = drift/inconsistency that's safe today but will confuse later. **LOW** = docs/cosmetic.

## Step 3 — Write the report

Write to `docs/audits/<YYYY-MM-DD>-workflow-review.md` (get the date from a real clock — `TZ='America/Chicago' date +%F`) with this structure:

```markdown
# Workflow & Business-Logic Review — <YYYY-MM-DD>

## Verdict
<One paragraph: is the foundation solid enough to add features on? If not, what's the single thing to fix first?>

## Scope
Routes: <N> · RPC calls: <N> · Tables: <N> · Lifecycles checked: 10
Method: regenerated map + read live source + queried live Supabase + adversarial verification. Every finding cited.

## Findings

### 🛑 BLOCKER (<n>)
- **<title>** — <what & where: file:line / migration / constraint>. Why it matters: <…>. **Recommendation:** <fix>. Confidence: <high/med>.

### 🔴 HIGH (<n>)
### 🟡 MED (<n>)
### ⚪ LOW (<n>)

## Lifecycle reconciliation table
| Entity | Live CHECK | Documented (ARCHITECTURE.md) | Map SVG | RPC transitions | Agree? |
|--------|-----------|-----------|---------|-----------------|--------|
<one row per entity; mark mismatches>

## Cross-entity flow status
<Quote→Order→Delivery→Invoice→Payment, +Commission/PO/Return/Blend — OK / where it can stall>

## Verified safe (leads checked, found correct)
<The workflow's refuted + verifiedSafe lists, so the next review doesn't re-chase them — mirror the HTML's existing note.>

## Before you add features — prioritized punch list
1. <highest-leverage fix>
2. …
```

## Step 4 — Report verdict to Mason (compact)

In chat, print only:
- the one-paragraph verdict,
- counts by severity (from the workflow's `counts`),
- the top 3 punch-list items,
- the report path.

Keep full detail in the file, not the chat.

## Step 5 — Offer Codex cross-review (do not auto-run)

If there are any BLOCKER or HIGH findings, offer to run `/codex-review` so a separate ephemeral
Codex `gpt-5.6-sol` high-effort session validates them before Mason acts (the in-workflow skeptics
only reduce false positives and do not satisfy this hard gate). Wait for his go-ahead.

## Hard rules
- **Read-only.** No `Edit`/`Write` except the one report file. No `apply_migration`, no deploy, no `git commit`.
- **Cite or cut.** Any finding without a `file:line`, migration name, or constraint name gets dropped.
- **Parallel + verified dispatch** is handled by the `review-workflow` Workflow — don't hand-roll the fan-out.
- **Recommend, don't just list.** Every real finding carries a recommended fix.
- **Trust nothing pre-written.** The map, AGENTS.md-routed workflow/reference documents, and prior audits are leads, not facts — confirm against live code + DB.
