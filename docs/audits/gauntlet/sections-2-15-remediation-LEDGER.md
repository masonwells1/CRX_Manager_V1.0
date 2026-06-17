# Sections 2-15 Gauntlet — Remediation Ledger

Durable worklist for the 2026-06-17 sections 2-15 gauntlet findings. **State lives here, not in any chat.** Source report: `docs/audits/gauntlet/2026-06-17-sections-02-15-full-gauntlet.md`.

---

## ▶ HOW TO RESUME (read this first in a fresh session)

1. **Start the new session ROOTED IN `C:\CRX_Manager`** (not `C:\`). That loads the project's apply-guard hook + named reviewer subagents, so the migration gate is enforced for you instead of run by hand. (See `crx_session_harness_gotcha` memory for why.)
2. Read this ledger + the source report above. Do the next unfinished item, write the result back to the table, stop.
3. **Lane B — ✅ DONE (2026-06-17).** Both migrations applied live (stamps `20260617201934` / `20260617202008`) through the fresh apply gate (rls + drift reviewers clean), rolled-back live smoke PASS on every behavioral delta, both obsolete allowlist entries removed, docs/CHANGELOG updated, committed + pushed to `main`. See the worklist rows below.
4. **Next action = Lane C (owner tasks).** Hand Mason MED-2 (credential setup) and MED-3 (pull the 17 negative-inventory rows for his physical-count approval). Neither is an agent-applyable code change.

Autonomy (Mason, 2026-06-17): **auto-ship Lane A (done); ONE approval batch for the Lane B migrations.** Lane C is owner work.

Status legend: `todo` → `prepped` (drafted, awaiting gate) → `applied`/`shipped` → `done`; or `owner-blocked`.

---

## Worklist

| ID | Lane | Finding | Fix | Status | Result / pointer |
|---|---|---|---|---|---|
| MED-1 | A | Schema registry behind live DB | Regen registry from live | ✅ **shipped** | high-water 164803→182051; agent-health clean. Commit `c4cfd17`. |
| MED-5 | A | WPS PDF no regression test | `src/lib/wpsNoticePdf.test.ts` | ✅ **shipped** | 16 tests; source untouched. Commit `c4cfd17`. |
| LOW-2 | A | 31 frontend-validator warnings | Triage + tighten validator | ✅ **shipped** | all 31 false-positive, 0 real bugs; validator 29→19, proven non-weakening. Commit `c4cfd17`. |
| LOW-3 | A | Sweep README stale finding | Mark RESOLVED | ✅ **shipped** | closed live 2026-06-11 by 20260611001248. Commit `c4cfd17`. |
| MED-4 | B | `create_invoice_from_delivery` idempotency (+ bundled fin-audit actor hardening) | New migration | ✅ **shipped** | APPLIED LIVE 2026-06-17 (live stamp `20260617201934`, file `20260617190000`). Fresh rls + drift reviewers CLEAN (0 blockers). Rolled-back live smoke PASS: AUTH_REQUIRED, ACTOR_MISMATCH (forged actor), authz-reject, idempotency replay short-circuit, **happy-path double-submit → 1 invoice (INV-2026-0241) + same-key replay, zero duplicates**. Removed BOTH now-obsolete `create_invoice_from_delivery` allowlist entries (actor-forgery + actor-forgery-fin-audit); both predicates re-run live = clean. migration-history + CLAUDE.md count (481) + CHANGELOG updated. |
| LOW-1 | B | `generate_rup_sales_records` unused idempotency param | New migration | ✅ **shipped** | APPLIED LIVE 2026-06-17 (live stamp `20260617202008`, file `20260617190500`). Fresh rls + drift reviewers CLEAN (0 blockers). Rolled-back live smoke PASS: seeded-key replay returns cached count (7) verbatim. Grants restated service_role/postgres-only (NOT widened); `RETURNS integer` preserved. |
| MED-2 | C | Strict sweep / advisor path needs `psql` + `SUPABASE_DB_URL` + `SUPABASE_DB_PASSWORD` | Workstation/credential setup | ⛔ **owner-blocked** | Mason sets credentials (secrets — not an agent task). |
| MED-3 | C | 17 negative available-quantity inventory rows | Owner-approved physical-count adjustments | ⛔ **owner-blocked** | Fresh session can pull the 17-row list (product/location/qty) for Mason; corrections go through the normal inventory adjustment flow, NOT a direct DB edit. |

## Notes
- **Do not discard the two uncommitted Lane B migration drafts** — they are the prepped work. They are intentionally uncommitted (CRX applies-then-commits to avoid git-vs-live drift).
- MED-4 bundles two fixes for one function (Section-6 idempotency + fin-audit actor_role forgery).
- Reference for the canonical idempotency/strict-actor shape: `20260617171500_strict_actor_blend_ticket_order_link_rpcs.sql` and `20260616201800_void_delivery_canonical_idempotency.sql`.
- **Follow-up RESOLVED 2026-06-17:** MED-4's investigation surfaced that `create_invoice_from_delivery` set `order_id` but never `delivery_id`, so its dup-guard was inert. Follow-up probe proved the fn is **dead code** (zero callers; superseded by `create_invoice_for_unbilled_delivery`). Retired it via `DROP FUNCTION` (migration `20260617210000`, live stamp `20260617210043`, Mason approved) rather than patch dead code — supersedes the Lane B hardening `20260617190000`. Repo references cleaned (tests/types/caller-graph/docs).
