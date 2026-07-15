# CRX Manager — 3–6 Month Roadmap & Execution Plan (2026-07-15)

**Author:** Senior product architect (final handoff). **Audience:** Mason + future junior-level engineering sessions.
**Grounding:** origin/main @ a9271769 (PR #132 merged), live `schema_migrations` read 2026-07-15, live counts from `docs/manual/CURRENT_STATE.md` (2026-07-13), gauntlet audits (incl. 2026-07-15 §8 refresh), `docs/research/` deep-dive + open-source comparison, TODO.md, KNOWN_ISSUES.md, recent CHANGELOG.

> ⚠️ **Standing warning for every future session:** several `docs/roadmap/` plan docs are STALE (sell-side G5, Inventory Layer 2, EPA Stage 1 all say "open" but shipped live in June/July). Never build from a plan doc without first verifying live state (git ancestry + `list_migrations` + live reads). `docs/manual/CURRENT_STATE.md` and `docs/CHANGELOG.md` outrank plan docs.

---

## 1. North-star vision (plain English)

**CRX Manager becomes the system that runs Crop RX's entire season — and gets paid for it.** Every acre applied gets billed, every invoice can be paid online, every chemical application is compliance-provable on demand, and Mason runs the business from the Office Cockpit every morning without a spreadsheet on the side.

The identity, in order: **(1) billing engine you can trust, (2) cash-collection machine, (3) compliance evidence system.** The command-center and inventory-brain ideas are supporting features of those three, not the next product.

**Why this order:** the app is feature-rich but the live database shows the real bottleneck — 153 customers and 604 products loaded, but only 8 invoices, 0 payments, 0 deliveries, 4 fields. The constraint is not missing features; it is (a) real usage/data, and (b) the owner-side inputs the built features are waiting on. Research confirms the #1 competitive gap is customer payments (every competitor has a portal + online pay; Stripe ACH is fee-capped at $5), and the weakest scored area is compliance (2.5/5) despite the data already being captured. Grower portal is the destination, but it only pays off after real invoices flow.

---

## 2. Ranked Now / Next / Later / Do-Not-Do

### NOW (weeks 0–6) — "Prove the money loop on real data"
| # | Item | Why first |
|---|---|---|
| N1 | **Close the gauntlet.** Status as of 2026-07-15 midday: PR #132 merged AND four fix migrations applied live (`20260715115155` return-lifecycle hardening, `20260714185129` commission admin policies, `20260714185130` batch-prepay admin gate, `20260714185631` is_admin search_path) — most surviving HIGHs are now landed. Remaining: re-run gauntlet §5–§8 from *fresh main* to confirm closure with live evidence (prior audit runs used stale checkouts), update the remediation LEDGER, and fix anything that genuinely survives (e.g. return actor binding, `save_job_applied_record`/`create_commission_payment` gaps if not already covered). | Foundation must be quiet before adoption ramps |
| N2 | **Regenerate the schema registry** (`/regen-schema-registry` from live introspection) — 8+ applied migrations (the 2026-07-14 batch plus the four applied 2026-07-15) are past the registry high-water; schema-aware hooks are validating stale data right now. | Guard integrity |
| N3 | **Offline Stage 1B production proof** — verify PR #124 actually landed the browser rollout, then run the real-phone proof (lost-response recovery, two-tab replay, office resolution) with `[E2E]` fixtures. | Field completions touch inventory + billing |
| N4 | **First real billing cycle** — Mason routes real orders → deliveries → invoices → posting → payments through the app; then re-run `/foundation-ultra-review` money audits on non-empty data (prior audits were "vacuously clean"). | Everything downstream compounds off this |
| N5 | **Owner data unblocks** — 17 negative-inventory products re-based (blocks deliveries!), junk-data delete packet, label-data load via `/label-data-quality`. | Cheap, unblocks built features |

### NEXT (weeks 6–14) — "Open the cash door + compliance quick wins"
| # | Item | Notes |
|---|---|---|
| X1 | **A1 — ACH pay-now links** on emailed invoices/statements (Stripe ACH, webhook edge function). | Blocked only on Mason creating a Stripe account. #1 gap vs. every competitor |
| X2 | **EPA backfill Waves 4–5** — fix the ~105 wrong stored EPA reg numbers with the shipped bulk tool. | Data-entry + reviewed bulk-apply; gates all compliance features |
| X3 | **B4 — REI/PHI tracking per field + dispatch warnings**; then **B2 — dicamba 72-hour record auto-draft**. | Data already captured; compliance is the weakest scored area |
| X4 | **E4 — field-level profitability** (margin per acre per field/customer/season). | Both data halves already in schema |
| X5 | **P1/P3 portal prework** — customer-organization model + server-side PDF generation. | Gates the portal; do NOT start portal UI before this |
| X6 | **D1 — vendor-bill AI extraction pilot** (10-bill accuracy gate first). | Blocked on Mason: sample bills + Anthropic key |

### LATER (months 3–6) — "The two strategic bets"
| # | Item | Gate |
|---|---|---|
| L1 | **A2 — Grower portal v1** (login, balance, statements, invoice PDFs, pay) + **A3** quote e-sign + **A4** autopay | After A1 click-through data + P1/P3 done. Separate app, same DB, `customer` role + `portal_*` RPCs per settled design |
| L2 | **C1 — ISOXML/ADAPT as-applied upload → review queue** | Collect 3 real monitor files first (cheap test) |
| L3 | **C2 — suggested reorders / auto-PO** (classical reorder points, no ML) | After a season of real inventory movement |
| L4 | **Feature B residual-ledger redesign** (per-delivery split billing) + **earmark reserved-pool redesign** | Only if real usage hits the parked limitation; both are settled design blockers, not build tickets |
| L5 | **H2 — migration-baseline squash** (584+ files) | Quiet window only, deliberate ceremony |

### DO NOT DO (don't re-add without new evidence — from the settled research verdicts)
Native iOS/Android apps · multi-tenancy now · ML demand forecasting · autonomous AI touching financial records · QuickBooks two-way sync · grain/energy/feed/seed-treatment modules · big-bang UI redesign / role-workspace IA (E2) before portal+mobile usage data · OCR REI/PHI auto-fill (safety trap — per-crop values need human verification) · re-enabling `apply_remaining_prepayments`/`batch_apply_all_prepayments` (hard-disabled) · applying the 3 shelved earmark migrations as-is · broad offline **money** mutations (offline stays evidence-first) · platform rewrites · customizable money/status logic.

---

## 3. Refactor decision table

| Area | Verdict | Reasoning |
|---|---|---|
| Dead structure: `#40` orphaned RPC, `setup-blend-tickets-storage` dead edge fn, stale `scripts/.staging-migrations/workflow-fix-parked/u12,u13` folders, wire-vs-retire packet items | **REFACTOR (small, now)** | Confirmed dead; deleting reduces junior-model confusion. Each is a 1-ticket cleanup with an easy proof |
| Schema registry + docs drift (registry stale, plan docs contradict live state) | **REFACTOR (process, now)** | Stale references are the #1 way lower models get misled |
| `apply_prepay_to_invoice` hand-decrement (trigger also recomputes) | **DEFER** | Same end state today; drop only after more prod watching |
| Migration history squash (H2) | **DEFER to quiet window** | Valuable but risky; needs its own ceremony |
| Invoice "four-lever" balance model (adding a 5th lever) | **DO NOT** | Settled: a 5th lever desyncs every inline consumer; credit-memo apply was designed around this |
| Role-workspace IA redesign (82 flat pages → workspaces) | **DO NOT (yet)** | Explicitly gated on portal + mobile usage data (H3/E2) |
| `unit_conversions` strings, frozen enum/status values | **DO NOT TOUCH** | Frozen keys; breaking them corrupts historical data |
| Edge-function CORS/`db.ts` global-fetch coupling | **DEFER, document-only** | Known coupling (2026-07-12 outage); fix only alongside the next edge-fn feature (A1 webhook), never as a drive-by |
| React pages that "look messy" but work | **DO NOT** | Zero live bugs attributed to page structure; refactor risk > reward while test flake exists |

---

## 4. Owner actions that block the biggest value (ranked)

1. **Re-base the 17 negative-inventory products** (physical counts → adjustment workflow) — literally blocks deliveries.
2. **Use the app for a real billing cycle** — every money audit so far is vacuously clean on ~0 rows.
3. **Create a Stripe account and hand over API keys** (~15 min) — unblocks A1 now and the portal later.
4. **Label-data load + approve EPA backfill** — compliance/WPS/spray-safety features render blank until then.
5. **Decision packets** (from `docs/loops/owner-decisions-2026-07.md` + KNOWN_ISSUES §3): junk-data deletes, vendor-name merges, category remap, "wire" payment method, #107 auto-draft-on-applicator policy, D3 commission halves.
6. **Send ~10 real vendor bills + Anthropic API key** — unblocks D1 pilot.
7. **Supabase Pro upgrade decision** — once real money flows, PITR + leaked-password protection stop being optional (FREE plan today; weekly dumps are the only recovery). Also: **run the first `/backup-db`** — the session check says no dump exists yet.
8. **Create the staging Supabase project + GitHub secrets** — unblocks the parked E2E CI lane.

---

## 5. Lower-model execution board

**Routing rule (which model does what):**
- **Lower models (Sonnet-class / gpt-5.6-luna):** docs cleanup, dead-code retirement, UI-only changes following an existing pattern, test additions, registry/docs regeneration. Never migrations, money math, RLS, or edge functions.
- **Codex (gpt-5.6-terra/sol) builds, per the settled loop-driver model:** SQL/RPC implementation, migration drafting.
- **Fable/Opus + mandatory Codex review gate:** anything touching money, RLS, SECURITY DEFINER, migrations, edge functions, or multi-file business logic. SQL/RLS/money changes require an *actual Codex verdict in-session* before apply/push (not queued).
- **Every migration:** `/migration-review` → apply-guard proof → Mason's in-chat OK (or armed-autopilot per the 2026-07-13 policy). Destructive migrations are never autonomous.
- **Universal proof standard:** "done" = ran and observed (page opened / RPC executed / row SELECTed), never "tests pass." State a PROOF line with what ran and what was seen.

| ID | Ticket | Files / systems | Model | Proof required |
|---|---|---|---|---|
| T1 | Regenerate schema registry from live introspection | `.claude/schema-registry.json` via `/regen-schema-registry` | Lower | Registry high-water ≥ 20260714224000; staleness hook silent on next session start |
| T2 | ~~Merge return-lifecycle hardening branch~~ **DONE 2026-07-15** — PR #132 merged, migration `20260715115155` applied live (verified in `schema_migrations`). Ticket reduces to: update the gauntlet remediation LEDGER + KNOWN_ISSUES to record it. | `docs/audits/gauntlet/sections-2-15-remediation-LEDGER.md`, `docs/manual/KNOWN_ISSUES.md` | Lower | Docs match live `schema_migrations` entries |
| T3 | Re-run gauntlet §5–§8 from fresh main; close survivors | `docs/audits/gauntlet/` refresh; fix migrations only for what survives the re-check (most §7/§8 HIGHs were applied live 2026-07-15 — verify, don't re-fix) | Fable + Codex gate | Refreshed section reports cite live evidence; each fix has live policy/function read-back |
| T4 | Delete dead structure batch | `supabase/functions/setup-blend-tickets-storage/`, `scripts/.staging-migrations/workflow-fix-parked/{u12,u13}/`, #40 RPC retire migration | Lower (retire migration via Codex gate) | Grep zero references; build+tests green; for the RPC: migration review + live `pg_proc` shows it gone |
| T5 | Offline Stage 1B real-phone proof | No code (unless bugs found); `[E2E]` fixtures on prod | Fable orchestrating, phone in hand | Documented proof file: lost-response recovery, two-tab replay, office `already_completed` resolution each observed live |
| T6 | Stripe ACH pay-now links (A1) | New edge fn (webhook) + `send-email` template change + invoices/statements PDF link + payment recording RPC | Fable + Codex gate; edge deploy needs Mason OK | Test-mode Stripe: click link → pay → webhook posts payment → invoice balance updates → `financial_audit_log` row; screenshot + SELECT evidence |
| T7 | EPA backfill Waves 4–5 execution | `/label-data-quality` bulk tool (shipped); MCP-subagent backup first | Lower, supervised | Pre/post counts of wrong reg numbers (≈105 → ~0); spot-check 10 products against EPA source |
| T8 | REI/PHI per-field tracking + dispatch warnings (B4) | `products` REI/PHI columns (exist) → job/dispatch UI warnings; possibly 1 migration for field-level applied-at stamps | Fable + Codex gate if migration | Open DispatchBoard with a field inside REI window → warning renders; console clean; role-tested (admin + applicator) |
| T9 | Dicamba 72-hour record auto-draft (B2) | New RPC + PDF template + JobDetail button | Codex build + Fable review | Complete a dicamba `[E2E]` job → draft record generated with correct fields; PDF renders; `pdf-output-reviewer` pass |
| T10 | Field-level profitability report (E4) | New page + read-only RPC (costs vs. billed by field/season) | Codex build + Fable review | Known `[E2E]` fixture math checks to the cent; page renders; no float money anywhere |
| T11 | Customer-organization model prework (P1) | Schema design doc first → migration + `src/types/index.ts` | Fable design; Codex build; full gate | Design doc approved by Mason BEFORE migration; drift + RLS reviewers clean; live read-back |
| T12 | Server-side PDF generation prework (P3) | New edge fn or service; keep jsPDF client path working in parallel | Fable + Codex gate; deploy needs Mason OK | Same invoice renders byte-comparable content server-side vs. client; `pdf-output-reviewer` pass |
| T13 | Vendor-bill extraction pilot (D1) | `process-document` pattern reuse; accuracy harness on 10 real bills | Codex build + Fable review | ≥9/10 bills extracted correctly in the manual gate BEFORE any production wiring |
| T14 | Workflow-review leftovers (#106, #109, #117) | Small migrations + activity-feed rows per `business-workflow-fix-ledger.md` | Codex + gate | Each: migration review + observed activity-feed/report row |
| T15 | First real-data money audit re-run | `/foundation-ultra-review` after N4 billing cycle | Fable (read-only) | Report on non-empty invoices/payments; findings ledgered, not silently fixed |

**Ticket-writing rules for whoever runs this board:** one ticket = one reviewable change; name expected files up front; plain-English plan to Mason before any multi-file/SQL/money ticket; hard caps (3 review rounds); never let a lower model self-certify a migration.

---

## 6. The first 5 tasks Mason should run (in order)

1. **"Close out the gauntlet"** — one session: `/regen-schema-registry`, re-run §5–§8 fresh to confirm the fixes that landed live on 2026-07-15, update the ledger, land anything that survives (T1–T3). Also say **"back up the database"** — no dump exists yet.
2. **"Fix my 17 negative inventory products"** — bring physical counts; the session walks the adjustment workflow (unblocks deliveries).
3. **Run a real billing cycle yourself** — real order → delivery → invoice → post → payment in the live app; note anything that feels wrong; then ask for the money audit re-run (T15).
4. **Create the Stripe account** (~15 min) and start ticket T6 (ACH pay-now links) — the single highest-ROI feature on the board.
5. **Label-data session** — load label data with `/label-data-quality` and approve the Wave 4–5 EPA backfill (T7), which switches on the whole compliance track (T8/T9).

---

## 7. Answers to the framing questions (index)

1. **What CRX becomes:** billing engine → cash-collection → compliance evidence (§1). Command-center/inventory-brain are features, not the direction.
2. **Top 10 ROI actions:** N1–N5, X1–X4, then L1 (§2).
3. **Not yet:** everything in LATER + Do-Not-Do (§2) — most importantly portal UI before P1/P3, and any parked-design item (Feature B, earmark) without a fresh architectural pass.
4. **Refactor where / where not:** §3.
5. **Owner blockers:** §4.
6. **Model routing:** §5 routing rule.
7. **Verification per task:** §5 proof column + universal proof standard.
