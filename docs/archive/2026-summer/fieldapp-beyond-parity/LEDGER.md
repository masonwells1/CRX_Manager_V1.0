# Field-App Beyond-Parity Loop — LEDGER

**State: 🚀 SHIPPED LIVE 2026-06-30.** All 6 sections applied to production. All **9** migrations (`20260629210000`→`20260630170000`) applied to live Supabase + verified (RLS / search_path / anon-revoked / 1-overload each; complete_job never posts; per-customer proof no leak; advisor +0, sweeps +0). Frontend fast-forwarded to `main` (`87de1233`) → Vercel deployed (pre-push typecheck+build PASSED; site HTTP 200). send-email edge fn = NO deploy needed (live v14 already allows `post_application_notice`). Go-live re-gate fixed 2 Codex mediums (watchdog `normalize_rate_unit` in new migration `20260630170000`; cockpit "Post all clean" freshness guard). Switches safe-by-default (`auto_draft_invoice_on_job_completion`=false, `label_rate_guardrail_mode`=warn). Remaining = OWNER tasks: §1 label-data load + optional toggle flips.
**Owner decision (2026-06-29):** grower portal §7–§10 SKIPPED this round.

## Progress: 6 / 6 sections built (portal §7–§10 deferred)

| # | Section | Status | Migration(s) | Commit | Notes |
|---|---------|--------|--------------|--------|-------|
| 1 | AI Label-Data Backfill | ✅ BUILT | `20260629210000` | `1711f135` | 8 Codex rounds; staging+review+coverage; PROD label load = Mason's task |
| 2 | Watchdog (wrong-field/rate/double-bill/REI) | ✅ BUILT | `20260629220000`,`230000`,`240000` | `a1034286` | runtime bug + 3 correctness/sec fixed; banner wired + auto-refresh + applied-record REI |
| 3 | Office Cockpit | ✅ BUILT | none (read-only) | `281253eb` | 7-tile exception dashboard; overdue-AR + admin-link fixed |
| 4 | Auto-Invoice on completion (MONEY) | ✅ BUILT | `20260630073344` | `eca3febb` | auto-DRAFT only/never posts/OFF by default/idempotent/office-completions-only; modifies `complete_job` (drift-safe) |
| 5 | Label-Rate Guardrails | ✅ BUILT | `20260630122212` (settings seed) | `c6ade0ea` | WARN default (never blocks); REI/PHI; PHI-vs-harvest; block-mode override logged |
| 6 | "Your Field Was Sprayed" proof notification | ✅ BUILT | `20260630120000`,`160000` | `30e4147a` | office one-tap send (never silent); per-customer scoping (no leak); edge-fn PREPARED not deployed |
| 7–10 | Grower Portal | ⏸ DEFERRED | — | — | not this round (Mason) |

## Production gate — apply MIGRATIONS in TIMESTAMP order (8 total)
1. `20260629210000_product_label_drafts.sql` — §1 staging table + products.max_label_rate cols + 4 RPCs (anon revoked)
2. `20260629220000_watchdog_flags.sql` — §2 watchdog_flags + dismissals + RPCs
3. `20260629230000_watchdog_flags_p2_fixes.sql` — §2 sweep fixes (partial-index upsert)
4. `20260629240000_watchdog_rei_applied_records.sql` — §2 REI from applied records
5. `20260630073344_auto_draft_invoice_on_job_completion.sql` — §4 **modifies core `complete_job`** (drift-safe verbatim + auto-draft block) + OFF-by-default setting
6. `20260630120000_job_proof_data.sql` — §6 `get_job_proof_data` (read-only); **superseded in same gate by** →
7. `20260630122212_label_rate_guardrail_setting.sql` — §5 guardrail-mode setting (warn default)
8. `20260630160000_job_proof_data_per_customer_applied_acres.sql` — §6 drops the 1-arg `get_job_proof_data`, creates the 2-arg (per-customer + applied-acres) form
- At apply: bind each apply-guard proof to the **TRANSMITTED** SQL hash (MCP strips a trailing newline). Run the 5 migration reviewers + a real Codex pass. After applying: `/regen-schema-registry` + the db-invariant-sweeps.

## Production gate — OWNER actions (need Mason)
- **Deploy the `send-email` edge function** — activates §6's customer proof email (PREPARED in code; `post_application_notice` already in the allow-list). Real customer email only sends after this. `vercel.json` CSP `img-src += staticmap.openstreetmap.de` ships with the code deploy.
- **§1 label-data load** — review-and-approve the AI-drafted REI/PHI/signal/EPA/max-rate values onto the 604 live products (Mason's compliance task; wrong values are a hazard).
- **Decisions (all reversible settings, default safe):** enable **auto-draft** (`auto_draft_invoice_on_job_completion`, default OFF) · enable **hard-block** rate mode (`label_rate_guardrail_mode`, default 'warn') — both can stay off.
- **Live Vision extraction** (§1) needs `GOOGLE_VISION_API_KEY` + the edge fn — separate, owner-gated. The review/accept/coverage tool works without it.

## Parked-Low (follow-ups, none blocking)
- §1: P3 create idempotency check→insert race (idempotency_keys unique key + ON CONFLICT already prevents dup-key rows); errMessage applied to §1 only (house-wide pattern).
- §2: 2 REI-precision edges (completion-vs-start time; per-pass) — advisory flag, real field data is the true test.
- §3: P3 info-severity watchdog flags render red (cosmetic).
- §5: override-audit atomicity is app-layer (deferred-after-success + loud error), not a single txn — documented trade-off.
- §6: static boundary-map = OSM pinned snapshot + deep link; full polygon-on-tile render is a follow-on.

## §6 lesson (recorded)
The §6 subagent's Codex CLI kept crashing (Windows STATUS_DLL_INIT_FAILED), so it fell back to the CRX reviewer subagents — which are strong on RLS/migration/convention but MISSED data-flow bugs (a cross-customer leak in a customer email). The orchestrator's independent Codex caught all of them. **Always run the orchestrator's own independent Codex even after a subagent self-reviews.**
