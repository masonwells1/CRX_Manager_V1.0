# Archive — 2026 Summer Closeout (moved 2026-07-16)

Docs for work that is **fully shipped, merged, and live** (or reviews that are fully
dispositioned), moved out of the active folders during the 2026-07-16 full docs
review/cleanup so the live folders only contain in-flight work. Every "done" claim
was re-verified against code on disk and the live database before the move
(subagent verification pass, recorded in that day's `docs/CHANGELOG.md` entry).

⚠️ As with every archive folder: **verify current live behavior in code and the live
database before acting on anything in here.** Statuses inside these files are frozen
at their last edit and several were already stale at archive time (that's why they
were archived).

## What moved where

- **`loops/`** (from `docs/loops/`) — mission specs, morning reports, and ledgers for
  completed build loops: business-workflow fix nights 1–2, inventory Layer 2,
  mobile overhaul, UI overhaul, structure-fix Wave A, workflow-waves morning report,
  billing-day + money/inventory night mission docs.
  - Note: `structure-fix-ledger.md` contains the only record of the **deferred
    month-end-close picker UI** (A9) — that open item now lives in root `TODO.md` §4.
  - Kept live in `docs/loops/` (still cited by KNOWN_ISSUES/CHANGELOG/scripts):
    `owner-decisions-2026-07.md`, `business-workflow-fix-ledger.md`,
    `workflow-waves-ledger.md`, `billing-day-money-ledger.md`,
    `business-workflow-junk-customer-flags.md`, `structure-wave-2-*`,
    `workflow-waves-loop-2026-07.md`, `billing-day-money-loop-2026-07-08.md`.
- **`roadmap/`** (from `docs/roadmap/`) — plan/spec docs for shipped programs:
  sell-side G5 (execution plan, kickoff, go-live runbook), Inventory Layer 2 handoff,
  field mapping/per-acre billing trio, Field Mode build plan, app-wide structure
  audit, product-units scheduling deep-dive.
  - Note: the structure audit's **TIER-2 split-billing design decision** and the
    deep-dive's **Phase 4/5 scheduling leftovers** are still open — tracked in root
    `TODO.md` §4.
- **`plans/`** — the as-applied invoices plan (shipped 2026-06-21) and, kept live
  instead: the grower-portal vision docs (still the active vision) and
  `sprayer-packet-feature-todo.md` (still open).
- **`handoffs/`** — the Codex push-harness handoff (implemented, ACTIVE since 2026-07-14).
- **`audits/`** (from `docs/audits/`) — June 2–18 + early-July one-time review-cycle
  artifacts (Codex prompts, Claude dispositions, handoffs) whose findings are all
  dispositioned and whose fixes are all applied live. Anything still cited by
  `CLAUDE.md`, `docs/CHANGELOG.md`, `docs/reference/migration-history.md`,
  hooks, or scripts stayed in `docs/audits/`.

Related: the ChemMan-parity walkthrough research (`GAP-ANALYSIS.md` + extracted
transcripts) moved to `docs/archive/2026-summer/` alongside the rest of that program.

## Second batch — moved 2026-07-26

A follow-up sweep of `docs/build-loops/`, `docs/handoffs/`, and `docs/superpowers/`.
Only files that are both **finished** and **referenced by nothing else in the repo**
moved; every candidate was checked for inbound references (docs, scripts, hooks,
workflows, migrations) and for open owner decisions before being touched.

- **`build-loops/ui-overhaul/`, `build-loops/ui-overhaul-v2/`** (from
  `docs/build-loops/`) — both loops shipped live 2026-06-23/24 and were merged and
  deployed. Zero database changes in either.
  - Note: `ui-overhaul-v2/STATE.md` records one never-closed owner item — Mason's
    in-app click-test of the three write buttons (Convert / Complete / Receive)
    against real data. The features have been live since 2026-06-24.
- **`superpowers/plans/`, `superpowers/specs/`** (from `docs/superpowers/`) — the
  2026-06-14 design plan and spec for the Codex review gauntlet. The gauntlet was
  built; its live documentation is `docs/workflows/CODEX_REVIEW_GAUNTLET.md`.
- **`handoffs/`** — the 2026-07-16 scaffolding-review handoff (review delivered as
  `docs/audits/2026-07-16-scaffolding-design-review.md`) and the supplier-pricing
  Phase 1A goal (Phase 1A/1B closed out; Phase 3 Stage B2 shipped 2026-07-26).

Deliberately **kept live** in this sweep, with the reason:

- `docs/audits/nightly-debug/`, `docs/audits/overnight-bug-hunt/`,
  `docs/audits/codex-driven-bug-hunt/` — these are **live output paths** written by
  `.claude/workflows/` scripts, not finished artifacts.
- `docs/build-loops/b1-lot-capture-trace/` — its `HANDOFF.md` is the only record of
  a deferred `LotsEditorModal` save/close-race follow-up.
- `docs/build-loops/field-map-ux/` — holds a parked owner decision (the F2 auto-nudge).
- `docs/build-loops/field-acre-billing*/` — `PHASE0-GROUNDING.md` is cited by two
  applied migrations, which are immutable and cannot be repointed.
- `docs/audits/2026-06-19-future-projects-idea-mining/` — `UNIFIED-LONG-TERM-PLAN.md`
  is still the stated source of truth for future-project direction.
- `docs/plans/CRX-*label-data*.csv` — the label-data load is still an open owner
  data-entry job.
