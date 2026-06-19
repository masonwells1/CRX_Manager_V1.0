# As-Applied / Field Invoices — Overnight Build Handoff (for Mason's morning review)

**Branch:** `feat/as-applied-invoices` · **Plan:** [`docs/plans/2026-06-18-as-applied-application-invoices-plan.md`](../plans/2026-06-18-as-applied-application-invoices-plan.md)
**Rule in force:** the loop SKIPS anything it needs you for, logs it here, and keeps building (Mason, 2026-06-18). Nothing went live overnight — all go-live steps are parked for your one-click approval.

---

## ✅ Built & committed (on the branch, NOT live)

| Phase | What | Commit | Proof |
|---|---|---|---|
| 1a | **Separate "Field Invoices" area** — new top-level `/field-invoices` page listing only Application (`field_application`) invoices, with its own Unposted/Posted/Outstanding cards, status filter, search, CSV + PDF export, and a "New Field Application" button. New nav item under **Sales** + permission entry (admin/sales_rep). **Does NOT touch Chemical Sales.** | `2911d5d` | typecheck ✓ · lint ✓ · pagePermissions test 30/30 ✓ · build ✓ |

---

## 🅿️ NEEDS MASON / PARKED (review in the morning)

### Approvals you'll click through (none yet — added as the loop parks live migrations)
*(empty so far — Phase 1c/2/3/4 migrations land here with a plain-English explainer + a one-click "approve to apply")*

### Decisions / FYIs for you
- **P-1 (FYI, low):** Phase 1a's `FieldInvoices` list is a **deliberate standalone page**, not a refactor of the Chemical Sales `Invoices.tsx`, to guarantee it can't break Chemical Sales while you were asleep. It shares some structure with `Invoices.tsx`. **Follow-up (with you awake):** consider extracting a shared list component to DRY them up. No action needed now.
- **P-2 (FYI, low):** Phase 1a intentionally has **no batch post/void/print on the list** yet — you post/void/print a field invoice by opening it (the detail screen already does this). Batch actions on the field list are an easy follow-up.
- **P-3 (pending):** **Codex review of Phase 1a is still pending** — deferred to keep the context lean for the fresh session, which will run it first. (Frontend-only, isolated, so low risk.)

---

## ▶️ How the loop resumes (fresh session, lean context)
All state needed to continue lives in committed files + `.claude/session-state/as-applied-loop-instructions.md` + `.claude/session-state/as-applied-progress.json`. The next session Codex-reviews Phase 1a, then continues: **1b** prove the loop (rolled-back smoke) → **1c** converge the billing rail (parks a migration) → **2** reconciliation view → **3** weather snapshot (internal) → **4** recipe pricing. **5** (controller import) stays deferred (needs the Raven/John Deere format from you).

_Last updated: after Phase 1a commit 2911d5d._
