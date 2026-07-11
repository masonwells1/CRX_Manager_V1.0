# UI Overhaul Overnight Loop — 2026-07-10

## Mission
Consolidate CRX Manager's fragmented daily-use screens and polish the visual experience. Frontend-only: **ZERO database migrations, ZERO edge-function changes, ZERO RPC changes.** Owner (Mason) is asleep; do not wait on him — if a decision point genuinely needs him, PARK that item in the ledger with a plain-English question and move to the next unit.

## Owner decisions (already made — do NOT re-ask)
- Scope: all 3 phases.
- Merged Today screen ordering: **action queues at top**, money/KPI numbers just below.
- Ship gate: **auto-push each green phase to main** (frontend-only; Vercel rollback is the safety net).

## Granularity
One unit = one page-cluster or component task from the phase worklists below (e.g. "merge Dashboard KPIs into OfficeCockpit", "Tabs primitive", "field-invoice consolidation"). Each unit gets its own Codex build → Codex self-review → Claude review → gates → ledger row before the next unit starts. A phase pushes only when ALL its units are done or parked.

## Worktree
C:\CRX_UIOverhaul, branch `feat/ui-overhaul-2026-07` (created 2026-07-10 from origin/main @aa48624f). This loop OWNS this tree; never work in C:\CRX_Manager or any other worktree.

## Definition of done
Every unit in Phases 1–3 is either DONE (built, Codex-clean, Claude-reviewed, all gates green, rendered proof in ledger, committed, pushed) or PARKED with a plain-English question/reason. Ledger complete with a morning report for Mason at top. Loop then stops.

## Delivery gate
Auto-push of green frontend-only phases to `main` is AUTHORIZED by Mason (2026-07-10, this conversation). What NEVER happens regardless: live migration apply, edge-function deploy, data deletion, secret/config writes, `--no-verify`, force-push. Any unit that would require a DB or edge-function change is PARKED, not built.

## Harness (driver model)
- **Claude = orchestrator**: sequences units, reviews Codex output, integrates, runs gates, commits, pushes.
- **Codex = builder**: each unit is built by Codex CLI (`codex exec`, inline prompt — NOT `codex review` headless). Pick the model per job: `terra` for hard/architectural units (Phase 1 merge, FieldInvoices consolidation), `sol` for standard page work, `luna` for small mechanical polish units.
- **Codex self-review**: after building, the SAME Codex invocation (or a follow-up `codex exec`) must review its own diff against the unit's acceptance checklist and fix its findings BEFORE handing off.
- **Claude review + implement**: Claude reads the diff, verifies against acceptance criteria, runs the unit through `npm run typecheck && npm run lint && npm run test && npm run build`, and actually RENDERS the affected page (vitest render test or dev-server check) before counting it done.
- Hard cap: 3 build→review rounds per unit; if still failing, PARK it in the ledger and move on.
- **Builder fallback (Mason, 2026-07-10):** if Codex CLI fails on credits/quota/rate-limit, switch builders to Claude Sonnet subagents (Agent tool, model sonnet) with the same build→self-review→hand-off contract. Do NOT stop the loop. Note the switch in the ledger.
- Known gotchas: 600s bash cap kills long builds (run Codex builds with run_in_background); page tests flake in full suite (use waitFor/findAllBy); use `&mdash;` in JSX; `npm run typecheck` is the only real typecheck.

## Phase 1 — One true home screen
Merge `src/pages/Dashboard.tsx`'s useful pieces (KPI cards, inventory position, quick actions) into `src/pages/OfficeCockpit.tsx` so `/office-cockpit` ("Today") is the single morning screen:
- Top: existing action-queue cards (unbilled jobs, needs dispatch, ready to post, chemical drafts, overdue field-app AR).
- Below: compact KPI/money strip + inventory position.
- Dashboard becomes a pure reports page (keep route `/dashboard`, strip duplicated tiles, leave under Insights nav).
- Update `Sidebar.tsx` labels if needed. No route deletions (bookmarks keep working).

## Phase 2 — Collapse fragmented clusters into tabbed pages
Build a shared `Tabs` primitive in `src/components/ui/Tabs.tsx` (styled like InventoryPage's underline tabs) + tests, then:
1. **Field invoices**: one page with tabs Unbilled → Drafts/Unposted → Posted → By Customer (merge `FieldInvoices`, `FieldInvoicesUnposted`, `FieldInvoicesPosted`, `CustomerInvoiceSummary`, `UnbilledApplications`). Old routes redirect to the tabbed page.
2. **Receiving**: merge `ReceivingHub`, `ReceivingLog`, `QuickReceive` into one tabbed page (Quick Receive stays reachable from TopBar +New).
3. **Prepay**: merge `PrepayWorkspace` + `PrepaymentManager` into one page.
4. **Integrity**: merge `IntegrityReport` + `IntegrityCleanup` into one tabbed page.
Keep every old route as a redirect; update Sidebar + CommandPalette + pagePermissions accordingly.

## Phase 3 — Visual polish pass
- Shared `PageHeader` component (SplitHeading brand style: Barlow heading + green accent) adopted on all office pages; kill ad-hoc `<h1>`/`<h2>` header variants.
- Consistent page padding/spacing rhythm; consistent Card usage on stray pages.
- Adopt the shared Tabs primitive in InventoryPage (replace hand-rolled tab bar).
- No dark mode work (out of scope). No color-token changes.

## Per-phase completion gate (before push)
1. Codex self-review clean.
2. Claude review clean.
3. `npm run typecheck && npm run lint && npm run test && npm run build` all green.
4. Affected pages actually render (proof line in ledger: what ran, what was seen).
5. Commit **only files this loop touched** (`git commit --only <paths>`), push branch, then fast-forward/push `main` per auto-push policy. If the pre-push hook fails, fix or park — never bypass.

## Ledger
Maintain `docs/loops/ui-overhaul-ledger.md` in this worktree: one row per unit (status, Codex model used, review rounds, proof line, parked questions for Mason). Morning report section at top summarizing what shipped, what's parked, and the one next step.

## Hard rules
- Never touch `supabase/`, `.claude/settings*`, hooks, or files owned by other loops.
- Never `--no-verify`, never force-push, never reset --hard.
- This worktree only; never commit from C:\CRX_Manager.
