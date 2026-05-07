# Phase 4 Closure — 4-Wave Autonomous Run Prompts

**Created:** 2026-05-07 (after Wave B.3 ship)
**Purpose:** Reference file holding the four autonomous-session prompts that close out the remaining Phase 4 audit findings (`docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md`) plus the unaddressed Q-items from Mason's audit Q&A.

## How to use

1. Open a fresh Claude Code session (do not continue an existing conversation).
2. Copy the **Wave 1 prompt** in its entirety (between the `# WAVE 1 PROMPT` and `# END WAVE 1 PROMPT` markers) and paste it as the first message.
3. The session runs autonomously, commits locally, and writes `SESSION_FINAL_WAVE_1.md` when done.
4. Pull the local commits, review the diff, and push to origin if the work looks good.
5. Open a NEW fresh session, paste the **Wave 2 prompt**, and repeat.
6. Continue through Waves 3 and 4. Wave 4 ends with a master final report and a self-review pass.

## Wave summary

| Wave | Items | Estimated time | Risk |
|---|---|---|---|
| 1 | Quick wins: delete FieldDetail.tsx, Customer 360 hero number, /payments doc, OCR threshold | 1–1.5 hours | very low |
| 2 | Small UI + verifications: P4-13 tooltip, P4-8 adjust preview, P4-12 + P4-14 verify | 2–3 hours | low |
| 3 | E2E test + warn-only migration: P4-9 holds-cleanup spec, P4-10 backdated-delivery WARN | 2–2.5 hours | medium |
| 4 | Heavy migrations + self-review: P4-3 create_inventory_hold RPC, P4-7 manufactured_at_delivery flag, sprayer-packet TODO, self-review pass | 3–4 hours | high |

## Decisions locked in (do not re-ask)

| Q | Decision |
|---|---|
| Scope | Close everything in Phase 4 except P4-6 and P4-11 which Mason explicitly deferred |
| P4-10 backdated-delivery gate | **B** — WARN only, do not block, no admin override |
| P4-3 hold admin override | **A** — admin override mirrors over-receive (`p_force` + reason; non-admin always blocked) |
| P4-7 manufactured rows | **A** — `manufactured_at_delivery` boolean column on `inventory` + new section on /integrity-cleanup |
| Live Supabase | Do NOT apply migrations to live; commit SQL with sanity-test queries in commit message |
| Push to origin | Do NOT push; commit locally only; Mason batch-reviews and pushes himself |
| UI verification | Skip browser verification (login wall); flag UI-affecting commits in body for spot-check |
| Stop condition | All scoped items committed OR blocker hit, whichever first |
| Vitest deadlock prevention | Kill `node.exe` defensively before every commit |
| Sprayer packet (audit Q1) | Defer; create TODO doc instead |
| Self-review at end | Yes; auto-fix findings as follow-up commits |

---

# WAVE 1 PROMPT

You are working on CRX Manager V1.0 (`C:\CRX_Manager_V1.0`) in **Wave 1 of a 4-wave autonomous run**. Mason will not be available mid-session. Decisions are answered below; if you hit anything not covered, stop and write `SESSION_REPORT.md` for him to handle later.

## WAVE STRUCTURE

| Wave | Items | This is | Status |
|---|---|---|---|
| **1** | Delete FieldDetail, Customer 360 hero, /payments doc, OCR threshold | **You are here** | Starting now |
| 2 | P4-13 tooltip, P4-8 adjust preview, P4-12 + P4-14 verifications | Next | After Mason reviews Wave 1 |
| 3 | P4-9 E2E test, P4-10 backdated-delivery WARN | After 2 | — |
| 4 | P4-3 hold RPC, P4-7 manufactured flag, self-review | After 3 | — |

When Wave 1 completes, you will write `SESSION_FINAL_WAVE_1.md` and tell Mason to paste the Wave 2 prompt into a fresh session.

## WHAT'S ALREADY DONE (2026-05-07)

Latest commit on origin/main: `e6dd416`. Recent context:
- `46604b0` — Wave B.3.a: `get_inventory_position` RPC + `InventoryPositionRow` type
- `88d6d22` — Wave B.3.b+c+e: InventoryPage refactor + INVENTORY_RULES.md + CHANGELOG
- `cdcce80` — Self-review fixes (rename, validator + 12 tests, Forecast HelpTips)
- `e6dd416` — Branch cleanup + 16-doc archive

State: 278 migrations, ~173 RPCs, 1,876 tests passing, 0 lint/typecheck errors. The Phase 4 audit at `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md` had 14 findings; P4-1, P4-2, P4-4, P4-5 are closed.

## WAVE 1 SCOPE — 4 items, each its own commit

Set up TodoWrite with these 4 items at session start. Mark in_progress before each, completed after the commit lands.

**1. Delete `src/pages/FieldDetail.tsx`** (Mason's audit Q10).
- Verify the file exists.
- Grep for any references in `src/App.tsx` routes, lazy imports, and other components.
- If unreferenced, delete the file.
- If referenced, stop and write SESSION_REPORT.md naming the references — do not rip out an in-use page without his sign-off.
- Commit message format: `chore: delete unused FieldDetail.tsx (audit Q10)`

**2. Customer 360 hero number = total balance due** (Mason's audit Q5, answer A).
- Find the customer detail page (likely `src/pages/CustomerDetail.tsx`, `Customer360.tsx`, or similar — grep for "Customer 360" or look at `App.tsx` routes for `/customers/:id`).
- Identify the hero/header number at the top of the page.
- Confirm it shows total balance due — `SUM(invoices.balance_cents)` for the customer (display ÷ 100 for dollars).
- If it's a different metric (last payment, MTD revenue, average invoice, etc.), change to total balance due.
- If it's already correct, commit a doc-only update to `docs/CHANGELOG.md` saying "verified Customer 360 hero number = total balance due, no change needed."
- Mark **UI-AFFECTING:** in commit message body if the page changed.

**3. `/payments` page access doc in CLAUDE.md** (Mason's audit Q6).
- Sales reps + admins can both access `/payments`. Update CLAUDE.md's role/access section to reflect this.
- If the section doesn't exist, add a small one near "Hard Red Lines" or wherever access policy is documented.
- Doc-only commit. Title: `docs(claude.md): clarify /payments is sales+admin (audit Q6)`

**4. OCR threshold locked at 70%** (Mason's audit Q8).
- Search for the OCR confidence threshold: `grep -rn "0.7\|threshold\|confidence" src/lib/documentOCR.ts supabase/functions/process-blend-ticket/`.
- Confirm it's a constant set to 0.70.
- If user-configurable (e.g., reads from a settings table or env var), refactor to a hardcoded constant.
- If different value (0.5, 0.8, etc.), change to 0.70.
- If already correct, commit a doc-only "verified" update.
- No settings UI per Mason's answer.

## OPERATING RULES (same across all waves)

### Commit cadence
- **Each item = one commit.** Stage with explicit file paths (`git add path1 path2`); never use `git add -A` or `.`.
- **Before EVERY `git commit`**, run `taskkill //F //IM node.exe 2>&1 | tail -1`. Kills orphan vitest workers from prior runs that deadlock pre-commit hook. Cheap (~1 sec); Mason lost ~25 min on 2026-05-07 to this.
- **Use `timeout: 540000` (9 min)** on Bash for `git commit`. Pre-commit hook (lint + build + 1876+ tests) takes 4-5 min.
- **DO NOT push to origin.** Mason batch-reviews before push.
- **DO NOT apply migrations to live Supabase.** Mason applies them after review. Wave 1 has no migrations, so this isn't relevant here — but it's a hard rule.

### Verify mode for verification-style items
If an item is "verify, fix only if needed" (Wave 1 items 2 + 4 may turn into this), commit a documentation-only update to `docs/CHANGELOG.md` confirming the verification. Don't skip the commit — Mason needs to know you checked.

### UI-affecting changes
If a commit touches `src/pages/*.tsx` or `src/components/*.tsx`, after the commit lands run a dev-server-boot smoke test:
1. `mcp__Claude_Preview__preview_start` with `name: "dev"` (config in `.claude/launch.json`)
2. `mcp__Claude_Preview__preview_eval` with `document.title + ' | rootChildren=' + (document.getElementById('root')?.children.length ?? 0)` — confirm title set + root has children
3. `mcp__Claude_Preview__preview_console_logs` with `level: "error"` — confirm zero errors
4. `mcp__Claude_Preview__preview_stop`

Login wall blocks deeper testing. Mason will spot-check in browser before push. Add `**UI-AFFECTING:**` line in commit message body for any UI commit.

### Hard rules from CLAUDE.md (always apply)
- ConfirmModal/ReasonModal — never `confirm()`, `window.confirm()`, `prompt()`, `window.prompt()`.
- Sentry — `import { Sentry } from '../lib/sentry'`, never `@sentry/react` directly.
- Money is `bigint` cents.
- (Wave 1 has no migrations — full migration rules not relevant here.)

## WHEN TO STOP

Stop when ANY of:
- All 4 scoped items committed (success path) → write `SESSION_FINAL_WAVE_1.md` and prompt Mason for Wave 2
- A blocker hit, write `SESSION_REPORT.md` with the question and stop
- Pre-commit hook fails 3 times in a row on the same commit (something genuinely broken; do not retry blindly)

## FINAL REPORT — SESSION_FINAL_WAVE_1.md

Write this file in the repo root containing:
- Local commit log: `git log e6dd416..HEAD --oneline`
- One-line summary of what each item became (e.g., "Item 2: changed hero number from MTD to balance due" OR "Item 2: verified, no change needed")
- Any UI-affecting commits flagged with file paths Mason should spot-check
- Total approximate runtime
- Anything anomalous

End the file with this exact text:

> **Wave 1 complete. To start Wave 2, open a fresh Claude Code session and paste the Wave 2 prompt from `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`.**

Then output a final user-visible message saying the same thing — Mason needs the prompt path in his terminal, not just in the file.

## START

Read in order:
1. `CLAUDE.md`
2. `docs/CHANGELOG.md` (most recent entry — to know what shipped today)

Then start with item 1 (delete FieldDetail.tsx).

# END WAVE 1 PROMPT

---

# WAVE 2 PROMPT

You are working on CRX Manager V1.0 (`C:\CRX_Manager_V1.0`) in **Wave 2 of a 4-wave autonomous run**. Mason will not be available mid-session.

## WAVE STRUCTURE

| Wave | Items | This is | Status |
|---|---|---|---|
| 1 | Quick wins (FieldDetail, Customer 360, /payments, OCR) | Done | Mason reviewed |
| **2** | **P4-13 tooltip, P4-8 adjust preview, P4-12 + P4-14 verifications** | **You are here** | Starting now |
| 3 | P4-9 E2E test, P4-10 backdated-delivery WARN | Next | After Mason reviews Wave 2 |
| 4 | P4-3 hold RPC, P4-7 manufactured flag, self-review | After 3 | — |

When Wave 2 completes, write `SESSION_FINAL_WAVE_2.md` and tell Mason to paste the Wave 3 prompt.

## WHAT'S ALREADY DONE

Read `SESSION_FINAL_WAVE_1.md` in the repo root for the most recent context. Earlier 2026-05-07 commits on origin/main: `46604b0`, `88d6d22`, `cdcce80`, `e6dd416`. Wave 1 added 4 commits locally (or pushed, depending on Mason's review pass — check `git log` to see what's on `HEAD` vs `origin/main`).

State after Wave 1: continue from wherever HEAD is.

The Phase 4 audit at `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md` is the source for items below. Closed: P4-1, P4-2, P4-4, P4-5. Wave 2 closes 4 more.

## WAVE 2 SCOPE — 4 items

Set up TodoWrite with these 4 items.

**1. P4-13 — Receiving log reverse-button tooltip.**
- File: `src/pages/PurchaseOrderDetail.tsx`. Find the receiving-records table (read past line 270 — Mason didn't read that far in the audit so confirm the structure first).
- The reverse-receiving-record button should already be admin-only via a role check. For non-admin users, currently the button is just absent.
- Replace the absent button with a disabled tooltip-bearing element: "Ask an admin to reverse this receive." Use the project's existing tooltip pattern (search for `<Tooltip>` or `title=` to find it).
- Mark **UI-AFFECTING:** in commit message.

**2. P4-8 — Adjust modal live preview + zero-cross warning.**
- Files: `src/pages/InventoryPage.tsx` adjust modal (~lines 1497-1517) AND `src/components/inventory/BatchAdjustModal.tsx`.
- Add a live "**After this adjustment: X units**" line below the quantity input. X = current quantity_available + adjustment (positive or negative).
- When X < 0, add a yellow warning band: "**Warning:** this adjustment will drive inventory below zero (X). Verify with a physical count before proceeding."
- Pattern: mirror the manual-hold warning at `InventoryPage.tsx:319` (today's-free formula).
- For BatchAdjustModal, apply the same pattern per row.
- Mark **UI-AFFECTING:**.

**3. P4-12 — Verify `cancel_cycle_count` idempotency.**
- Read the latest `cancel_cycle_count` RPC body: `SELECT prosrc FROM pg_proc WHERE proname = 'cancel_cycle_count' AND pronamespace = 'public'::regnamespace` is what would tell you live, but you can't query live. Instead, find the most recent migration that defines/redefines `cancel_cycle_count` by `grep -rn "cancel_cycle_count" supabase/migrations/`. Read the body of the last definition.
- Check: does it accept `p_idempotency_key`? Does it call `check_idempotency` at the top + `save_idempotency` (or insert into `idempotency_keys` with the correct columns) before returning?
- **If both yes**: doc-only commit to `docs/CHANGELOG.md` saying "verified `cancel_cycle_count` already idempotent, no fix needed."
- **If broken**: write a NEW migration with a static `CREATE OR REPLACE` (no dynamic-clone via `pg_get_functiondef`) that adds the proper idempotency block. Update `src/pages/CycleCounts.tsx:326-329` to pass `p_idempotency_key`. Reference: the existing return-lifecycle RPCs Mason shipped in Wave B.2 (commit history near `9ad6085`) for the canonical idempotency pattern.

**4. P4-14 — Verify QuickReceive multi-cost UX.**
- Read `match_quick_receive_items` body (search migrations for the most recent definition; original at `supabase/migrations/20260304200000_quick_receive.sql`). Look for `v_multiple_costs` flag handling.
- Read `src/pages/QuickReceive.tsx` end-to-end (Mason only sampled :270-310 in the audit).
- Question: when a product has multiple open POs at *different* unit costs and the user adds it to a Quick Receive batch, does the UI prompt the user to pick which PO, or does it silently allocate against the oldest?
- **If correct (prompts user)**: doc-only "verified" commit.
- **If broken (silently picks)**: add a "Multiple costs detected for [product]; choose which PO this receipt belongs to" modal step before allocation. The migration may also need an update if the SQL is the silent-allocator. Mark **UI-AFFECTING:**.

## OPERATING RULES — same as Wave 1

- One commit per item; explicit file staging.
- Kill orphan node processes before every commit (`taskkill //F //IM node.exe`).
- 9-min timeout on `git commit`.
- DO NOT push. DO NOT apply migrations to live.
- UI-affecting commits get the dev-server-boot smoke test (preview_start → eval → console_logs → stop) AND a `**UI-AFFECTING:**` line in the commit message.

## HARD RULES (from CLAUDE.md)

If you write a new migration in this wave (only happens if P4-12 or P4-14 is broken):
- Mutating RPCs: `p_idempotency_key text DEFAULT NULL` + `check_idempotency`/`save_idempotency` block.
- SECURITY DEFINER + `SET search_path = public, pg_temp`.
- `idempotency_keys` columns: `idempotency_key`, `operation`, `result` (jsonb), `expires_at`. NEVER `key`/`result_id`/`entity_type`/`entity_id`.
- Tables WITHOUT `updated_at`: payments, write_offs, delivery_items, finance_charges, prepay_applications, cycle_counts, cycle_count_items, financial_audit_log, idempotency_keys, receiving_records, commission_payment_items, return_items.
- Each migration: include "Sanity test queries to run after applying:" section in the commit message body.

## WHEN TO STOP

- All 4 scoped items committed → write `SESSION_FINAL_WAVE_2.md` and prompt Mason for Wave 3
- Blocker → write `SESSION_REPORT.md` and stop
- Pre-commit fails 3x in a row → stop

## FINAL REPORT — SESSION_FINAL_WAVE_2.md

Same template as Wave 1. End with:

> **Wave 2 complete. To start Wave 3, open a fresh Claude Code session and paste the Wave 3 prompt from `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`.**

Output the same in your final user-visible message.

## START

Read `CLAUDE.md`, `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md` (P4-8, P4-12, P4-13, P4-14 sections), `SESSION_FINAL_WAVE_1.md`. Then start with item 1.

# END WAVE 2 PROMPT

---

# WAVE 3 PROMPT

You are working on CRX Manager V1.0 (`C:\CRX_Manager_V1.0`) in **Wave 3 of a 4-wave autonomous run**. Mason will not be available mid-session.

## WAVE STRUCTURE

| Wave | Items | This is | Status |
|---|---|---|---|
| 1 | Quick wins | Done | Reviewed |
| 2 | Small UI + verifications | Done | Reviewed |
| **3** | **P4-9 E2E test, P4-10 backdated-delivery WARN** | **You are here** | Starting now |
| 4 | P4-3 hold RPC, P4-7 manufactured flag, self-review | Next | After Mason reviews Wave 3 |

When Wave 3 completes, write `SESSION_FINAL_WAVE_3.md` and tell Mason to paste the Wave 4 prompt.

## WHAT'S ALREADY DONE

Read `SESSION_FINAL_WAVE_1.md` and `SESSION_FINAL_WAVE_2.md` in the repo root. Combined Waves 1+2 closed 8 items: 4 audit Q-items (FieldDetail, Customer 360, /payments doc, OCR threshold) + 4 Phase 4 items (P4-13, P4-8, P4-12, P4-14).

The Phase 4 audit is at `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md`. Closed so far: P4-1, P4-2, P4-4, P4-5, P4-8, P4-12, P4-13, P4-14. Wave 3 closes 2 more.

## WAVE 3 SCOPE — 2 items

Set up TodoWrite with these 2 items.

**1. P4-9 — E2E test for holds-cleanup paths.**
- New file: `tests/e2e/holds-cleanup-paths.spec.ts`.
- Per project E2E protocol (read `CLAUDE.md` "E2E Test Data Protocol" section):
  - All entities use `[E2E]` prefix
  - Reuse fixtures from `tests/e2e/fixtures/e2e-constants.ts`
  - Concurrency-sensitive tests use `${E2E_PREFIX} Desc-${runId()}`
  - `globalTeardown` deletes ALL `[E2E]` data, so don't worry about cleanup
- Two test cases (per audit P4-9):
  - **Path A:** create planned quote → accept (converts to order, holds released, prebooked applied) → cancel order (prebooked released back to available)
  - **Path B:** create planned quote → decline quote without converting (holds released, no prebook ever applied)
- Assert: `inventory.quantity_available` ends at the same number in both paths (i.e., starting value, since neither path actually moved physical stock).
- Use existing test patterns from `tests/e2e/mega-workflow.spec.ts` for quote/order creation. Do NOT introduce new browser flows that aren't already covered.
- Run the test locally with `npx playwright test tests/e2e/holds-cleanup-paths.spec.ts` if Playwright is installed; if it isn't or it fails for environment reasons (no real Supabase data, etc.), write the test, validate the syntax via lint, commit, and note in the commit message that real-database execution requires a deployed `[E2E]` fixture set.

**2. P4-10 — WARN-only on backdated delivery completion** (Mason's decision: **WARN, do not block; no admin override**).
- Migration: NEW file `supabase/migrations/<today>_<time>_warn_backdated_delivery_completion.sql`.
- Update `complete_delivery` AND `void_delivery` to add a non-blocking period check:
  - After existing validation, before mutation: `SELECT * INTO v_period_status FROM check_period_open(v_delivery.delivery_date)` (if `check_period_open` doesn't return a status type, adapt — read its current signature first).
  - If period is closed: `INSERT INTO activity_feed` with `event = 'backdated_delivery_in_closed_period'`, `severity = 'warning'`, description naming the delivery + period close date.
  - Also create an admin notification (use the existing `notify_admins(...)` helper — search for it in migrations to find current API).
  - Then **proceed with the operation as normal** — do NOT raise, do NOT add an admin-override parameter.
- For the migration to be safe in light of CLAUDE.md's SQL hooks, follow the standard pattern: include the explicit `CREATE OR REPLACE FUNCTION` body (no dynamic-clone), `SECURITY DEFINER`, `SET search_path = public, pg_temp`, idempotency block.
- Update `docs/reference/migration-history.md` (new entry at top of recent block, bump count), `docs/reference/rpc-functions.md` (note the new behavior on `complete_delivery` / `void_delivery`), `CLAUDE.md` Current State counts.
- Sanity test queries (include in commit message body) to run after Mason applies:
  - "Show the current accounting period status to confirm `check_period_open` is callable from the function context"
  - "Pick a recently-completed delivery and verify activity_feed has no spurious warning entry for it"

## OPERATING RULES — same as Wave 1+2

Same operating rules apply. Particularly:
- DO NOT push.
- DO NOT apply the P4-10 migration to live — Mason applies it himself.
- Kill orphan node processes before every commit.
- 9-min commit timeout.
- For the migration commit, include "Sanity test queries to run after applying:" in the commit message body.

## HARD RULES (from CLAUDE.md)

For the P4-10 migration:
- `complete_delivery` and `void_delivery` already accept `p_idempotency_key` — preserve their signatures.
- Both functions already have `SECURITY DEFINER` + `search_path` — preserve those.
- `complete_delivery` body lives in the latest of: `20260319200000_complete_delivery_remove_inventory_block.sql` (most recent definitive). Read that body before rewriting.
- `void_delivery` body: most recent at `20260332300000_fix_void_delivery_three_bugs.sql`. Read before rewriting.
- Do NOT rewrite logic that isn't related to the period check — copy existing bodies verbatim and add the warn-only block in the right place.
- Do NOT regress: `void_delivery` had 3 rounds of bug fixes, very fragile. Read the audit's "What's Already Working" section before touching it.
- The SQL safety hook does substring matching across ~400 chars — if you reorder statements and put `UPDATE <no-updated_at-table>` near `UPDATE <other> SET updated_at`, the hook will false-positive. Move no-updated_at UPDATEs to end of function if so.

## WHEN TO STOP

- Both items committed → write `SESSION_FINAL_WAVE_3.md` and prompt Mason for Wave 4
- Blocker → write `SESSION_REPORT.md` and stop
- Pre-commit fails 3x in a row → stop

## FINAL REPORT — SESSION_FINAL_WAVE_3.md

Same template + section "Migrations awaiting Mason's apply" listing the P4-10 migration's path and the sanity-test SQL. End with:

> **Wave 3 complete. To start Wave 4, open a fresh Claude Code session and paste the Wave 4 prompt from `docs/plans/2026-05-07-phase-4-closure-autonomous-waves.md`.**

## START

Read `CLAUDE.md`, `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md` (P4-9, P4-10 sections + What's Already Working), `tests/e2e/mega-workflow.spec.ts` (~first 200 lines for E2E patterns), `tests/e2e/fixtures/e2e-constants.ts`, `SESSION_FINAL_WAVE_1.md` and `_WAVE_2.md`. Then start with item 1.

# END WAVE 3 PROMPT

---

# WAVE 4 PROMPT

You are working on CRX Manager V1.0 (`C:\CRX_Manager_V1.0`) in **Wave 4 of a 4-wave autonomous run** — the final wave. Mason will not be available mid-session. This wave includes the heaviest work plus the self-review pass.

## WAVE STRUCTURE

| Wave | Items | This is | Status |
|---|---|---|---|
| 1 | Quick wins | Done | Reviewed |
| 2 | Small UI + verifications | Done | Reviewed |
| 3 | E2E test + warn migration | Done | Reviewed |
| **4** | **P4-3 hold RPC, P4-7 manufactured flag, sprayer-packet TODO, self-review** | **You are here** | Final wave |

When Wave 4 completes, write `SESSION_FINAL_WAVE_4.md` (which is the master final report) and tell Mason the project sweep is done.

## WHAT'S ALREADY DONE

Read `SESSION_FINAL_WAVE_1.md`, `_WAVE_2.md`, `_WAVE_3.md`. Combined Waves 1+2+3 closed 10 items: 4 audit Q-items + 6 Phase 4 items (P4-8, P4-9, P4-10, P4-12, P4-13, P4-14). Wave 4 closes the heavy ones.

Phase 4 audit at `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md`. Closed before this wave: P4-1, P4-2, P4-4, P4-5, P4-8, P4-9, P4-10, P4-12, P4-13, P4-14. Wave 4 will close P4-3 + P4-7. The remaining open finding after Wave 4 = P4-6 (negative-inventory CHECK) which Mason has explicitly deferred until /integrity-cleanup drains, and P4-11 which Mason explicitly deferred. So after Wave 4 + the deferred items, Phase 4 is fully addressed.

## WAVE 4 SCOPE — 4 items

Set up TodoWrite with these 4 items.

### Item 1 — P4-3 `create_inventory_hold` RPC

Per Mason's decision: admin override mirrors over-receive pattern.

**Migration** — NEW file `supabase/migrations/<today>_<time>_create_inventory_hold_rpc.sql`:

```sql
CREATE OR REPLACE FUNCTION public.create_inventory_hold(
  p_product_id uuid,
  p_customer_id uuid,
  p_quantity numeric,
  p_hold_type text,
  p_expires_at date,
  p_notes text,
  p_performed_by uuid,
  p_force boolean DEFAULT false,
  p_force_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_role text;
  v_hold_id uuid;
  v_existing jsonb;
  v_inventory record;
  v_active_holds numeric;
  v_todays_free numeric;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- Strict actor pattern (Phase 13)
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Role check (admin or sales_rep can create non-force holds; only admin can force)
  SELECT role INTO v_role FROM profiles WHERE id = v_actor;
  IF v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Validate hold_type
  IF p_hold_type NOT IN ('manual', 'crop_program') THEN
    RAISE EXCEPTION 'INVALID_HOLD_TYPE: %', p_hold_type;
  END IF;

  -- Lock the inventory row + recompute today's free
  SELECT id, quantity_available, quantity_prebooked
    INTO v_inventory
    FROM inventory
    WHERE product_id = p_product_id
    FOR UPDATE;

  IF NOT FOUND THEN
    -- No inventory row → today's free = 0; hold creation fails unless force+admin
    v_todays_free := 0;
  ELSE
    SELECT COALESCE(SUM(quantity), 0) INTO v_active_holds
      FROM inventory_holds
      WHERE product_id = p_product_id
        AND is_active = true
        AND (expires_at IS NULL OR expires_at >= CURRENT_DATE);
    v_todays_free := v_inventory.quantity_available - v_inventory.quantity_prebooked - v_active_holds;
  END IF;

  -- Block-or-force decision
  IF v_todays_free - p_quantity < 0 THEN
    IF p_force THEN
      IF v_role != 'admin' THEN
        RAISE EXCEPTION 'FORCE_REQUIRES_ADMIN';
      END IF;
      IF p_force_reason IS NULL OR length(trim(p_force_reason)) = 0 THEN
        RAISE EXCEPTION 'FORCE_REQUIRES_REASON';
      END IF;
    ELSE
      RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY: only % units uncommitted (Available % - Prebooked % - Active Holds %); requested %',
        v_todays_free, COALESCE(v_inventory.quantity_available, 0), COALESCE(v_inventory.quantity_prebooked, 0),
        v_active_holds, p_quantity;
    END IF;
  END IF;

  -- Create the hold
  INSERT INTO inventory_holds (
    product_id, customer_id, quantity, hold_type, expires_at, notes,
    is_active, created_by, created_at
  ) VALUES (
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, true, v_actor, NOW()
  ) RETURNING id INTO v_hold_id;

  -- Activity feed (use existing log_activity pattern; check signature)
  INSERT INTO activity_feed (
    event, description, performed_by, entity_type, entity_id, severity
  ) VALUES (
    'inventory_hold_created',
    CASE WHEN p_force THEN 'Hold created with admin override (' || p_force_reason || ')'
         ELSE 'Hold created' END,
    v_actor, 'inventory_hold', v_hold_id,
    CASE WHEN p_force THEN 'warning' ELSE 'info' END
  );

  -- Save idempotency
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'create_inventory_hold',
            jsonb_build_object('hold_id', v_hold_id, 'todays_free_before', v_todays_free, 'forced', p_force),
            NOW() + INTERVAL '24 hours');
  END IF;

  RETURN jsonb_build_object('hold_id', v_hold_id, 'todays_free_before', v_todays_free, 'forced', p_force);
END;
$$;

GRANT EXECUTE ON FUNCTION create_inventory_hold(uuid, uuid, numeric, text, date, text, uuid, boolean, text, text) TO authenticated;
```

**Frontend update** — `src/pages/InventoryPage.tsx` hold-creation handler (~lines 333-343):
- Replace the bare `.from('inventory_holds').insert(...)` with `.rpc('create_inventory_hold', { p_product_id: ..., p_customer_id: ..., p_quantity: qty, p_hold_type: 'manual', p_expires_at: holdExpires || null, p_notes: holdNotes || null, p_performed_by: profile.id, p_force: holdWarning ? true : false, p_force_reason: holdWarning ? <reason from a new ReasonModal> : null, p_idempotency_key: <use useIdempotencyKey hook> })`.
- The browser-side warning at line 319 stays for UX preview, but the actual block is now server-side. If the RPC raises `INSUFFICIENT_HOLD_INVENTORY`, parse the error and show a ReasonModal (admin-only) to capture the force reason, then retry with `p_force: true`. Non-admin users see the error as a toast.
- Wire `useIdempotencyKey('create_inventory_hold', profile?.id || '')` near other idempotency hooks at the top of the component.
- Add `**UI-AFFECTING:**` to commit message.

**Reference doc updates**: migration-history, rpc-functions, CLAUDE.md counts.

**Sanity test queries** (in commit message):
- `SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname = 'create_inventory_hold';` — confirm SECURITY DEFINER + search_path
- `SELECT create_inventory_hold('00000000-0000-0000-0000-000000000000'::uuid, NULL, 1, 'manual', NULL, 'test', auth.uid(), false, NULL, NULL);` — should error INSUFFICIENT_HOLD_INVENTORY (no inventory row for that product)

### Item 2 — P4-7 `manufactured_at_delivery` flag

Per Mason's decision: persistent flag + Integrity Cleanup section.

**Migration** — NEW file `supabase/migrations/<today>_<time>_manufactured_at_delivery_flag.sql`:

1. `ALTER TABLE inventory ADD COLUMN manufactured_at_delivery boolean NOT NULL DEFAULT false;`
2. Update `complete_delivery` to set the flag in the IF FOUND ... ELSE INSERT branch (lines :128-136 of `20260319200000_complete_delivery_remove_inventory_block.sql`). Read that body first; preserve all other behavior. The branch that creates a new row should set `manufactured_at_delivery = true`.
3. New RPC `mark_inventory_row_verified(p_inventory_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)`:
   - Admin-only (strict actor pattern)
   - Sets `manufactured_at_delivery = false` on the inventory row
   - Logs to activity_feed
   - Idempotent

**Frontend updates**:
- `src/types/index.ts`: add `manufactured_at_delivery: boolean` to `Inventory` interface and `InventoryPositionRow` if appropriate (the RPC `get_inventory_position` doesn't currently return this column — leave it out of `InventoryPositionRow`).
- `src/pages/IntegrityCleanup.tsx`: add new section "Phantom Inventory Rows" listing rows where `manufactured_at_delivery = true`. Pattern: mirror existing sections (negative inventory, over-received POs, unbilled deliveries). Each row has a "Mark Verified" button that calls `mark_inventory_row_verified` with confirmation modal.
- Add `**UI-AFFECTING:**` to commit message.

**INVENTORY_RULES.md**: add a section documenting the flag's purpose and the "phantom row" concept.

**Reference doc updates**: migration-history, rpc-functions, CLAUDE.md counts (+1 migration, +1 RPC).

**Sanity test queries**:
- `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'inventory' AND column_name = 'manufactured_at_delivery';` — confirm column shape
- `SELECT COUNT(*) FROM inventory WHERE manufactured_at_delivery = true;` — should be 0 immediately after migration (the default is false; no retroactive flagging)

### Item 3 — Sprayer packet TODO file

Mason's audit Q1 specified the requirements. Create `docs/plans/sprayer-packet-feature-todo.md`:

```markdown
# Sprayer Packet Feature — TODO (deferred)

**Status:** Awaiting design pass before build. Do NOT start without explicit Mason approval.

## Scope (per Mason's audit Q1, 2026-05-06)

A printable packet for sprayer applicators with:
- Customer + address
- Fields with map preview AND acres
- Chemicals + rates + mixed rate per acre
- Applicator signature line
- Wind / temperature / date lines

**Excluded:** EPA registration numbers, service fee.

**Letterhead:** West York, IL (per Mason's audit Q2).

## Estimated effort

Significant — likely:
- New page/component (likely under `/jobs/:id/sprayer-packet` or similar)
- New PDF generation flow (extend `src/lib/reportPdf.ts` patterns)
- Possibly a new RPC `get_sprayer_packet_data(p_job_id)` to aggregate customer + fields + chemicals + rates
- Map preview integration (Mapbox already in the bundle)
- Applicator signature input (could leverage existing signature capture if present)

## Why deferred

Wave 4 closes the Phase 4 audit. Sprayer packet is a NEW feature, not a fix. It needs a design pass on:
- Single-customer vs multi-customer packet
- One packet per job vs one packet per delivery
- Whether to include re-printing (signed copy archival)
- Print format (PDF only? printable HTML too?)
- Whether the "mixed rate per acre" calc needs new data not currently captured on quotes/orders

Open these questions with Mason before starting build.
```

Doc-only commit. Title: `docs(plans): add sprayer-packet feature TODO (audit Q1, deferred for design pass)`

### Item 4 — Self-review pass + auto-fix

After items 1-3 commit, do a thorough self-review like the Wave B.3 self-review pattern (see `cdcce80` commit message for the format that worked).

Steps:
1. Run `git log <wave-1-base>..HEAD --oneline` to list every commit landed across Waves 1-4.
2. Re-read each commit's diff (`git show <SHA>`).
3. Identify findings in this priority:
   - **Bugs** — incorrect logic, missing null guards, wrong column references, race conditions
   - **Project-rule violations** — missing search_path, idempotency-column drift, missing RLS on new tables, etc.
   - **Test gaps** — RPCs without contract tests, UI changes without component tests where relevant
   - **Code smells** — dual-meaning field names, inconsistent patterns, missing comments where the WHY is non-obvious
   - **UX gaps** — missing tooltips, missing confirmations, accessibility issues
4. For each finding, fix as a follow-up commit. Use commit titles like `refactor(<area>): address self-review finding <N> — <brief>` or `fix(<area>): ...`.
5. End with a final commit `docs: self-review summary table for Waves 1-4` containing:
   - A markdown table in `SESSION_FINAL_WAVE_4.md` listing every finding with severity / file / fix-commit-SHA
   - Total count of fixes vs total findings (some findings may be flagged but deferred — note why if so)

## OPERATING RULES — same as Waves 1-3

Same rules. Particularly important for Wave 4:
- DO NOT push to origin.
- DO NOT apply migrations to live — Mason applies them after reviewing the SQL.
- Each migration commit needs "Sanity test queries to run after applying:" in the body.
- For the heavy migrations (item 1 + 2), the sanity tests are NON-OPTIONAL — Mason needs them to verify each migration safely landed.

## HARD RULES (from CLAUDE.md, condensed for this wave)

- Mutating RPC: `p_idempotency_key` + idempotency block. The skeleton in item 1 shows the canonical pattern.
- SECURITY DEFINER + `SET search_path = public, pg_temp`.
- `idempotency_keys` columns: `idempotency_key`, `operation`, `result` (jsonb), `expires_at`. NEVER `key`/`result_id`/`entity_type`/`entity_id`.
- Tables WITHOUT `updated_at`: payments, write_offs, delivery_items, finance_charges, prepay_applications, cycle_counts, cycle_count_items, financial_audit_log, idempotency_keys, receiving_records, commission_payment_items, return_items.
- Money is `bigint` cents.
- `complete_delivery` is fragile — read its current body in `20260319200000_...` before writing the P4-7 update. Do NOT rewrite logic outside the IF-FOUND-ELSE-INSERT branch.

## WHEN TO STOP

- Items 1-3 + self-review committed → write `SESSION_FINAL_WAVE_4.md` (this is also the master final report) → tell Mason the sweep is done
- Blocker → write `SESSION_REPORT.md` and stop
- Pre-commit fails 3x in a row → stop

## FINAL REPORT — SESSION_FINAL_WAVE_4.md

This is the **master final report** for the entire 4-wave sweep. Include:

1. **Cumulative commit log** — `git log <wave-1-base>..HEAD --oneline` showing every commit landed across all 4 waves
2. **Phase 4 status** — list every audit finding with status (closed / deferred / out-of-scope) and the commit that closed it (if applicable)
3. **Migrations awaiting Mason's apply** — file paths + sanity-test SQL for ALL migrations from Waves 1-4 (probably 3-5 migrations total)
4. **Self-review findings table** — severity / location / fix-commit-SHA
5. **Items skipped/deferred** with reason
6. **Total approximate runtime** for the full 4-wave sweep
7. **Anomalies** — anything Mason should know about (test flakes, unusual decisions made, etc.)

End the file with:

> **All 4 waves complete. The Phase 4 audit is closed (modulo P4-6 and P4-11 which Mason explicitly deferred). Local commits are ready for Mason's review and push.**

Output a final user-visible message saying the same.

## START

Read `CLAUDE.md`, `docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md` (P4-3, P4-7 sections + What's Already Working + Open Questions), `docs/workflows/INVENTORY_RULES.md`, all three `SESSION_FINAL_WAVE_<N>.md` files, the latest `complete_delivery` migration body before touching it, and the existing Phase 4 closure commits (`46604b0`, `88d6d22`, `cdcce80`) for canonical patterns. Then start with item 1.

# END WAVE 4 PROMPT
