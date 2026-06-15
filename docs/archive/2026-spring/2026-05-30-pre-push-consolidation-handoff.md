# Pre-Push Consolidation Handoff — 2026-05-30

**Prepared for:** Codex cross-review **before** pushing to `origin/main` and before any live deploy.
**Prepared by:** Claude (Opus 4.8), autonomous session 2026-05-30.
**Branch under review:** `consolidation/2026-05-30-pre-push` (HEAD `e084a48` — this doc was drafted at `c815d79`, then committed as `e084a48` which added the doc itself; the two LOW doc-drift fixes from Codex's review land in a later commit).
**Status:** Committed locally. **NOT pushed. NOT deployed.** Awaiting Codex sign-off.

---

## 1. What this session did

Mason had work spread across multiple sessions / branches / worktrees and was worried he'd "crossed lines." The task: a full pre-push audit + consolidation — map every unpushed commit, reconcile the two diverged 2026-05-30 audit branches into one clean branch, verify every recent migration's disk filename matches its live applied version (recover the known live-only one), build + test, fix errors, commit locally — **without pushing** (Codex reviews first, then we go live).

Every claim in the original ask was verified against git + the live DB before acting (per standing rule that handoff recollections are often stale). Results below.

---

## 2. Branch topology

### Before
```
origin/main          0d82deb  (pushed baseline)
main (local)         cf791f0  +1 ahead of origin/main  ("add migration-review + foundation-review workflows")
  └─ 449b20e  P2-D delivery_items_parent_lock_trigger   ← shared fork point of BOTH audit branches
       ├─ chore/add-review-workflows  e0dae29  (+4 commits, NOT pushed)   ← main working tree
       └─ fix/review-2026-05-30-p2p3  4b9bb9a  (+6 commits, pushed to origin)  ← worktree
claude/peaceful-wu-63602c  65bcc99  (stale worktree, 22 behind origin/main; only .agents/.codex scratch)
```

### After
```
origin/main                         0d82deb  (unchanged — nothing pushed)
main (local)                         cf791f0  (unchanged)
consolidation/2026-05-30-pre-push    c815d79  ← THE consolidated branch (was chore/add-review-workflows, renamed)
  ├─ 29db449  merge: consolidate fix/review-2026-05-30-p2p3 into the audit branch
  └─ c815d79  chore(db): recover live-only entity_type_fix migration + reconcile doc counts
fix/review-2026-05-30-p2p3           4b9bb9a  (branch ref kept; its commits are now merged in)
claude/peaceful-wu-63602c            65bcc99  (branch ref kept; worktree removed — 65bcc99 is an ancestor of origin/main, holds no unique work)
```

**Backup tags (rollback insurance):** `backup/chore-pre-merge` → e0dae29, `backup/p2p3-pre-merge` → 4b9bb9a, `backup/main-pre-merge` → cf791f0.

---

## 3. The merge & conflict resolutions

`git merge --no-ff fix/review-2026-05-30-p2p3` produced 3 conflicts. All resolved:

### 3a. `src/lib/statementPdf.ts` — SEMANTIC (please review closely)
Both branches independently fixed the **same** remittance-stub overflow bug, differently:
- **chore (M2):** caller-side guard — `if (y > pageH - 170) doc.addPage()` before `drawRemittanceStub(...)`.
- **p2p3 (P2-B/C):** in-callee — added a `currentY` param, page-break inside `drawRemittanceStub`, plus `try/catch` hardening on both `drawPageFooter` and `drawRemittanceStub`.

Naively keeping both → **double page-break (blank page)**. **Resolution chosen:** keep p2p3's self-contained in-callee approach (more defensive — includes the try/catch hardening), **drop** chore's redundant caller-side `addPage`, but adopt chore's **more conservative threshold**: changed p2p3's `currentY > stubY - 8` to `currentY > stubY - 15` (= `pageH - 170`, matching chore's intent). The caller now calls `drawRemittanceStub(doc, data, margin, pageW, pageH, asOfDate, y)` with NO preceding `addPage`. **→ Codex: please confirm there is exactly one page-break path and the stub never double-breaks.**

### 3b. `CLAUDE.md` — counts reconciled
chore said `95 tables / 218 RPCs / 365 migrations`; p2p3 said `97 tables / ~204 RPCs / 367 migrations (provisional, reconcile at merge)`. Verified against live: **95 base tables + 2 views, 262 functions in `public` (0 overloads)**. Reconciled to `95 tables (+2 views), 218 RPCs, 369 migrations`. (Kept the established curated "218 RPCs" label — the raw live function count of 262 includes trigger/helper functions and is a different denominator; the exact RPC curation methodology is not the subject of this consolidation. Flagging for awareness.) Both branches' state bullets retained. Added a consolidation bullet.

### 3c. `docs/reference/migration-history.md` — rows merged
Title → 369. Kept all 5 recent rows (the gate_admin row from chore + the 4 p2p3 rows), ordered newest-first. The `20260530192441` row was updated from "_(live-only correction; no disk file)_" to reference the recovered disk file.

`src/lib/invoicePdf.ts` auto-merged cleanly (chore's `paid: CRX_GREEN` and p2p3's footer `try/catch` are in different regions — both survive).

---

## 4. Recovered live-only migration (the "entity_type_fix")

**Verified:** `20260530192441_batch_rpc_idempotency_entity_type_fix` was applied **live** but had **no disk file** on any branch — a phantom live-only version (the B7-class drift this repo guards against).

**Recovered** verbatim from `supabase_migrations.schema_migrations` into `supabase/migrations/20260530192441_batch_rpc_idempotency_entity_type_fix.sql`.

**Why a separate file (not folding into 191823):** the live history is `191823` (applied with `entity_type 'system'`, which violates `financial_audit_log_entity_type_check`) → hotfixed by `192441` (→ `'batch'`). The committed `191823` disk file already encodes the final `'batch'` state. Supabase tooling aligns on version **prefixes**, not bodies, so adding the `192441` file makes the disk version-list match live exactly with minimal churn (no edit to the already-pushed `191823` file). The duplicate `CREATE OR REPLACE` is idempotent on a fresh replay. Full reasoning is in the file's header comment. **→ Codex: confirm this is the right representation vs. reconstructing `191823`'s original `'system'` body.**

**No DB apply happened** — the function is already live with this exact body. The recovery is git-only.

---

## 5. Migration disk-vs-live verification

- **Recent window (everything ≥ `20260526`):** disk filename prefixes and live versions are **identical, 1:1, zero drift** — `20260526151856` … `20260530194520` (16 versions each).
- **All 6 migrations new since `origin/main`** (`121534, 121737, 183926, 191823, 192441, 194520`) are applied live with matching version stamps. **No unapplied local migrations.**
- The original "batch_rpc disk …140000 vs live …191823" recollection was **stale** — the disk file is `20260530191823_batch_rpc_idempotency.sql`, already matching live. No `…140000` file exists.

**Pre-existing (out of scope, not a blocker):** live `schema_migrations` has **452 rows vs 369 disk files** (83-version gap), entirely below the recent window — historical drift from early-dev MCP auto-stamping + later disk consolidation/renames (documented in `migration-history.md`). Not introduced here. Pushing only moves git/disk; live is unaffected and already correct; Mason applies via MCP `apply_migration`, not `supabase db push`, so the gap does not auto-trigger re-application. Disk also has intentional duplicate-timestamp pairs (long-standing, noted in migration-history.md).

---

## 6. The OCR fix (clarification)

Mason mentioned "a local supabase migration for OCR fix." **There is no such migration.** The OCR work is the **`process-blend-ticket` Edge Function** change in commit `e0dae29` (M3 "atomic queue claim") — already committed on this branch. It replaces an unconditional queue-row UPDATE with an atomic claim (`.or(status.eq.pending, and(status.eq.processing, started_at.lt.<stale>))` against the **existing** `ocr_processing_queue` table). **No new DB object is required** — it uses existing columns.

⚠️ **The Edge Function is committed but NOT deployed** (the commit itself says `NOT DEPLOYED` — it's untested against the live OCR flow). **After Codex sign-off**, deploy via `/deploy-edge-function process-blend-ticket` with a real OCR smoke test.

---

## 7. Build / test

Pre-commit gate ran on BOTH commits (no `--no-verify`): **ESLint clean, production build clean, 1924 unit tests passed (70 skipped), workflow-map 0 auto-detected problems.** TypeScript compiles.

---

## 8. Worktree cleanup

- `peaceful-wu-63602c` worktree **removed** (stale; only `.agents/`/`.codex/` scratch; `65bcc99` is an ancestor of origin/main → no unique work). Branch ref kept.
- `review-p2p3` worktree **unregistered** from git, but its now-empty directory `(.claude/worktrees/review-p2p3)` is held by another process (Windows file lock — likely a parallel session's terminal). Harmless leftover; delete it manually once that process closes. Branch ref kept.

---

## 9. What Codex should focus on
1. **statementPdf.ts merge resolution** (§3a) — single page-break path, stub layout intact.
2. **The 192441 recovery representation** (§4) — separate file vs reconstruct-191823.
3. The 4 recent already-live migrations for any latent RLS/actor/drift issue (a parallel verification workflow ran these — verdict appended in §11).

## 10. What remains for Mason AFTER Codex sign-off
1. Push `consolidation/2026-05-30-pre-push` (or merge it into `main` and push `main` — local `main` is +1 ahead and `449b20e` is not yet on `main`; the cleanest path is to fast-forward/merge this branch into `main` then push `main`).
2. Deploy the `process-blend-ticket` Edge Function (§6) with an OCR smoke test.
3. Optional: delete the locked `review-p2p3` orphan dir; prune the `claude/peaceful-wu-63602c` + `fix/review-2026-05-30-p2p3` branch refs if no longer wanted.

---

## 11. Independent verification verdict

A read-only `pre-push-consolidation-verify` workflow ran 4 specialized reviewers in parallel (6 agents total), with adversarial verification of every HIGH finding against the **live** DB.

| Dimension | Verdict |
|-----------|---------|
| PDF output (merge-resolution) | ✅ **CLEAN** — confirmed NO double page-break (merge kept only the in-callee guard; caller-side `addPage` absent on disk); brand color `#28A26A` correct everywhere; all money ÷100; all autoTable callbacks try/catch-wrapped; emailed statement leaks no internal cost/commission data |
| Migration drift / disk-vs-live | ✅ **CLEAN** — `192441` executable SQL is **byte-identical** to `191823` (only a leading comment differs); `entity_type 'batch'` is CHECK-valid; all 8 `financial_audit_log` columns + the customers/invoices SELECT columns exist; exactly one overload; `search_path = public, pg_temp` present |
| TypeScript types drift | ✅ **CLEAN** — `Order.created_by` removal is correct (orders has no such column); no merge artifacts; balanced braces; `tsc --noEmit` exit 0; all May-30 migrations are function/trigger-only (zero table DDL) so no column drift |
| RLS / SECURITY DEFINER | ⚠️ **2 confirmed HIGH** (pre-existing, already-live, NOT consolidation defects) — below |

**The consolidation is clean — no defect was introduced by the merge or the recovery.** The two HIGH findings live in **already-deployed** code (`20260530191823_batch_rpc_idempotency`, applied live *before* this session) that the p2p3 sprint **explicitly deferred** (CLAUDE.md: "both batch RPCs still use the permissive `COALESCE(p_performed_by, auth.uid())` actor … candidate for a strict-actor pass").

### HIGH-1 — Forgeable actor on `batch_apply_all_prepayments` (CONFIRMED vs live)
`v_actor := COALESCE(p_performed_by, auth.uid())` with no `ACTOR_MISMATCH` check. `require_admin_or_sales_rep()` gates the caller's ROLE but does not stop an authenticated admin/sales_rep from passing a *different* user's UUID as `p_performed_by`. The forged actor flows into `apply_remaining_prepayments(v_cust.id, v_actor)`, whose inner audit INSERT writes `actor_user_id = p_performed_by` (overriding the `auth.uid()` default) into the immutable `financial_audit_log`, plus the batch-summary row's `entity_id`/`actor_role`. **Impact: audit-trail mis-attribution** (NOT money manipulation — applied amounts depend on the customer's real prepay balance, independent of the actor). Exploit requires a valid authenticated admin/sales_rep JWT (anon EXECUTE is false); reachable directly via PostgREST (PrepaymentManager.tsx).

### HIGH-2 — Forgeable actor on `batch_void_invoices` (CONFIRMED vs live)
Same `COALESCE` pattern; **narrower** blast radius — the forged actor only lands in the batch-summary audit row's `actor_role` string. It does NOT flow into `void_invoice` (which derives its own actor from `auth.uid()` and hard-gates on admin). Audit-attribution-only, admin-only reach.

### Remediation (NOT applied — for Codex review, then post-sign-off apply)
Add the project's canonical strict-actor block immediately after `require_admin_or_sales_rep()` in BOTH functions, matching `20260530020412_reverse_write_off_strict_actor`:
```sql
IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM auth.uid() THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
```
Ship as a NEW follow-up `CREATE OR REPLACE` migration (do **NOT** edit the historical `191823` file); apply via MCP after Codex sign-off. The verifier also flagged the same pattern in `allocate_payment` (`20260222200000`) as an out-of-scope follow-up-sweep candidate.

> **Why this is not in the branch:** it's a live-DB change, which per Mason's instruction happens only after Codex. Keeping it out preserves the clean "disk == live" state this consolidation achieved. The block above is ready to paste into a follow-up migration.

### INFO (pre-existing, for awareness — not consolidation issues)
- `require_admin()` / `require_admin_or_sales_rep()` have **no on-disk definition** (live-only; used since Feb). A from-scratch migration rebuild would fail on the first `PERFORM require_admin()`. Consider recovering both into a disk migration (same "recovered from live" treatment as `192441`).
- Defense-in-depth: consider an explicit `REVOKE EXECUTE … FROM anon, PUBLIC` on the 4 batch/returns RPCs (currently safe — each rejects NULL `auth.uid()` before mutating).
- Cosmetic: `20260530121737`'s header comment (line 5) self-references stamp `20260529220000` vs its filename `20260530121737` — provenance-comment only, zero functional impact.
