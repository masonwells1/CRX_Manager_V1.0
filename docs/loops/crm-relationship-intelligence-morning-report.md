# CRM Relationship Intelligence — Morning Report (2026-07-17)

**TL;DR: All four phases are LIVE in production.** Your app now has a full customer-relationship layer: contact cards with call logging, a grower knowledge base with a review queue, a call prep card, five seasonal call lists, and per-customer document storage — all built AI-receptionist-ready for Phase 5. Every migration went through the double adversarial gauntlet (Claude reviewers + Codex) before touching the live database, every phase was gated by Sol before merging, and the deployed site was byte-verified after each merge.

## What shipped (croprxsolutions.app, live now)

| Phase | What you'll see | Shipped via |
|---|---|---|
| 1 — Contacts + call logging | **Contacts tab** on every customer: multiple people per farm, primary contact, click-to-call, roles/permissions. **Log call** button: 30-second flow for type/outcome/summary + optional follow-up task. | PR #145 |
| 2 — Grower knowledge + prep card | **Knowledge tab**: facts about each grower (acres, preferences, dislikes) with a verify/reject review queue, correction history, and renewals. **Call Prep card** on the info tab: contact, balances, last invoice/conversation, open work, "know before you call" facts. | PR #149 |
| 3 — Seasonal call lists | **Call Lists page** (sidebar → Customers & Fields): prepay prospects, no-recent-contact, stale quotes, lapsed products, unassigned accounts. Filters by rep (admins) and tier; per-row prep peek, click-to-call, log-call. | PR #150 |
| 4 — Customer documents | **Documents tab**: upload licenses/permits/contracts/maps per customer (20MB, PDF/images), expiring-soon warnings, downloads, soft-delete. Files are private — reps only ever see their own customers' documents. | PR #151 |

Two call lists (prepay prospects, lapsed products) are **correctly empty right now**: they compare this season to last season, and the live database has no prior-season invoices yet (first season on CRX). They start filling at season rollover.

## The safety story (what the gauntlet caught before it could hurt)

10 migrations-worth of schema went live tonight, every one through: independent security review + drift review + adversarial Codex verdict + hash-bound proofs + a live smoke test inside a rolled-back transaction (zero residue). Sol then gated each phase's full diff — 12 gate rounds total, and the blocks were earning their keep:

- **A Save button that did nothing** (fact modal — caught by orchestrator review before commit).
- **A correction rule that would have permanently locked expired facts** (Sol) — fixed with a schema amendment, where Codex then caught a retry-ordering subtlety in the fix itself.
- **Cross-customer data flashes**: fast navigation between customers could briefly show one grower's balances or facts under another's name (Sol, twice, at increasing depth) — fixed structurally with per-customer remounts.
- **Rep uploads that would have failed 100% of the time** (Codex): a security hardening collided with how Supabase's storage engine returns new files. Both Claude reviewers had signed it off; Codex's round-2 refutation was correct and documented.
- **A test-worker crash that exposed a render-loop trap** in the toast system's test harness (and a real render-efficiency fix in the app).
- **Final sweep**: cross-phase drift (duplicate money parser, missing confirm dialog, inconsistent actor sourcing, 11 unregistered error tokens) — all fixed; live privilege audit of every new object came back clean, with anon/public lockout proven against the running database.

## Final gauntlet verdicts (whole-loop, fresh eyes)
- Compliance (conventions + red lines): 0 blockers; 2 HIGH + 5 MED cross-phase drift findings — 6 fixed, 1 tracked (below).
- Types-vs-live drift: **zero drift**; one registry transcription defect found and repaired.
- Security (system-level, live-verified): **CLEAN** — anon/PUBLIC lockout proven live on all 6 tables + 12 functions + the bucket; Phase-5 provenance seams confirmed intact.
- Sol whole-loop review: {{SOL_FINAL_VERDICT}}

## Decisions parked for you (nothing blocking)
1. **`save_customer` permission gap (pre-existing, NOT from this loop):** any sales rep can currently edit any customer, including credit fields. A task chip is ready to spin off the fix — you decide: restrict edits to the assigned rep + admins, or keep office-manager-style open editing?
2. **Call-log double-entry protection:** a rep retrying after a network timeout could log the same call twice. Task chip ready (needs a small server-side function through the review gauntlet).
3. **Crop filter on call lists:** deferred because "what a grower grows" has no single source — field crop-history vs notes. Which should count, and is it worth adding?
4. **Top-products ranking:** currently by invoiced revenue; you may prefer quantity for chemistry-volume thinking.
5. **Recording/AI-disclosure wording + transcript retention:** defaults chosen; your approval needed before the Phase-5 voice vendor goes live.

## Phase 5 readiness (the AI receptionist this was built for)
The seams are in place: phone-number lookup via `external_identities`, webhook-idempotent call/transcript intake with immutable provenance, facts consumable through the prep card, per-channel source tagging (`ai_receptionist` is a first-class value everywhere), consent fields on transcripts. Design notes for the intake endpoints are in the ledger ("Phase 5 design notes").

## Where everything lives
- Full audit trail: `docs/loops/crm-relationship-intelligence-ledger.md` (every unit, verdict, and proof)
- Mission doc: `docs/loops/crm-relationship-intelligence-loop-2026-07-16.md`
- Migration details: `docs/reference/migration-history.md` rows 671–678
