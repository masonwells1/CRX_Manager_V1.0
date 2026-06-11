#!/usr/bin/env node
/**
 * Mechanized builder for scripts/.staging-migrations/idempotency_operation_scope_sweep.sql
 * (DRAFT role, 2026-06-11 — second attempt; supersedes the phantom-stamped
 * 20260611080937 draft that was never applied live).
 *
 * WHY A BUILDER: 20 function bodies (~100 KB) must be VERBATIM from live with
 * exactly ONE appended clause each. Manual transcription is the failure mode
 * the house md5 rules exist to prevent — so the bodies never pass through a
 * human/LLM hand: this script fetches pg_get_functiondef() straight from the
 * live catalog (Supabase Management API, read-only SELECT), asserts each
 * body's md5(prosrc) equals the session-verified baseline, injects the single
 * ` AND operation = '<fn>'` clause, strip-verifies (md5(body minus clause) ==
 * baseline), and emits the migration file. Three independent fidelity gates:
 *   1. this builder's in-memory asserts (fetch-time),
 *   2. scripts/.staging-migrations/verify-idemscope-md5.mjs (offline, re-runnable),
 *   3. the migration's own terminal DO block (in-database, apply-time).
 *
 * Read-only against live: the ONLY statement sent is a SELECT over pg_proc.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PROJECT = "rhyzpcqhnizqbxphqdkr";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("FATAL: SUPABASE_ACCESS_TOKEN not set");
  process.exit(2);
}

// Baseline md5(prosrc) per function — read from LIVE pg_proc this session
// (2026-06-11, after live version 20260611190251; matches the 08:27 manifest
// read, i.e. the bodies have been stable all day).
const BASELINES = {
  batch_approve_blend_tickets: "ecef62c9154d1246e0df5715d1d7ae82",
  batch_post_invoices: "8414b078aa51d5774960c22387d9c3cc",
  batch_reject_blend_tickets: "5619eafd51a48b0d44e17fb2b77cc9ff",
  complete_job: "8620e40a6f5f8ae2634815f818005c4e",
  create_invoice_from_blend_ticket: "036091796baa73eb0754e5c2dd4de95b",
  create_job_from_quote_section: "79f38c109f6549c5808ba7fec5f373cb",
  create_quote_from_template: "d8d57dca6f3f5f091e7a2a754bef2a5f",
  create_quote_version: "06ac27b08a9714130d02a1a326bcd188",
  create_split_invoices_from_order: "d515f71b72dfbcf290ec258776b46502",
  delete_prepay_credit: "77b21cf7ef8fbbbb711eedd057178706",
  edit_delivery: "06cce0a277cf84cd8605712d6be03d0c",
  edit_prepay_credit: "5f3a14d6abd35301db438d3dd72075a4",
  post_invoice_group: "767b0fbb8954f1009112c0b6880b34f3",
  reverse_receiving_record: "08d1026caed844d7ba41bf43e825d378",
  rollover_quote_to_season: "dda42120a85a4fb4c3d0c5751fd97c65",
  save_blend_ticket_fields: "4b642537dfdf73b3c25d4ce9d024c5bb",
  save_field_app_invoice: "76b1e62b6bec2ee5aecb9ca482d00abb",
  save_quote_template: "afc3a240238f9049c3d94239b81522cc",
  start_job: "72a2fb6ff788378b216e9dd84f4a423c",
  void_payment: "8e18a5090bc1093b1836651beba3a780",
};

// Carved out of THIS sweep (still on the test's gap list, cap 2): rebuilt —
// WITH operation-scoped lookups — by the pending disk migration
// 20260611132115_planned_holds_drawn_sync.sql; sweeping them here would let
// whichever change applied second silently revert the other.
const CARVED_OUT = {
  create_planned_holds: "912db30f89fce14b0d114f6c1ea20c01",
  save_quote: "980a624c4e29ce01de0c977a007c0a15",
};

const FNS = Object.keys(BASELINES).sort();
const PATTERN = "idempotency_key = p_idempotency_key";

async function fetchDefs() {
  const q = `SELECT proname, md5(prosrc) AS src_md5, pg_get_functiondef(p.oid) AS def,
       pg_get_function_identity_arguments(p.oid) AS args,
       (SELECT count(*) FROM pg_proc q2 WHERE q2.proname = p.proname AND q2.pronamespace = p.pronamespace) AS overloads
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
  AND p.proname IN (${FNS.map((n) => `'${n}'`).join(",")})
ORDER BY p.proname`;
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q }),
    }
  );
  if (!res.ok) {
    console.error(`FATAL: API ${res.status}: ${await res.text()}`);
    process.exit(2);
  }
  const j = await res.json();
  const rows = Array.isArray(j) ? j : j.result ?? j.rows;
  if (!Array.isArray(rows)) {
    console.error("FATAL: unexpected API response shape", JSON.stringify(j).slice(0, 400));
    process.exit(2);
  }
  return rows;
}

function md5(s) {
  return createHash("md5").update(s, "utf8").digest("hex");
}

const rows = await fetchDefs();
if (rows.length !== FNS.length) {
  console.error(`FATAL: expected ${FNS.length} rows, got ${rows.length}`);
  process.exit(2);
}

const blocks = [];
let i = 0;
for (const row of rows) {
  i++;
  const fn = row.proname;
  const def = row.def;
  if (!(fn in BASELINES)) throw new Error(`unexpected fn ${fn}`);
  if (Number(row.overloads) !== 1) throw new Error(`${fn}: overloads=${row.overloads} (expected 1) — ABORT`);
  if (row.src_md5 !== BASELINES[fn])
    throw new Error(`${fn}: LIVE md5 ${row.src_md5} != session baseline ${BASELINES[fn]} — LIVE DRIFTED MID-SESSION, ABORT`);
  if (def.includes("\r")) throw new Error(`${fn}: body contains CR — line-ending hazard, ABORT`);
  if (!def.startsWith(`CREATE OR REPLACE FUNCTION public.${fn}(`))
    throw new Error(`${fn}: unexpected def prefix`);
  if (!def.includes("SECURITY DEFINER")) throw new Error(`${fn}: not SECURITY DEFINER?`);
  if (!def.includes("search_path")) throw new Error(`${fn}: missing search_path SET`);

  // exactly one occurrence of the lookup pattern, and it must sit in an
  // idempotency_keys WHERE context (not some unrelated expression)
  const idx = def.indexOf(PATTERN);
  if (idx < 0) throw new Error(`${fn}: lookup pattern not found`);
  if (def.indexOf(PATTERN, idx + 1) >= 0)
    throw new Error(`${fn}: lookup pattern occurs more than once — manual review required, ABORT`);
  const ctx = def.slice(Math.max(0, idx - 160), idx);
  if (!/idempotency_keys/i.test(ctx) || !/WHERE\s*$/i.test(ctx.trimEnd() + " ") && !/WHERE[\s\S]*$/i.test(ctx))
    throw new Error(`${fn}: pattern context is not an idempotency_keys WHERE clause:\n...${ctx}`);

  const clause = ` AND operation = '${fn}'`;
  if (def.includes(clause)) throw new Error(`${fn}: clause already present — already scoped?, ABORT`);
  const newDef = def.replace(PATTERN, PATTERN + clause);

  // strip-verify on the BODY (what becomes prosrc): extract between the
  // outermost AS $function$ ... $function$ delimiters
  const m = newDef.match(/AS \$function\$([\s\S]*)\$function\$\s*$/);
  if (!m) throw new Error(`${fn}: cannot locate $function$ body`);
  const strippedBody = m[1].replace(clause, "");
  if (md5(strippedBody) !== BASELINES[fn])
    throw new Error(`${fn}: strip-verify FAILED (md5(body minus clause)=${md5(strippedBody)})`);

  const nn = String(i).padStart(2, "0");
  blocks.push(
    `-- ============================================================================
-- [IDEMSCOPE ${nn}/20] public.${fn}(${row.args})
--   baseline md5(prosrc): ${BASELINES[fn]}   (live-verified this session)
--   sole delta: the idempotency LOOKUP gains \` AND operation = '${fn}'\`
-- [IDEMSCOPE-DELTA ${fn} BEGIN] body below is live-verbatim except that
--   single appended clause; strip it and md5 returns to the baseline above.
-- ============================================================================
${newDef};
-- [IDEMSCOPE-DELTA ${fn} END]
`
  );
  console.log(`OK ${fn} (md5 verified, clause injected, strip-verified)`);
}

const valuesList = FNS.map((fn) => `      ('${fn}', '${BASELINES[fn]}')`).join(",\n");

const header = `-- ============================================================================
-- IDEMPOTENCY LOOKUP OPERATION-SCOPING SWEEP (C6 control follow-through)
-- ============================================================================
-- STAGED DRAFT (DRAFT role, 2026-06-11, second attempt — re-verified against
-- LIVE this session, after live version 20260611190251). Lives in
-- scripts/.staging-migrations/ per the race guard — only the APPLY role moves
-- this under supabase/migrations/, stamped with the MCP-assigned version.
--
-- SUPERSEDES the phantom draft "20260611080937_idempotency_lookup_operation_
-- scope_sweep.sql" from a prior session, which sat under supabase/migrations/
-- with a self-assigned stamp but was NEVER applied (verified: version
-- 20260611080937 absent from supabase_migrations.schema_migrations). That
-- file has been relocated to scripts/.staging-migrations/SUPERSEDED-
-- 20260611080937_idempotency_lookup_operation_scope_sweep.sql. This file was
-- regenerated from live FROM SCRATCH (build-idemscope-sweep.mjs — zero manual
-- transcription); the stale draft was used for nothing but a final diff.
--
-- THE BUG CLASS (restore_quote_version class, Codex 2026-06-08 LOW, at scale):
-- 22 live RPCs' inline idempotency lookup filtered ONLY on the key
-- (\`WHERE idempotency_key = p_idempotency_key\`) with no operation filter, so
-- a key collision across operations honors ANOTHER operation's cached row:
-- the second RPC silently skips its work and reports success. Root cause: the
-- historical CLAUDE.md copy-paste snippet omitted the operation filter
-- (snippet itself fixed in this change set). Every INSERT already recorded
-- the correct own-name operation; only the LOOKUP was unscoped.
--
-- THE FIX (uniform, minimal): each body below is VERBATIM from the live
-- catalog with exactly ONE change — the lookup gains
-- \` AND operation = '<function's own name>'\`. No other behavior change.
--
-- CARVE-OUT (2 of the 22 — race safety, same call as the prior reviewed
-- draft's rls-security-reviewer B1): create_planned_holds and save_quote are
-- EXCLUDED because the pending disk migration
-- 20260611132115_planned_holds_drawn_sync.sql (on disk, NOT in live
-- schema_migrations as of this draft) rebuilds both functions — with
-- operation-scoped lookups of its own (verified: its bodies filter
-- \`AND operation = '<own name>' AND created_at > now() - interval '24
-- hours'\`). Sweeping them here would let whichever change applied second
-- silently revert the other. They stay on the test's gap list (cap ratcheted
-- 22 -> 2) and fall off when that migration lands.
--
-- LIVE EVIDENCE (all read this session, 2026-06-11, via pg_catalog):
--   * All 20 swept functions: exactly 1 overload; SECURITY DEFINER;
--     proconfig search_path=public, pg_temp; ACL = postgres/authenticated/
--     service_role EXECUTE (NO anon, NO PUBLIC) — uniform across all 20.
--   * The lookup pattern occurs EXACTLY ONCE per body (catalog-counted), in
--     an idempotency_keys WHERE clause (builder context-asserted).
--   * Every body's INSERT already writes its own name as operation
--     (insert_ops catalog scan) — no INSERT fixes needed anywhere.
--   * plpgsql_check_function_tb: 0 errors on all 20 live bodies (the 2026-06-10
--     latent-break class was already fixed by the 2026-06-11 00:0x migrations).
--   * idempotency_keys columns: idempotency_key / operation / result (NOT
--     key / entity_type / entity_id), plus id, created_at, expires_at.
--
-- COLLISION SEMANTICS AFTER THIS FIX (deliberate, fail-loud):
--   idempotency_keys has UNIQUE (idempotency_key) — the key is globally
--   unique across operations. Post-fix, if a caller ever reuses one key for
--   two DIFFERENT operations: the second RPC no longer sees the foreign
--   cached row (the fix), does its real work, and its terminal INSERT raises
--   unique_violation 23505 — loud failure instead of the old silent
--   wrong-result success. (create_quote_version and start_job save with ON
--   CONFLICT (idempotency_key) DO NOTHING, matching the canonical
--   save_idempotency helper's fail-soft save; complete_job's ON CONFLICT is
--   on jobs applied-info, unrelated.) Cross-operation key reuse is a caller
--   bug in every case; the UI mints one key per call site via
--   useIdempotencyKey.
--
-- FIDELITY GATES (three, independent):
--   1. build-idemscope-sweep.mjs asserted, at fetch time, live md5(prosrc) ==
--      baseline AND md5(emitted body minus the one clause) == baseline.
--   2. scripts/.staging-migrations/verify-idemscope-md5.mjs re-checks this
--      file offline against the same baselines (20 PASS + 2 documented SKIPs).
--   3. The terminal DO block below re-asserts IN-DATABASE, post-apply:
--      overload=1, clause present exactly once, md5(prosrc minus clause) ==
--      baseline, SECURITY DEFINER + search_path intact, grants posture
--      unchanged (authenticated+service_role EXECUTE, anon NOT).
--
-- GRANTS: no GRANT/REVOKE statements anywhere in this file — CREATE OR
-- REPLACE preserves each function's existing ACL; the DO block asserts it.
--
-- SMOKE (run post-apply; rolled back by design):
--   scripts/smoke/smoke-idempotency_operation_scope_sweep.sql — representative
--   function batch_post_invoices: a key cached under a DIFFERENT operation is
--   NOT honored (call proceeds into the real body), its OWN duplicate IS
--   (cached short-circuit); ends RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'.
--
-- BASELINE md5(prosrc) MANIFEST (live, this session):
${FNS.map((fn) => `--   ${fn.padEnd(36)} ${BASELINES[fn]}`).join("\n")}
--   -- carved out (NOT in this sweep; live baselines recorded for the record):
${Object.entries(CARVED_OUT)
  .map(([fn, h]) => `--   ${fn.padEnd(36)} ${h}`)
  .join("\n")}
-- ============================================================================

`;

const doBlock = `-- ============================================================================
-- SELF-VERIFICATION (runs in the same transaction as the CREATEs above;
-- ANY failure aborts the whole apply — nothing lands partially)
-- ============================================================================
DO $verify$
DECLARE
  r record;
  v_oid oid;
  v_cnt int;
  v_src text;
  v_clause text;
  v_occurrences int;
  v_stripped_md5 text;
  v_secdef boolean;
  v_config text[];
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
${valuesList}
    ) AS t(fn, baseline_md5)
  LOOP
    -- (a) exactly one overload
    SELECT count(*) INTO v_cnt FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = r.fn;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'IDEMSCOPE %: overload count % (expected 1)', r.fn, v_cnt;
    END IF;

    SELECT oid, prosrc, prosecdef, proconfig
      INTO v_oid, v_src, v_secdef, v_config
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace AND proname = r.fn;

    -- (b) the scoped-lookup clause is present EXACTLY once
    v_clause := ' AND operation = ''' || r.fn || '''';
    v_occurrences := (length(v_src) - length(replace(v_src, v_clause, ''))) / length(v_clause);
    IF v_occurrences <> 1 THEN
      RAISE EXCEPTION 'IDEMSCOPE %: delta clause occurs % times (expected exactly 1)', r.fn, v_occurrences;
    END IF;

    -- (c) byte-fidelity: body minus the one clause == live baseline
    v_stripped_md5 := md5(replace(v_src, v_clause, ''));
    IF v_stripped_md5 <> r.baseline_md5 THEN
      RAISE EXCEPTION 'IDEMSCOPE %: body-minus-delta md5 % != baseline % — NOT verbatim-from-live, ABORT',
        r.fn, v_stripped_md5, r.baseline_md5;
    END IF;

    -- (d) SECDEF + search_path preserved
    IF NOT v_secdef THEN
      RAISE EXCEPTION 'IDEMSCOPE %: lost SECURITY DEFINER', r.fn;
    END IF;
    IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
      RAISE EXCEPTION 'IDEMSCOPE %: search_path=public, pg_temp missing from proconfig (%)', r.fn, v_config;
    END IF;

    -- (e) grants posture unchanged (live posture verified this session:
    --     authenticated + service_role EXECUTE; anon none)
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'IDEMSCOPE %: authenticated lost EXECUTE', r.fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'IDEMSCOPE %: service_role lost EXECUTE', r.fn;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'IDEMSCOPE %: anon gained EXECUTE — posture change refused', r.fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'IDEMSCOPE sweep verified: 20/20 functions scoped, verbatim (md5), single overload, SECDEF+search_path, grants intact';
END;
$verify$;
`;

const out = header + blocks.join("\n") + "\n" + doBlock;
writeFileSync(
  new URL("./idempotency_operation_scope_sweep.sql", import.meta.url),
  out,
  "utf8"
);
console.log(`\nWROTE idempotency_operation_scope_sweep.sql (${out.length} bytes, ${FNS.length} functions)`);
