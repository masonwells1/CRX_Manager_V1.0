/**
 * Offline contract proof for the parked transfer_job_to_invoice intent wrapper.
 * It deliberately reads only repository files; live application is separately
 * gated by migration review and an explicit owner approval.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrations = path.join(root, 'supabase', 'migrations');
const filename = '20260908130800_bind_transfer_invoice_intent.sql';
const source = fs.readFileSync(path.join(migrations, filename), 'utf8');
const wrapper = source.slice(source.indexOf('CREATE OR REPLACE FUNCTION public.transfer_job_to_invoice('));
const bodyMd5 = (pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `could not extract ${label} body`);
  return crypto.createHash('md5').update(match[1], 'utf8').digest('hex');
};
const cutoverGuardMd5 = bodyMd5(
  /CREATE OR REPLACE FUNCTION public\.prevent_unwrapped_transfer_invoice_receipt_20260908\(\)[\s\S]*?AS \$cutover_guard\$([\s\S]*?)\$cutover_guard\$;/,
  'cutover guard',
);
const wrapperMd5 = bodyMd5(
  /CREATE OR REPLACE FUNCTION public\.transfer_job_to_invoice\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/,
  'public wrapper',
);
assert.equal(cutoverGuardMd5, '339762db7603acca00779ca62bc86772', 'cutover guard body pin matches source');
assert.equal(wrapperMd5, 'b083dd371b091d7b70bb4cdc015c9bc8', 'runtime wrapper body pin matches source');
assert.equal(source.match(/339762db7603acca00779ca62bc86772/g)?.length, 2, 'cutover guard is pinned before and after apply');
assert.equal(source.match(/b083dd371b091d7b70bb4cdc015c9bc8/g)?.length, 2, 'runtime wrapper is pinned before and after apply');
assert.match(source, /CREATE TEMP TABLE crx_transfer_invoice_intent_transaction_guard[\s\S]*ON COMMIT DROP;[\s\S]*INSERT INTO crx_transfer_invoice_intent_transaction_guard/, 'autocommit refuses before shared-state changes');
assert.match(source, /SET LOCAL lock_timeout = '15s'/, 'cutover lock wait is bounded');
const cohort = [
  '20260905200000_commission_history_report_replay_guard.sql',
  '20260905200200_refuse_stale_commission_payment_recipient.sql',
  '20260905200300_enforce_commission_payment_business_date.sql',
  '20260905200400_commission_dates_follow_chicago_business_day.sql',
  '20260905200600_latest_commission_recipient_label.sql',
];

const at = (needle) => {
  const index = wrapper.indexOf(needle);
  assert.notEqual(index, -1, `missing contract token: ${needle}`);
  return index;
};

for (const prerequisite of cohort) {
  assert(filename.slice(0, 14) > prerequisite.slice(0, 14), `${filename} must order after ${prerequisite}`);
  assert(fs.existsSync(path.join(migrations, prerequisite)), `missing commission prerequisite ${prerequisite}`);
}
assert(filename < '20260908130900_repair_commission_history_label_snapshots.sql', 'transfer wrapper must precede the tail repair');

assert.match(source, /md5\(v_public_src\).*85cd07a0a6b978cb066edab7df369fea/s, 'first apply pins Chicago preimage');
assert.match(source, /md5\(p\.prosrc\).*edc73be809069669e8441eba7acf443d/s, 'helper body pin is present');
assert.match(source, /71b8a6a0b53f2234a0808b1270eaa06b3c8bf0e7d2523fc429c88e5c479407c8/, 'helper SHA-256 pin is present');
assert.match(source, /unexpired legacy transfer_job_to_invoice receipts exist/, 'legacy receipt refusal is present');
assert.match(source, /expires_at IS NULL OR expires_at > now\(\)/, 'null-expiry legacy receipts are treated as live');
assert.match(source, /c\.relrowsecurity[\s\S]*NOT c\.relforcerowsecurity[\s\S]*pg_get_userbyid\(c\.relowner\) = 'postgres'/, 'receipt table owner and RLS state are pinned');
assert.match(source, /pol\.polname = 'No direct client access to idempotency keys'[\s\S]*pol\.polroles = ARRAY\[0::oid\][\s\S]*pg_get_expr\(pol\.polqual, pol\.polrelid\) = 'false'[\s\S]*pg_get_expr\(pol\.polwithcheck, pol\.polrelid\) = 'false'/, 'sole deny-all receipt policy is pinned');
assert.match(source, /browser_role\.rolname IN \('anon', 'authenticated'\)[\s\S]*elevated_role\.rolsuper OR elevated_role\.rolbypassrls[\s\S]*pg_has_role\(browser_role\.oid, elevated_role\.oid, 'MEMBER'\)/, 'browser roles cannot inherit or assume any superuser or RLS-bypass role');
assert.match(source, /has_table_privilege\('anon', 'public\.idempotency_keys', 'INSERT'\)[\s\S]*has_table_privilege\('anon', 'public\.idempotency_keys', 'TRUNCATE'\)/, 'anon write ACL drift is rejected');
assert.match(source, /acl\.grantee = 0[\s\S]*'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'/, 'PUBLIC write ACL drift is rejected');
assert.match(source, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s+ON TABLE public\.idempotency_keys\s+FROM PUBLIC, anon, authenticated;/, 'browser receipt mutation privileges are revoked without removing SELECT');
assert.equal(source.match(/browser_role\.role_name, 'public\.idempotency_keys', forbidden\.privilege_name/g)?.length, 4, 'effective browser table and column privileges are checked before cutover and at postflight');
assert.equal(source.match(/acl\.privilege_type IN \('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'\)/g)?.length, 2, 'PUBLIC table privileges are checked before cutover and at postflight');
assert.equal(source.match(/acl\.privilege_type IN \('INSERT', 'UPDATE', 'REFERENCES'\)/g)?.length, 2, 'PUBLIC column privileges are checked before cutover and at postflight');
assert.equal(source.match(/browser role retains direct idempotency receipt mutation privilege/g)?.length, 2, 'browser receipt ACL boundary has independent preflight and postflight refusals');
assert(source.indexOf('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') < source.indexOf('CREATE TRIGGER trg_idempotency_keys_require_transfer_intent_20260908'), 'browser receipt ACL is normalized before the cutover trigger');
assert.match(source, /CREATE TRIGGER trg_idempotency_keys_require_transfer_intent_20260908[\s\S]*BEFORE INSERT ON public\.idempotency_keys/, 'cutover trigger is installed on receipt insert');
assert.match(source, /TRANSFER_INVOICE_INTENT_CUTOVER_RETRY/, 'stale cached implementations fail with a retry signal');
assert(source.indexOf('CREATE TEMP TABLE crx_transfer_invoice_intent_transaction_guard') < source.indexOf('DO $preflight$'), 'transaction guard precedes preflight');
assert(source.indexOf('CREATE TRIGGER trg_idempotency_keys_require_transfer_intent_20260908') < source.indexOf('DO $receipt_preflight$'), 'cutover trigger precedes legacy receipt scan');
assert(source.indexOf('DO $receipt_preflight$') < source.indexOf('DO $rename$'), 'legacy receipt scan precedes function rename');
// Sol, PR #638: drain readers too, and delete the expired unbound receipts a
// legacy call parked on its key's advisory lock could otherwise replay.
assert.match(source, /^LOCK TABLE public\.idempotency_keys IN ACCESS EXCLUSIVE MODE;$/m, 'receipt readers and writers are drained');
assert(source.indexOf("SET LOCAL lock_timeout = '15s'") < source.indexOf('LOCK TABLE public.idempotency_keys'), 'the early lock wait is bounded');
assert(source.indexOf('LOCK TABLE public.idempotency_keys') < source.indexOf('DO $preflight$'), 'the receipt lock precedes every preflight read');
const expiredReceiptPurge = /DELETE FROM public\.idempotency_keys\n WHERE operation = 'transfer_job_to_invoice'\n   AND expires_at <= now\(\)\n   AND \(request_actor_id IS NULL OR request_fingerprint IS NULL\);/;
assert.match(source, expiredReceiptPurge, 'expired unbound transfer receipts are deleted under the lock');
assert.equal(source.match(/DELETE FROM public\.idempotency_keys/g)?.length, 1, 'the expired-receipt purge is the only receipt delete');
assert(source.indexOf('CREATE TRIGGER trg_idempotency_keys_require_transfer_intent_20260908') < source.search(expiredReceiptPurge), 'purge follows the cutover trigger');
assert(source.search(expiredReceiptPurge) < source.indexOf('DO $receipt_preflight$'), 'purge precedes the unexpired-receipt refusal');
assert.match(source, /set_config\('crx\.transfer_invoice_intent_wrapper', '20260908', true\)/, 'wrapper owns an explicit transaction-local cutover marker');
assert.match(source, /request_actor_id IS NULL OR request_fingerprint IS NULL/, 'legacy receipt definition is unbound');
assert.match(source, /request_actor_id IS NULL\s+AND request_fingerprint IS NULL/, 'receipt binding cannot overwrite an existing binding');
assert.match(source, /transfer function overload drift detected/, 'overload drift refuses');
assert.match(source, /private implementation exists but public body, signature, security, or ACL is not this migration wrapper/, 'replay state refuses arbitrary body');
assert.match(source, /ALTER FUNCTION public\.transfer_job_to_invoice\(uuid, uuid, text\)\s+RENAME TO _transfer_job_to_invoice_intent_impl_20260908/s, 'first apply renames reviewed body');
assert.match(source, /REVOKE ALL ON FUNCTION public\._transfer_job_to_invoice_intent_impl_20260908[\s\S]*FROM PUBLIC, anon, authenticated, service_role/, 'private ACL is owner-only');
assert.match(source, /IF v_actor IS NULL THEN\s+RAISE EXCEPTION 'AUTH_REQUIRED'/s, 'authentication is required');
assert.match(source, /p_performed_by IS DISTINCT FROM v_actor/, 'actor mismatch is rejected');
assert.match(source, /v_role NOT IN \('admin', 'sales_rep'\)/, 'active office role is required');
assert.match(source, /p_idempotency_key COLLATE "C" !~ '\^\[!-~\]\{1,200\}\$'/, 'blank and non-printable keys are rejected');
assert.match(source, /jsonb_build_object\('actor_id', v_actor, 'job_id', p_job_id\)/, 'fingerprint includes actor and job');
assert.match(source, /extensions\.digest[\s\S]*'sha256'/, 'fingerprint uses server SHA-256');
assert.match(source, /v_replay := public\.check_idempotency_intent\([\s\S]*'transfer_job_to_invoice', v_actor, v_fingerprint/s, 'replay delegates to intent helper');
assert.match(source, /\(v_result ->> 'job_id'\) IS DISTINCT FROM p_job_id::text/, 'replay and first-call result are job-validated');
assert.match(source, /SET request_actor_id = v_actor,[\s\S]*request_fingerprint = v_fingerprint/, 'receipt is bound after execution');
assert(at('v_replay := public.check_idempotency_intent') < at('v_result := public._transfer_job_to_invoice_intent_impl_20260908'), 'intent lookup precedes implementation');
assert(at("PERFORM set_config('crx.transfer_invoice_intent_wrapper', '20260908', true)") < at('v_result := public._transfer_job_to_invoice_intent_impl_20260908'), 'wrapper marker precedes implementation');
assert(at('v_result := public._transfer_job_to_invoice_intent_impl_20260908') < at('SET request_actor_id'), 'receipt binding follows implementation');
assert.match(source, /IDEMPOTENCY_RECEIPT_MISSING/, 'missing receipt fails closed');
assert.match(source, /p\.pronargdefaults = 1/, 'public default is asserted');
assert.match(source, /p\.proargnames = ARRAY\['p_job_id', 'p_performed_by', 'p_idempotency_key'\]/, 'argument names are pinned');
assert.match(source, /p\.provolatile = 'v'/, 'volatility is pinned');
assert.match(source, /p\.proacl = ARRAY\['postgres=X\/postgres', 'authenticated=X\/postgres', 'service_role=X\/postgres'\]/, 'public ACL is pinned');
assert.match(source, /md5\(p\.prosrc\) = '85cd07a0a6b978cb066edab7df369fea'/, 'private Chicago body is postflight-pinned');
assert.match(source, /TO authenticated, service_role/, 'public wrapper grants are deliberate');
assert.match(source, /COMMENT ON FUNCTION public\.transfer_job_to_invoice\(uuid, uuid, text\)/, 'public wrapper comment is deliberate');

console.log('TRANSFER_INVOICE_INTENT_STATIC_PROOF_PASS');
