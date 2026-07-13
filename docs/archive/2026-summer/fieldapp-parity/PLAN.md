# CRX Field-Application Parity — Build Plan & Autonomous Loop Design

**Date:** 2026-06-24
**Goal:** Bring CRX-Manager's field-application side to **full ChemMan parity** — build every missing feature AND bring the features you already have up to ChemMan's full depth. Bounded scope: perfect this list, don't invent new features. Skip aerial. Skip Mixmate.

**Source of truth for "done":** the `ChemMan-FieldApp-Capture.md` hands-on log. The detailed, testable acceptance criteria per section live in `CRX-FieldApp-Parity-BACKLOG.json`.

---

## How the autonomous loop runs (per section)
For each section, completely on its own:
1. **Build** it on the worktree branch.
2. **Run** the app + tests; if a database change is needed, apply it to a **throwaway preview database** (never your live one).
3. **Deploy to a preview website** (a private link, not your real site) and confirm it works.
4. **Codex reviews** it (your second AI). **Fix** every High/Medium finding; Low findings get parked in a list you see at the end.
5. **Self-check** ("does this actually match ChemMan?"), fix gaps, then move to the next section.
6. Write a one-paragraph plain-English note of what it did.

It does **not** stop for you between sections. "Self-improve" = keep polishing the list until each section is clean + a final "what did we miss vs ChemMan?" pass. It will **not** build anything outside this list.

## Safety gates (the part that protects your money)
- The loop is **fully hands-off** through build → preview DB → preview site → Codex → fix, for all 41 sections.
- It **never touches your live site or live database during the run.** Production is promoted **only at the very end**, when I bring you one consolidated review + the open questions + the go/no-go.
- **~16 of the 41 sections change the database structure** (the Step-0 re-audit will trim this — some are already done in `main`). Those are the highest-risk to apply to your live data, so at production time I'll walk you through each in plain English before anything is applied.
- Any money rule I don't know (e.g. the fuel-surcharge formula) is built as a setting that's **OFF by default and left blank for you** — the loop never invents a billing rule.

## Where it lives
A **dedicated worktree** (separate working copy) on one long-lived branch, created off **clean `main` after your 3 in-flight branches merge** — so it never tangles with your other work and starts from current truth.

---

## Build order (dependency-ordered) — all 41 sections
`(DB)` = changes the database structure → these are the ones you'll approve one-by-one at production time.

### Phase 1 — Job Scheduling command center (8)
1. Job list + create/edit job parity — every column, the tabbed editor, totals row, expanders. **(DB)**
2. Recipes — save a tank mix and one-click load it onto a job.
3. Job batches — bundle jobs into named groups. **(DB)**
4. Color-coded job tags — create/edit/delete colored tags, chips on rows, filter by tag. **(DB)**
5. Field route-ordering — drag a job's fields into the order the applicator drives them.
6. Full filter set — all ~14 filters, combined (customer, applicator, crop, chemical, status, etc.). **(DB)**
7. Mass-edit selected jobs — change date/status/loader on many jobs at once.
8. Customizable list columns — each user picks which columns show. **(DB)**

### Phase 2 — As-applied & compliance capture (5)
9. As-applied record — applicator, vehicle, application date; multiple per job. **(DB)**
10. Applied acres per field + remaining-acres tracking (partial / multi-day jobs). **(DB)**
11. Start **and** end weather pair, auto-pulled (keeps your free Open-Meteo). **(DB)**
12. Tach hours — begin/end/net engine-hour readings. **(DB)**
13. Ground crew + crew members on the application record. **(DB)**

### Phase 3 — Field-application invoicing (13)
14. Unposted invoice list — full working-tray parity.
15. Posted invoice list — committed list + month-batch warning.
16. Invoice editor parity — all 5 tabs, locations, applied info, notifications.
17. Per-acre pricing pulled from your price book.
18. Auto-split one job into per-customer invoices by ownership share.
19. **Transfer a job → invoice** — the one-click button that's currently missing. *(the spine)*
20. Post + Unpost on the field-app invoice screen.
21. Void on the field-app invoice screen.
22. Print invoice — current + legacy formats.
23. Email invoice to customer from the field-app screen.
24. Fuel surcharge — configurable setting, **OFF by default, formula left for you**. **(DB)**
25. Header/footer notes, PO ref, due date, terms, discount-earned.
26. Customer Invoice Summary — combined chemical-sales + field-app statement.

### Phase 4 — Printouts & field paperwork (8)
27. Applicator field sheet — the crew's carry sheet (Original / Custom / Enhanced). **(DB)**
28. Loader worksheet PDF wired to field jobs (loads + per-load mix). **(DB)**
29. Chemical application report (per job).
30. Chemical summary report (across selected jobs).
31. Projected use report (forecast product needs from scheduled jobs).
32. Master mix summary (combined mix across a batch).
33. Print the job list (as-filtered).
34. Map / Logs per job + attach log files. **(DB)**

### Phase 5 — Dispatch & mobile (7)
35. Dispatch board parity (field/tablet mode).
36. Per-location dispatch + assignment (3-step wizard). **(DB)**
37. "Assigned to" tracking + dispatched-jobs list.
38. Phone/mobile applicator field view.
39. Filter jobs by recipe in the field.
40. Pre-notification to customer (before application), wired to jobs. **(DB)**
41. Post-notification to customer (after application), wired to jobs.

---

## What kicks it off
1. Your 3 in-flight branches (field-map, UI-overhaul-v2, as-applied-invoices) merge to `main`.
2. I re-audit `main` → mark which of these 41 are already done by those branches → trim the backlog to the real remainder.
3. You say **"go"** → I create the worktree and launch the loop from a CRX session (where your safety hooks + Codex gate fire).

## Defaults locked in
Parity spec = the ChemMan capture doc · weather stays on free Open-Meteo · Codex bar = fix High/Med, park Low · unknown money rules = configurable + off by default · new screens match your design system · no time/token cap · production promoted once, at the end, with your sign-off.
