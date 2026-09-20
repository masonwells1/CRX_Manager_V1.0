# adjust_inventory receipt binding — parked fix round (2026-09-20)

**Status:** PARKED source material. Not scheduled. Needs Mason's go-ahead before any work starts.

## Read this before touching anything

`supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql` is **applied to
production** (ledger version `20260920052149`, 2026-09-20 05:21:49Z) and merged to `main` as
`17826e9c3` via PR #739. Under the CRX hard rules an applied migration is a historical record of
what ran: its bytes, **including its comments**, are never edited again.

The diff preserved below was written against that file *before* it was applied. It is kept here as
**source material only**. Do not `git apply` it, and do not copy its hunks back into the applied
file. Two independent things stop that anyway — the hard rule, and the file's own preflight, which
accepts only the pre-migration body (`ef485890…`) or its own `v_new_pin`; production now runs
`9a503e54…`, so an edited re-run aborts with `PREFLIGHT_BODY`.

**The correct delivery shape is a NEW forward migration** that pins the current live body
(`9a503e54…`, 4334 chars, md5 `22f1f7d0bd190ce74efb5ad3a8379677`) and replaces it with a new one. A
plain `CREATE OR REPLACE FUNCTION` takes no `idempotency_keys` lock, so that apply is cheap — it
does not repeat the app-wide write pause the original cutover needed.

## Why this is parked and not urgent

Everything below is refinement. The security fix it refines — `adjust_inventory` checking who you
are before it hands back an idempotency receipt — is live and verified.

The one behavioural item is the control-character key refusal. Today the live function accepts an
idempotency key containing a tab, newline or other control character, provided the key also holds
at least one printable character. Both browser callers send plain ASCII keys, so this is hygiene,
not a live defect; the reviewer (`gpt-5.6-sol`, exact-head review of `b0d6236bb`) rated it LOW.
Everything else in the round is comment precision or extra proof coverage.

## What the round covers

1. Refuse idempotency keys containing ASCII control characters
   (`p_idempotency_key COLLATE "C" ~ '[[:cntrl:]]'`), plus the two smoke cases it never had — a
   UUID with a trailing newline, and a key with no ASCII at all.
2. Postflight presence check for `AUTH_REQUIRED`. An ordering-only assertion passes a body that
   never authenticates at all, because an absent `position()` returns 0.
3. Header corrections — the cutover lock drains only calls that already reached
   `check_idempotency`; the apply window stalls all app saving, not only stock writes;
   "ASCII control characters" rather than "non-printable"; and a NaN already sitting in
   `inventory.quantity_available` still propagates.
4. Redundant predicate cleanup: `!~ '[^[:space:]]'` is subsumed by `!~ '[!-~]'`. Delete the
   FORMER. Deleting the latter would widen what the function accepts.

## A counting trap, recorded so it is not "fixed" wrongly

Five places on `main` say "the seven restamped migrations (PR #704)". PR #704 did restamp exactly
seven files (`20260914100100`, `100200`, `100300`, `100400`, `100500`, `100600`, `100900`). But the
*range* `20260914100100`..`20260914100900` spans **eight**, because PR #721 later added
`20260914100800_bind_transfer_invoice_intent`. So "the seven restamped migrations" is correct and
"the seven `…100100`..`…100900` migrations" is misleading. A blanket seven-to-eight replacement
would introduce a new error. Occurrences: `docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md`,
`docs/changelog.d/2026-09-15-create-inventory-hold-receipt-binding-applied-live.md`,
`docs/changelog.d/2026-09-17-schema-registry-refresh-after-restamp.md` (twice), and
`docs/manual/CURRENT_STATE.md`.

## Known defect inside the preserved diff — do not carry it forward

The diff's proposed header comment claims, of the app-wide stall during the apply:

> Callers do not fail; they wait, and resume the moment this commits.

**That is too absolute, and it must not be copied into the new forward migration.** An
`ACCESS EXCLUSIVE` lock makes other sessions wait, but it cannot keep a blocked call alive:
`statement_timeout`, a client or request deadline, or a dropped connection all end a waiting call
before the lock is released. The migration's `SET LOCAL lock_timeout = '10s'` does not change that
— it bounds only how long *this* migration waits to acquire the lock, and is not a caller-side
budget. The accurate statement is that blocked callers wait and resume **provided** their own
timeout and connection outlast the apply, and that some will fail if it does not.

Flagged by CodeRabbit on PR #743. It is recorded here rather than corrected in place because the
diff below is preserved byte-for-byte — editing it would invalidate the hash that makes this copy
verifiable. The claim never reached production: the applied file
(`20260911120000_…sql` on `main`) does not contain this sentence, so nothing live is wrong. The
only risk was the wording propagating into the successor migration, and this note closes that.

## Provenance

Recovered from a session scratchpad on 2026-09-20 and parked here because that directory is
temporary. The diff is reproduced byte-for-byte; its sha256 as recovered was
`4551d18f177ddf9c5842d42c933d48ac5ba99e9cf6dff2280bc4a8680d73b6d3`. Verify a copy with:
extract the fenced block, drop its first and last lines, and hash the remainder.

## The preserved diff — SOURCE MATERIAL, DO NOT APPLY

```diff
diff --git a/docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md b/docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md
index 545aac507..c7fe077da 100644
--- a/docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md
+++ b/docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md
@@ -32,7 +32,7 @@ Proof, re-observed 2026-09-13 after rebasing onto `main`, with `node scripts/smo
 - **re-run:** the migration applied a second time cleanly;
 - **trigger check:** with the trigger deliberately switched off, the test fails on the cutover case.
 
-**Apply order.** A read-only ledger read on 2026-09-11 found 1001 rows and 994 distinct names. The newest version is `20260909023300` and the effective high-water is `20260908120000_close_pr535_live_gaps`, which this file sorts above. PR #624's `20260908130000` migration sorts below this file, so it had to go live first; it was applied live on 2026-09-15 03:32Z (ledger version `20260915033227`, 1002 rows). The seven restamped `20260914100100`..`20260914100900` migrations (PR #704) sort above this file, so this one must apply before them.
+**Apply order.** A read-only ledger read on 2026-09-11 found 1001 rows and 994 distinct names. The newest version is `20260909023300` and the effective high-water is `20260908120000_close_pr535_live_gaps`, which this file sorts above. PR #624's `20260908130000` migration sorts below this file, so it had to go live first; it was applied live on 2026-09-15 03:32Z (ledger version `20260915033227`, 1002 rows). The `20260914100*` band holds EIGHT migrations, not seven: PR #704's seven restamps (`20260914100100`, `100200`, `100300`, `100400`, `100500`, `100600`, `100900`) plus PR #721's `20260914100800_bind_transfer_invoice_intent`, which is not one of those restamps. All eight sort above this file, so this one must apply before every one of them; the ordering requirement is unchanged by the corrected count.
 
 **Error tokens.** The two new refusal tokens, `INVALID_ADJUSTMENT_QUANTITY` and the cutover-only `ADJUST_INVENTORY_UNBOUND_RECEIPT`, are registered in `RpcErrorCodes` in `src/lib/db.ts`, as the canonical token rule requires. The exact-head Codex review of 2026-09-15 raised this as a LOW finding. The live-ledger capture in `migration-history.md` and the ledger sentence in `CURRENT_STATE.md` have been updated to match that read. They use the same wording as open PR #646, so the two branches merge without conflict. Both manual docs' "Last verified" stamps now read 2026-09-11.
 
diff --git a/docs/changelog.d/2026-09-20-adjust-inventory-cutover-lock-note-and-control-character-keys.md b/docs/changelog.d/2026-09-20-adjust-inventory-cutover-lock-note-and-control-character-keys.md
index 0db078d8b..86b0da2be 100644
--- a/docs/changelog.d/2026-09-20-adjust-inventory-cutover-lock-note-and-control-character-keys.md
+++ b/docs/changelog.d/2026-09-20-adjust-inventory-cutover-lock-note-and-control-character-keys.md
@@ -40,6 +40,66 @@ also rejects any key containing a control character. Both browser callers send
 ASCII keys, so no caller changes behaviour; this closes a log and error-message
 hygiene gap rather than a live defect.
 
+The comment above that check now states the refused set exactly instead of
+saying "non-printable", which overclaimed. Under `COLLATE "C"` the refused set
+is the C0 control characters plus DEL; C1 controls, ZWSP, BOM, U+2028 and the
+soft hyphen are not ASCII controls and still pass so long as the key also
+carries a printable ASCII character.
+
+One of the four tests in that check — `!~ '[^[:space:]]'` — is now subsumed by
+the `COLLATE "C" !~ '[!-~]'` test beside it, because a key with no
+non-whitespace character has no `[!-~]` character either. Rather than delete it
+mid-review, a comment marks which of the two is safe to remove: the subsumed
+one. Deleting the other would reopen the hole, since `[!-~]` is what refuses a
+key made only of non-ASCII text.
+
+## The control-character refusal now has a test
+
+The previous head shipped that behaviour change with no test anywhere — neither
+the container prover nor the rolled-back smoke chain exercised it, and the smoke
+chain only covered the NULL and blank cases. Section 5 of
+`scripts/smoke/smoke-adjust-inventory-intent-binding.sql` now adds two cases:
+
+- a real-shaped key with a trailing newline (`gen_random_uuid()::text ||
+  chr(10)`) — the exact shape the previous check let through, since it carries
+  plenty of printable characters;
+- a non-ASCII-only key (`repeat(chr(233), 8)`) — not whitespace and not a
+  control character, so the `[!-~]` test is the only thing that refuses it,
+  which is what makes that line load-bearing.
+
+Each must raise `IDEMPOTENCY_KEY_REQUIRED`, and the section then asserts that
+neither refusal left a receipt, wrote a ledger row, or moved stock.
+
+## The postflight could have passed a body with no auth check
+
+The postflight asserted that `AUTH_REQUIRED` appears before the receipt lookup
+by comparing `position()` values. `position()` returns 0 for a token that is
+absent, and 0 is never greater than a positive position, so a body that never
+authenticated at all would have satisfied that test. A presence check
+(`position('AUTH_REQUIRED' IN v_src) = 0`) is added alongside it. This is
+postflight only and does not change the emitted body or its hash.
+
+## The apply window is app-wide, not inventory-only
+
+The header said to apply "when no one is adjusting stock". That understated it.
+The migration takes `LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE
+MODE` and holds it for the whole transaction; ACCESS EXCLUSIVE conflicts with
+every other lock mode, and every mutating RPC in this app is keyed and touches
+that table through `check_idempotency` or `check_idempotency_intent`. While the
+migration runs, **all saving in the app stalls** — invoices, quotes, jobs,
+deliveries, transfers, commissions — not just stock adjustments. Callers wait
+rather than fail, and resume the moment it commits. The header now says so,
+because Mason picks the apply time from that paragraph.
+
+## Residual (c): a NaN already in stock
+
+The body refuses a NaN or infinite `p_delta`, but it does not repair a NaN
+already stored in `inventory.quantity_available`. That column still has no CHECK
+constraint, so a value the live body wrote before this applies keeps propagating
+through every later adjustment of that row. The structural fix is the parked
+`scripts/.staging-migrations/20260813030000_reject_non_finite_money_and_quantities.sql`.
+The header records this as residual (c) with a read-only post-apply check.
+
 ## Body pin
 
 `v_new_pin` (two occurrences) is updated to the SHA-256 of the body this file
@@ -71,7 +131,16 @@ Note for anyone reading that proof script's exit status: it prints
 `ADJUST_INVENTORY_INTENT_REAL_SCHEMA_FAIL` and still exits 0, so the token is
 the signal, not the exit code. That fail-open is tracked separately.
 
+## Corrected count: eight `20260914100*` migrations, not seven
+
+Earlier notes said "seven". The band holds EIGHT files: PR #704's seven restamps
+(`20260914100100`, `100200`, `100300`, `100400`, `100500`, `100600`, `100900`)
+plus PR #721's `20260914100800_bind_transfer_invoice_intent`, which is not one of
+those restamps. All eight sort above `20260911120000`, so the ordering
+requirement itself is unchanged — only the count was wrong. Corrected here and
+in `docs/changelog.d/2026-09-11-adjust-inventory-receipt-intent-binding.md`.
+
 Still required before any live apply: a fresh exact-SHA `gpt-5.6-sol` review of
 the final head, and Mason's explicit approval in chat. The apply must precede
-the seven `20260914100*` migrations and go through
+all eight `20260914100*` migrations and go through
 `scripts/apply-migration-file.mjs` (dry run, then `--confirm`).
diff --git a/scripts/smoke/smoke-adjust-inventory-intent-binding.sql b/scripts/smoke/smoke-adjust-inventory-intent-binding.sql
index e8efcbfc8..b8e7ceb4d 100644
--- a/scripts/smoke/smoke-adjust-inventory-intent-binding.sql
+++ b/scripts/smoke/smoke-adjust-inventory-intent-binding.sql
@@ -23,8 +23,11 @@
 --   * the same key with a changed delta, reason or inventory row is refused
 --     with IDEMPOTENCY_INTENT_MISMATCH (DETAIL carries the committed result
 --     for the ORIGINAL actor only) and moves nothing;
---   * a NULL or blank key is refused with IDEMPOTENCY_KEY_REQUIRED before any
---     work (the live body adjusted stock unreceipted);
+--   * a NULL, blank, control-character-bearing or non-ASCII-only key is refused
+--     with IDEMPOTENCY_KEY_REQUIRED before any work, leaving no receipt, no
+--     ledger row and no stock movement (the live body adjusted stock
+--     unreceipted). The control-character case is the one the first version of
+--     this check let through: a UUID with a trailing newline;
 --   * a NULL, zero, NaN or infinite delta is refused and moves nothing (the
 --     live body wrote NaN into quantity_available);
 --   * a pre-migration receipt (both binding columns NULL) fails closed;
@@ -63,6 +66,8 @@ DECLARE
   v_role      text;
   v_caller    uuid;
   v_bad       numeric;
+  v_ctrl_key  text;
+  v_utf8_key  text;
 BEGIN
   ----------------------------------------------------------------------------
   -- Fixtures (rolled back with everything else)
@@ -240,7 +245,7 @@ BEGIN
   END IF;
 
   ----------------------------------------------------------------------------
-  -- 5. NULL / blank key refused before any work
+  -- 5. NULL / blank / control-character / non-ASCII key refused before any work
   ----------------------------------------------------------------------------
   BEGIN
     PERFORM public.adjust_inventory(v_inv, 1, 'keyless', v_admin, NULL);
@@ -254,6 +259,38 @@ BEGIN
   EXCEPTION WHEN OTHERS THEN
     IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
   END;
+  -- A real-shaped key with a trailing newline. This is the case the PREVIOUS
+  -- check let through: it carries plenty of [!-~] characters, so the
+  -- "at least one printable character" test passed it. chr(10) is a C0 control,
+  -- so the [[:cntrl:]] test is the only thing that refuses it.
+  v_ctrl_key := gen_random_uuid()::text || chr(10);
+  BEGIN
+    PERFORM public.adjust_inventory(v_inv, 1, 'control char key', v_admin, v_ctrl_key);
+    RAISE EXCEPTION 'SMOKE_FAIL: a key carrying a control character was accepted';
+  EXCEPTION WHEN OTHERS THEN
+    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
+  END;
+  -- Non-ASCII only (U+00E9 repeated): not whitespace, so the [^[:space:]] test
+  -- passes it, and not a control character either. The COLLATE "C" [!-~] test
+  -- is the only thing that refuses it, which is why that line is load-bearing.
+  v_utf8_key := repeat(chr(233), 8);
+  BEGIN
+    PERFORM public.adjust_inventory(v_inv, 1, 'non-ascii key', v_admin, v_utf8_key);
+    RAISE EXCEPTION 'SMOKE_FAIL: a non-ASCII-only key was accepted';
+  EXCEPTION WHEN OTHERS THEN
+    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE; END IF;
+  END;
+  -- Refused before ANY work: no receipt, no ledger row, no stock movement.
+  SELECT count(*) INTO v_count FROM public.idempotency_keys
+   WHERE idempotency_key IN (v_ctrl_key, v_utf8_key, E'  \t ');
+  IF v_count <> 0 THEN
+    RAISE EXCEPTION 'SMOKE_FAIL: a refused key left % receipt(s)', v_count;
+  END IF;
+  SELECT count(*) INTO v_count FROM public.inventory_transactions WHERE product_id = v_product;
+  SELECT quantity_available INTO v_qty FROM public.inventory WHERE id = v_inv;
+  IF v_qty <> 105 OR v_count <> 1 THEN
+    RAISE EXCEPTION 'SMOKE_FAIL: a refused key moved stock or wrote a ledger row (qty %, ledger rows %)', v_qty, v_count;
+  END IF;
 
   ----------------------------------------------------------------------------
   -- 6. NULL, zero, NaN and infinite deltas refused, nothing moves
diff --git a/supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql b/supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql
index e50d27e75..06134aee2 100644
--- a/supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql
+++ b/supabase/migrations/20260911120000_bind_adjust_inventory_receipt_to_intent.sql
@@ -73,7 +73,11 @@
 --
 -- CUTOVER: a keyed call of the OLD body touches idempotency_keys first
 -- (check_idempotency deletes/reads it), so the ACCESS EXCLUSIVE lock below
--- drains every keyed call already under way. A keyed old-body call that
+-- drains every keyed call that has already reached check_idempotency. It does
+-- NOT drain a keyed old-body call that has not reached it yet: such a call
+-- holds no lock on idempotency_keys, so the lock cannot see it and cannot wait
+-- for it. That is exactly the call residual (b) below describes, and there the
+-- trigger, not the lock, is what stops it. A keyed old-body call that
 -- starts while the lock is held blocks inside check_idempotency and RESUMES
 -- after this commits, still running the old body; it would then adjust stock
 -- and write an UNBOUND receipt through save_idempotency. The BEFORE INSERT
@@ -99,7 +103,15 @@
 -- stock change or ledger row survives. What remains is disclosure: an
 -- old-body call already inside the old body when this commits can still
 -- return a stored receipt to a caller it never bound, which needs two
--- callers holding one random key during the apply window.
+-- callers holding one random key during the apply window. (c) this body
+-- refuses a NaN or infinite p_delta, but it does not repair a NaN already
+-- stored in inventory.quantity_available. That column still has no CHECK
+-- constraint, so a value the live body wrote before this applies keeps
+-- propagating through every later adjustment of that row (NaN + anything is
+-- NaN). Closing that is structural and belongs to the parked
+-- scripts/.staging-migrations/20260813030000_reject_non_finite_money_and_quantities.sql,
+-- not here. Post-apply, read-only: select inventory rows where
+-- quantity_available = 'NaN'::numeric; there should be none.
 -- Post-apply detection for (a), read-only: compare the number of 'adjusted'
 -- inventory_transactions rows written during the apply window with the number
 -- of bound adjust_inventory receipts written in the same window. Any extra
@@ -117,7 +129,19 @@
 -- 2026-09-11). The drain can trip this refusal by itself: a keyed old-body
 -- call the lock waits for commits an unbound receipt first, and the preflight
 -- then refuses. Nothing changes in that case, but the apply must wait for that
--- receipt to expire, so apply when no one is adjusting stock.
+-- receipt to expire.
+-- APPLY WINDOW — wider than "no one is adjusting stock", and this is the line
+-- to read before picking a time. The LOCK TABLE below takes ACCESS EXCLUSIVE on
+-- public.idempotency_keys and holds it for the WHOLE transaction, and ACCESS
+-- EXCLUSIVE conflicts with every other lock mode, including plain reads. Every
+-- mutating RPC in this app is keyed and touches that table through
+-- check_idempotency or check_idempotency_intent, so while this migration runs
+-- ALL saving in the app stalls — invoices, quotes, jobs, deliveries, transfers,
+-- commissions — not just stock adjustments. Callers do not fail; they wait, and
+-- resume the moment this commits. SET LOCAL lock_timeout = '10s' below bounds
+-- only the wait to ACQUIRE the lock (the migration aborts rather than queueing
+-- forever); it does not bound how long other sessions wait once the lock is
+-- held. Apply in a quiet window and expect a brief app-wide pause.
 -- Atomicity: no BEGIN/COMMIT of its own. Apply ONLY through
 -- scripts/apply-migration-file.mjs (or psql -1), which wraps the whole file in
 -- one transaction.
@@ -170,7 +194,7 @@ DECLARE
   -- both CRLF-normalized. The constants live here, not in the body, so
   -- declaring them does not change the value they pin.
   v_live_pin text := 'ef485890f3b9ef82359a95dda95d12a57ad633b86f841ead80e872d1eb71b4df';
-  v_new_pin  text := '457cfb002d948b83ac3abdb49e489e89c8fe28485ba6e90cdceef83317771bf8';
+  v_new_pin  text := '64640423d3e885467489397281fa2260d784d26510ee476620b5c693fdab6db7';
 BEGIN
   IF to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)') IS NULL THEN
     RAISE EXCEPTION
@@ -345,8 +369,16 @@ BEGIN
   END IF;
 
   -- Every adjustment gets a receipt a retry can find. Blank, whitespace-only
-  -- or non-printable keys are refused before any work.
+  -- and ASCII-control-character keys are refused before any work. Scope stated
+  -- exactly, because "non-printable" would overclaim: under COLLATE "C" the
+  -- refused set is the C0 controls plus DEL. C1 controls, ZWSP, BOM, U+2028 and
+  -- the soft hyphen are not ASCII controls and still pass, so long as the key
+  -- also carries at least one [!-~] character.
   IF p_idempotency_key IS NULL
+     -- Subsumed by the [!-~] test below, which is the load-bearing one: a key
+     -- with no non-whitespace character has no [!-~] character either. If this
+     -- pair is ever tidied, delete THIS line; deleting the next one reopens the
+     -- hole, because it is what refuses a key made only of non-ASCII text.
      OR p_idempotency_key !~ '[^[:space:]]'
      OR p_idempotency_key COLLATE "C" !~ '[!-~]'
      OR p_idempotency_key COLLATE "C" ~ '[[:cntrl:]]' THEN
@@ -450,7 +482,7 @@ DECLARE
   v_trg_sig    text := 'public._refuse_unbound_adjust_inventory_receipt_20260911()';
   v_helper_sig text := 'public.check_idempotency_intent(text,text,uuid,text)';
   v_args_pin   text := 'p_inventory_id uuid, p_delta numeric, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text';
-  v_new_pin    text := '457cfb002d948b83ac3abdb49e489e89c8fe28485ba6e90cdceef83317771bf8';
+  v_new_pin    text := '64640423d3e885467489397281fa2260d784d26510ee476620b5c693fdab6db7';
   v_count integer;
   v_src   text;
   v_sha   text;
@@ -494,6 +526,10 @@ BEGIN
   IF position('public.check_idempotency_intent(' IN v_src) = 0
      OR position('INSUFFICIENT_ROLE' IN v_src) = 0
      OR position('INSUFFICIENT_ROLE' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
+     -- Presence first: position() returns 0 when the token is absent, and 0 is
+     -- never > a positive position, so an ordering test ALONE would pass a body
+     -- that never authenticates at all.
+     OR position('AUTH_REQUIRED' IN v_src) = 0
      OR position('AUTH_REQUIRED' IN v_src) > position('public.check_idempotency_intent(' IN v_src)
      OR position('check_idempotency(' IN v_src) > 0
      OR position('save_idempotency(' IN v_src) > 0
```
