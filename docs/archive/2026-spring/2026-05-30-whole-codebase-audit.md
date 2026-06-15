# Whole-Codebase Audit — 2026-05-30 (consolidated, 2 runs)

**Method:** 12-dimension multi-agent swarm (`.claude/workflows/whole-codebase-audit.js`). Each dimension gets a dedicated review agent (code + live DB, read-only); every finding is then handed to an independent adversarial verifier that tries to *refute* it against the live database and current code before it counts.

**Runs:** This report consolidates **two independent full passes** (the second was meant to re-cover dimensions the first dropped; an `args` filter bug made it re-run all 12, which gave a useful second opinion).
- Run 1 (`wplzvyk37`): 57 agents · ~3.28M tokens · ~13 min → 21 confirmed / 6 refuted.
- Run 2 (`w453y0sl5`): 69 agents · ~3.17M tokens · ~8 min → 23 confirmed / 9 refuted.

## Headline (both runs agree)

**0 BLOCKER · 0 HIGH.** No security holes, no money-corruption, no data-loss bugs survived verification across two independent passes. Security (`db-security`), business lifecycles, and migration drift came back **clean in both runs** — a strong signal, with the caveat below.

The real, actionable items are **3 MEDIUM** code issues + **1 already fixed** (the address). Everything else is LOW polish, doc drift, or dev-only.

> ⚠️ **Confidence caveat.** Both runs hit a subagent flake where some verifier agents finished without emitting a structured verdict (18 in run 1, ~25 in run 2), so some candidate findings were dropped before verification. Two dimensions — `business-lifecycle` and `test-coverage-gaps` — produced **zero** confirmed findings in *both* runs; that's a decent "clean" signal but not a guarantee. The two runs also **disagreed** on one finding (error-token style: run 1 refuted it, run 2 confirmed it as LOW), which shows the normal variance of this method.

---

## Action items — MEDIUM (3 real)

### M1 — `Order.created_by` is a ghost field → order-creator notifications silently never fire
- **Where:** [src/types/index.ts:324](src/types/index.ts:324); consumed at [OrderDetail.tsx:524](src/pages/OrderDetail.tsx:524)
- **What:** The `Order` interface declares `created_by`, but that column **does not exist** on the live `orders` table (verified: 21 columns, no `created_by`). So `order.created_by` is always `undefined`, and the "notify the order creator on status change" branch in [notificationTriggers.ts:209](src/lib/notificationTriggers.ts:209) never runs. Admins are still notified; only the secondary creator-notification is dead.
- **Fix:** remove the phantom field from the interface (and the dead arg at OrderDetail.tsx:524) **or** add a real `orders.created_by` column via migration if creator-notifications are actually wanted.

### M2 — Statement remit stub can print on top of transactions *(also flagged Run 1)*
- **Where:** [src/lib/statementPdf.ts:646](src/lib/statementPdf.ts:646), called unconditionally at [:218](src/lib/statementPdf.ts:218)
- **What:** The tear-off "mail your check here" block draws at a fixed Y with no page-space check; a statement long enough to fill the last page overprints the final rows.
- **Fix:** check remaining space and `addPage()` before drawing the stub (the `ensureSpace()` pattern already exists in [yearEndSummaryPdf.ts:104](src/lib/yearEndSummaryPdf.ts:104)).

### M3 — `process-blend-ticket` OCR has no concurrency lock → duplicate product rows
- **Where:** [supabase/functions/process-blend-ticket/index.ts:852](supabase/functions/process-blend-ticket/index.ts:852)
- **What:** The queue row is claimed non-atomically (check-then-act), and `ocr_processing_queue`/`blend_ticket_products` have no unique constraint. The 30-second OCR poller ([useOCRProcessor.ts](src/hooks/useOCRProcessor.ts)) can re-fire while a slow (>2 min) run is still in flight, so two invocations both pass the delete and both run the insert loop → duplicate extracted product rows. Self-healing on next reprocess, but a real automatic race (not just a double-click).
- **Fix:** claim the queue row atomically (`UPDATE … WHERE status='pending' RETURNING`) **or** a `pg_advisory_xact_lock` on the ticket id **or** a unique partial index.

### ✅ M4 (address) — FIXED this session
[companyInfo.ts:43](src/lib/companyInfo.ts:43) now uses the Annapolis address from `app_settings` (`9100 E 2000th Ave, Annapolis, IL 62413`), confirmed by Mason, replacing the stale Martinsville PO box. **Still open:** the letterhead `COMPANY_CITY` is "West York, IL" — confirm whether that's also correct.

---

## Notable LOW findings (worth a cleanup pass)

**Frontend safety (run 2 — the payoff of re-running)**
| Finding | Location |
|---|---|
| 3 batch-RPC calls pass the `{data,error}` wrapper to `assertRpcResult()` instead of `result.data`, making the null-guard a **no-op**, and never check `result.error` → a real RPC error degrades to a false "success" toast | [BlendTickets.tsx:256](src/pages/BlendTickets.tsx:256), [:286](src/pages/BlendTickets.tsx:286), [BlendTicketDetail.tsx:440](src/pages/BlendTicketDetail.tsx:440) |
| Stale `@sentry/react` import-allowlist entries (AuthContext, useOCRProcessor no longer import it directly) | eslint allowlist |

**Edge functions**
| Finding | Location |
|---|---|
| `process-blend-ticket` fetches OCR images from a caller/DB-controlled `image_url` with no host allowlist (SSRF-shaped) when `storage_path` is absent | process-blend-ticket/index.ts |
| `send-email` RESEND_API_KEY-missing branch + post-send `email_log` update don't surface their own write failures | send-email/index.ts |

**Customer-facing PDFs (polish)**
| Finding | Location |
|---|---|
| Year-end YoY "Change" color uses `didDrawCell` (post-render) → green/red coloring never appears + leaks color | [yearEndSummaryPdf.ts:304](src/lib/yearEndSummaryPdf.ts:304) |
| Single-page receipts (delivery/receiving/pick-list/order-summary) have no per-page footer + no overflow check on long item lists | deliveryPdf/receivingPdf/orderPickListPdf/orderSummaryPdf |
| Invoice "PAID" badge uses Tailwind green-500 instead of brand crx-green | [invoicePdf.ts:175](src/lib/invoicePdf.ts:175) |
| Quote section-header-notes advance only 4pt/line → multi-line notes overlap the items table | [quotePdf.ts:199](src/lib/quotePdf.ts:199) |
| Quote PDF: footer only on last page; magic page-break thresholds; info-grid values don't wrap *(Run 1)* | quotePdf.ts / 5 receipt PDFs |

**Types**
| Finding | Location |
|---|---|
| No `Payment` interface for the (empty/legacy) `payments` table | src/types/index.ts |

**Docs (drift — all pure text fixes)**
| Finding | Reality |
|---|---|
| CLAUDE.md self-contradicts: ~204 vs ~184 RPCs; live = **218** | CLAUDE.md:11 / :277 |
| Table count "97" vs "95"; live = **95** base tables (+2 views) | CLAUDE.md / database-schema.md |
| Migration count 356 / 363 / 364 inconsistent; disk = **365** .sql | CLAUDE.md / reference docs |
| `database-schema.md` documents 2 phantom tables (`quote_template_sections/items`) | database-schema.md |
| `pages-routes.md` has 68 rows but title/App.tsx say 66 | pages-routes.md |
| `migration-history.md` duplicate row numbers 286–289 | migration-history.md |

**Dependencies (dev-only — zero production exposure; `npm audit --omit=dev` = 0 vulns)**
| Finding | Note |
|---|---|
| esbuild ≤0.24.2 dev-server SSRF (transitive via vite) | dev-only |
| vite ≤6.4.1 path-traversal (only fix is breaking vite 5→8 — do NOT rush) | dev-only |
| `eslint-plugin-react-hooks` pinned to a 2024 RC pre-release | dev tooling |

---

## Refuted / corrected (what the skeptics killed)

- **"B7 migration version-stamp drift recurred"** *(run 2, raised MEDIUM)* — **DISPROVEN.** Verified on disk: the file is already named `20260530121737_gate_admin_only_financial_report_rpcs.sql`, matching the live version. No drift. (That migration belongs to a parallel session and is now committed.)
- **"seed-admin fails open / anyone can mint an admin"** *(both runs, raised HIGH)* — **refuted by live probe** both times: anonymous POST returns `403 Forbidden` from the `SEED_ADMIN_SECRET` gate, which fails *closed*. (Undeploying the one-time tool is optional hygiene.)
- **create-user/reset admin-on-admin**, **disk-vs-live edge drift**, **cleared CVEs still clear**, **loose `^` ranges**, **`@types/proj4` "version inversion"**, **TS nullability drift**, **invoice finance-charge double-render** — all verified as non-defects (documented design, positive confirmations, or tool-output misreads).

---

## Recommended next steps

1. **Easy wins batch** (safe, visible): the doc-drift text fixes + the small code bugs (M1 ghost field, the `assertRpcResult` no-op, the invoice badge color). Low risk, high tidiness.
2. **M2 statement PDF + M3 OCR concurrency**: small, contained fixes with patterns that already exist in the codebase — worth scheduling.
3. **Re-run note:** `business-lifecycle` and `test-coverage-gaps` were empty in both passes; if you want certainty there, a future run with the verifier-flake fixed would close it.

*Generated by the `whole-codebase-audit` workflow. Read-only — the audit modified no DB or files. The only code change this session is the M4 address fix.*
