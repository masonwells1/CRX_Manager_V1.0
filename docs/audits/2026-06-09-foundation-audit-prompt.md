# Foundation Audit Prompt — CRX Manager V1.0

**Created:** 2026-06-09
**Purpose:** Reusable prompt for a full foundational health audit before adding new
features. Run this in a dynamic-workflow session. It is **read-only** — it produces a
prioritized findings report and never edits code, writes migrations, or touches the
live DB.

**How to use:** Paste the prompt block below into a dynamic-workflow session. After it
returns the report at `docs/audits/2026-06-09-foundation-audit.md`, triage the
BLOCKER + HIGH shortlist and fix each one individually via `/ship`, then re-run this
prompt to confirm the verdict flips to **SOLID**.

---

## Prompt

```
GOAL: Full foundational health audit of CRX Manager V1.0. I am NOT adding
features until this comes back solid. I want every real bug, flawed business-logic
rule, broken page↔RPC↔lifecycle connection, money error, security hole, and
architectural fragility surfaced — with proof. This is READ-ONLY: produce a
prioritized findings report. Do NOT edit code, write migrations, or touch the
live DB. I'll triage fixes afterward one at a time through /ship.

RUN THESE FOUR AUDIT LAYERS — dispatch the independent ones in parallel:

1. /whole-codebase-audit
   — security, migrations, money-as-cents, type drift, PDFs, edge functions,
     lifecycles, frontend safety, docs, deps, tests.

2. /review-workflow
   — the "is my foundation solid enough to build on?" logic check:
     graph/connection layer, entity lifecycles, cross-entity flows, invariants.

3. /map-drift-audit
   — reconcile the workflow map's page↔RPC↔lifecycle↔RLS claims against the
     LIVE database + actual code. Flag anything wired wrong or drifted.

4. /architecture-weakness-audit
   — fragility pass: single points of failure, double-submit/race windows,
     atomicity gaps, missing reversals/defenses on the busiest nodes.

VERIFICATION GATE (mandatory — this is the whole point):
Every BLOCKER and HIGH finding MUST be adversarially verified against the live
DB or the actual code BEFORE it lands in the report. Cite file:line, the
migration stamp, the CHECK constraint, or the RPC name. If a finding can't be
proven, mark it REFUTED and say why. I've been burned by false-positive audit
findings before — I trust verified findings only.

CROSS-CHECK against my CLAUDE.md Hard Red Lines specifically:
  - money stored as bigint cents, never float
  - every table has RLS; no service_role in frontend
  - no invoice without order_id OR blend_ticket_id (credit_memo exempt)
  - delivery scheduled→in_progress→completed flow + item-lock rules
  - financial_audit_log append-only
  - SECURITY DEFINER funcs have search_path; mutating RPCs take p_idempotency_key
  - no actor-forgery (forgeable p_performed_by without ACTOR_MISMATCH)
  - all the entity lifecycles in the Business Logic section

OUTPUT — one consolidated report saved to
docs/audits/2026-06-09-foundation-audit.md, structured as:
  - Verdict (SOLID / SOLID-WITH-FOLLOWUPS / NEEDS-WORK)
  - Findings table: severity (BLOCKER/HIGH/MED/LOW) | area | file:line or
    migration/RPC | one-line description | proof | suggested fix
  - REFUTED candidates (what looked scary but wasn't, + why)
  - Deduped: if multiple layers flag the same root cause, merge into one row
  - A prioritized "fix these first" shortlist (BLOCKER + HIGH only)

Do NOT push, commit, deploy, or apply anything. Stop at the written report.
```

---

## Why it's built this way

- **Reuses the four existing audit skills** instead of reinventing the wheel. Each
  covers a different failure axis — `/review-workflow` (correctness),
  `/map-drift-audit` (consistency), `/architecture-weakness-audit` (fragility),
  `/whole-codebase-audit` (wide health) — and together they answer the "solid
  foundation" question from four angles.
- **Read-only + report-only is deliberate.** A wide audit that also auto-fixes is how
  you introduce *new* bugs mid-audit. Get verified findings first, then feed each
  BLOCKER/HIGH into `/ship` individually so it goes through the normal review gate.
- **The verification gate is the load-bearing part.** The project history is full of
  audit findings that were false positives (the `'void'`/`'voided'` scare, the
  `allocate_payment` actor-forgery false positive, the `record_payment` double-pay
  scare). Forcing proof-before-report is what makes the output trustworthy.
- **Dedup + prioritized shortlist** keeps it actionable — four parallel audits will
  overlap, and you want one clean list, not four.

## Triage loop after the report

1. Read `docs/audits/2026-06-09-foundation-audit.md`; focus on the BLOCKER + HIGH
   shortlist.
2. For each finding to fix: `/ship <the finding>` — re-reviews, applies the migration
   if needed, and stops before push for approval.
3. Re-run this same prompt after the fixes to confirm the verdict flipped to **SOLID**.
