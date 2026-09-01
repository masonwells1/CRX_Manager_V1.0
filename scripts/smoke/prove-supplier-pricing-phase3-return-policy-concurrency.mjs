#!/usr/bin/env node
/**
 * Real-schema, network-isolated Phase 3 proof.  The required schema dump is
 * read-only input; this runner never reads a DB URL or connects to Supabase.
 *
 *   node scripts/decompress-schema-baseline.mjs > public-schema.sql
 *   node scripts/smoke/prove-supplier-pricing-phase3-return-policy-concurrency.mjs \
 *     --schema-dump public-schema.sql
 *
 * The repository's own committed baseline is the only accepted input: it is the
 * one dump whose provenance is establishable here, because the manifest records
 * its digest and the ACL artifact this proof restores belongs to that same
 * generation.  Any other dump is refused rather than proven against.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const dump=process.argv[2]==='--schema-dump'?process.argv[3]:process.env.CRXP3_SCHEMA_DUMP;
if(!dump||!existsSync(dump)) throw new Error('usage: node scripts/smoke/prove-supplier-pricing-phase3-return-policy-concurrency.mjs --schema-dump <read-only-public-schema.sql>\n  produce the dump with: node scripts/decompress-schema-baseline.mjs > public-schema.sql');
const NAME=`crx-phase3-real-${process.pid}-${Date.now().toString(36)}`;
const image='public.ecr.aws/supabase/postgres:17.6.1.141';
// Resolve repository artifacts by suffix, never by timestamp prefix. Migration
// files get renumbered before they land and the schema baseline is regenerated
// under a fresh timestamp, so a pinned prefix silently rots into a hard
// `missing <k>` abort that stops this proof before it runs.
function resolveMigration(suffix){
  const dir=path.join(ROOT,'supabase/migrations');
  const hits=readdirSync(dir).filter(f=>f.endsWith(suffix)).sort();
  if(hits.length!==1) throw new Error(`expected exactly one supabase/migrations/*${suffix}, found ${hits.length}${hits.length?`: ${hits.join(', ')}`:''}`);
  return path.join(dir,hits[0]);
}
// The baseline manifest -- not the directory listing -- is the authority for
// which generation's artifacts to use and what each must hash to. Picking the
// lexically-last file per suffix would happily pair a stale extensions dump
// with a fresh ACL file, and would apply an artifact that had been edited.
const manifest=JSON.parse(readFileSync(path.join(ROOT,'supabase/baselines/manifest.json'),'utf8'));
const sha256=local=>createHash('sha256').update(readFileSync(local)).digest('hex').toUpperCase();
function resolveBaseline(suffix){
  const hits=Object.keys(manifest.artifacts??{}).filter(f=>f.endsWith(suffix));
  if(hits.length!==1) throw new Error(`expected exactly one baseline artifact *${suffix} in manifest.json, found ${hits.length}${hits.length?`: ${hits.join(', ')}`:''}`);
  const local=path.join(ROOT,'supabase/baselines',hits[0]);
  if(!existsSync(local)) throw new Error(`manifest names ${hits[0]} but the file is missing`);
  const want=manifest.artifacts[hits[0]].sha256, got=sha256(local);
  if(got!==want) throw new Error(`baseline artifact ${hits[0]} does not match manifest sha256 (manifest ${want}, on disk ${got})`);
  return local;
}
// Bind the caller-supplied dump to this exact baseline generation, and accept
// nothing else. The repository's committed baseline is the only schema whose
// provenance this proof can establish: the manifest records its digest, and the
// companion ACL artifact restored below belongs to that same generation.
//
// An unbound dump cannot be proven against, even one predating Stage A. Every
// success marker this script prints would look identical, while the schema
// underneath could carry stale or crafted definitions of the very helpers the
// assertions lean on -- `check_idempotency`, `_issue_return_credit_impl`, the
// return implementations -- so the run would certify behavior that is not the
// repository's. There is no second trusted input, so there is no second path.
// Exactly one candidate, same as resolveBaseline: taking the first suffix match
// would let a second generation's entry sit unnoticed in the manifest and decide
// which dump this proof accepts, which is the ambiguity this binding exists to
// remove.
const schemaHits=Object.keys(manifest.artifacts??{}).filter(f=>f.endsWith('_public_schema.sql.br'));
if(schemaHits.length!==1) throw new Error(`expected exactly one *_public_schema.sql.br entry in manifest.json to bind the dump against, found ${schemaHits.length}${schemaHits.length?`: ${schemaHits.join(', ')}`:''}`);
const schemaArtifact=schemaHits[0];
const baselineDumpSha=manifest.artifacts[schemaArtifact].decoded_sha256;
if(!baselineDumpSha) throw new Error(`manifest.json entry ${schemaArtifact} has no decoded_sha256 to bind the dump against`);
// The replay below asks the baseline tooling which migrations post-date
// `migrations_high_water`, then trusts that answer to mean "everything the dump
// is missing". That only holds while the high-water names the same generation as
// the dump artifact. Bumping the high-water on its own -- without regenerating
// the dump -- would empty the pending list, and the proof would quietly go back
// to certifying the older schema while still printing a replay marker. These two
// fields are the join between the artifact and the ledger, so assert they agree
// rather than assuming the tooling always writes them together.
const schemaArtifactGeneration=schemaArtifact.slice(0,14);
if(schemaArtifactGeneration!==manifest.migrations_high_water) throw new Error(`baseline manifest is internally inconsistent: schema artifact ${schemaArtifact} is generation ${schemaArtifactGeneration} but migrations_high_water is ${manifest.migrations_high_water}. The post-baseline replay cannot determine what the dump is missing; regenerate supabase/baselines so both agree.`);
const dumpSha=sha256(path.resolve(dump));
if(dumpSha!==baselineDumpSha) throw new Error(`refusing to prove against an unbound schema dump: ${path.resolve(dump)} hashes to ${dumpSha}, but this baseline generation (${schemaArtifact}) requires ${baselineDumpSha}. Produce the accepted dump with \`node scripts/decompress-schema-baseline.mjs > public-schema.sql\`.`);
const files={ extensions:resolveBaseline('_extensions.sql'), aclLockdown:resolveBaseline('_acl_lockdown.sql'), migrationHistory:resolveBaseline('_migration_history.sql'), dump:path.resolve(dump), section9:resolveMigration('_section9_po_ap_high_remediation.sql'), stageA:resolveMigration('_product_families_return_policy_foundation.sql'), smoke:path.join(ROOT,'scripts/smoke/smoke-supplier-pricing-phase3-return-policy.sql') };
for(const [k,v] of Object.entries(files)) if(!existsSync(v)) throw new Error(`missing ${k}: ${v}`);
// The baseline is a point-in-time snapshot, so every migration that landed after
// its high-water is absent from the restored schema. Proving Phase 3 against that
// older shape is a real hole and not a theoretical one: every marker below would
// print identically while the schema being inspected sat behind production, so a
// regression introduced by a later migration would pass here. Replay the pending
// set instead, in ledger order, delegating "what is missing from the baseline" to
// the same script the schema-baseline tooling already uses -- a second copy of
// that rule here would be free to drift from the one that governs the baseline.
// Shelled out rather than imported because the module prints the list from its
// own top-level body, which would otherwise land in this proof's stdout.
function postBaselineMigrations(){
  const script=path.join(ROOT,'scripts/list-post-baseline-migrations.mjs');
  if(!existsSync(script)) throw new Error(`missing post-baseline migration enumerator: ${script}`);
  // That script decides what is pending by reading the baseline's captured
  // migration ledger and trusting the names inside it. The ledger is a manifest
  // artifact with a recorded digest, so verify it instead of trusting the bytes on
  // disk: splicing a post-baseline migration's stem into that COPY block removes
  // it from the pending list, and this proof would go straight back to certifying
  // a schema missing that migration while still printing a replay marker. Same
  // hole as the high-water check above, entered from the other side.
  // resolveBaseline performs the manifest hash comparison and throws on mismatch.
  const history=path.basename(resolveBaseline('_migration_history.sql'));
  const historyGeneration=history.slice(0,14);
  if(historyGeneration!==manifest.migrations_high_water) throw new Error(`baseline migration-history artifact ${history} is generation ${historyGeneration} but migrations_high_water is ${manifest.migrations_high_water}; the enumerator would read a different ledger than the one just hash-verified.`);
  const r=spawnSync(process.execPath,[script],{cwd:ROOT,encoding:'utf8',maxBuffer:8*1024*1024});
  if(r.error||r.status!==0) throw new Error(`could not enumerate post-baseline migrations: ${r.error?.message||''}\n${r.stderr||r.stdout}`);
  return r.stdout.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(rel=>{
    // Validate the shape rather than trusting stdout: a future change to that
    // script that prints a summary line must fail loudly here, not get copied
    // into the container as a migration and applied.
    if(!/^supabase\/migrations\/\d{14}_[^/]+\.sql$/.test(rel)) throw new Error(`unexpected line from list-post-baseline-migrations.mjs, not a migration path: ${rel}`);
    const local=path.join(ROOT,rel);
    if(!existsSync(local)) throw new Error(`post-baseline migration is listed but missing on disk: ${rel}`);
    return local;
  });
}
const pendingMigrations=postBaselineMigrations();
function run(args,o={}){const r=spawnSync('docker',args,{cwd:ROOT,encoding:'utf8',input:o.input,maxBuffer:50*1024*1024});if(r.error||(!o.fail&&r.status!==0))throw new Error(`${r.error?.message||''}\n${r.stderr||r.stdout}`);return r}
function psqlArgs(){return ['exec','-i',NAME,'psql','-U','postgres','-d','postgres','-X','-q','-A','-t','-v','ON_ERROR_STOP=1']}
function sql(s,o={}){return run(psqlArgs(),{input:s,fail:o.fail})}
function adminSql(s,o={}){return run(['exec','-i',NAME,'psql','-U','supabase_admin','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'],{input:s,fail:o.fail})}
function file(local,name){run(['cp',local,`${NAME}:/tmp/${name}`])}
function apply(name){return sql(`BEGIN;
\\i /tmp/${name}
COMMIT;`)}
function session(s,marker){const c=spawn('docker',psqlArgs(),{cwd:ROOT,stdio:['pipe','pipe','pipe']});let out='',err='',timer,settled=false;let resolve,reject;const ready=new Promise((r,j)=>{resolve=r;reject=j;timer=setTimeout(()=>{if(!settled){settled=true;j(new Error(`timeout waiting for ${marker}: ${err||out}`))}},20000)});c.stdout.on('data',x=>{out+=x;if(!settled&&out.includes(marker)){settled=true;clearTimeout(timer);resolve()}});c.stderr.on('data',x=>err+=x);c.stdin.end(s);const done=new Promise(r=>c.on('close',code=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error(`session ended before ${marker}: ${err||out}`))}r({code,out,err})}));return {ready,done,output:()=>out} }
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function scalar(statement){const out=sql(statement).stdout.trim(); if(!out)throw new Error(`expected scalar output: ${statement}`); return out.split(/\r?\n/).at(-1)}
function json(statement){return JSON.parse(scalar(statement))}
function claims(userId){return `SET \"request.jwt.claim.sub\" = '${userId}'; SET \"request.jwt.claim.role\" = 'authenticated';`}
function assertExactFailure(result,code,label){const exit=result.code??result.status, out=result.out??result.stdout??'', err=result.err??result.stderr??'';assert.notEqual(exit,0,`${label} unexpectedly succeeded: ${out}`);assert.match(`${out}\n${err}`,new RegExp(`ERROR:\\s+${code}`),`${label} did not fail ${code}: ${out}\n${err}`)}
async function assertWaiting(done,label){const state=await Promise.race([done.then(()=> 'finished'),pause(500).then(()=> 'waiting')]);assert.equal(state,'waiting',`${label} did not wait for the advisory lock`)}
async function assertMarkerBlocked(ready,label){const state=await Promise.race([ready.then(()=> 'marked'),pause(500).then(()=> 'waiting')]);assert.equal(state,'waiting',`${label} acquired the Product advisory lock before cancellation released inventory`)}
try {
  run(['run','-d','--name',NAME,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m','-e','POSTGRES_PASSWORD=postgres',image]);
  let healthy=false; for(let i=0;i<90;i++){if(run(['exec',NAME,'pg_isready','-U','postgres','-d','postgres'],{fail:true}).status===0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);if(run(['exec',NAME,'pg_isready','-U','postgres','-d','postgres'],{fail:true}).status===0){healthy=true;break}}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)} if(!healthy)throw new Error('disposable Postgres did not become healthy');
  for(const [k,v] of Object.entries(files)) file(v,`${k}.sql`);
  adminSql('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);');
  apply('extensions.sql'); apply('dump.sql');
  sql(`
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  statements text[]
);
\\i /tmp/migrationHistory.sql
`);
  // The dump is hash-bound to the current baseline generation, which is at or
  // past both migrations' high-water, so both must already be in the restored
  // schema. Neither is re-applied here -- both are non-idempotent (CREATE TABLE
  // / CREATE UNIQUE INDEX / CREATE POLICY / DROP CONSTRAINT) and would abort.
  // Assert their arrival anyway: if a future baseline is regenerated from a
  // database missing them, that is a schema-provenance failure, and it must
  // surface here rather than as a confusing error deep in the matrix below.
  const present=probe=>scalar(`SELECT (${probe})::text;`)==='true';
  const hasStageA=present(`to_regclass('public.product_families') IS NOT NULL`);
  // Pinned to the relation, not just the trigger name: the same name attached to
  // some other table would satisfy a name-only probe while leaving
  // purchase_order_items untriggered, which is exactly the drift this asserts on.
  const hasSection9=present(`EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE t.tgname='trg_po_items_recompute_on_order' AND NOT t.tgisinternal
       AND n.nspname='public' AND c.relname='purchase_order_items')`);
  console.log(`PHASE3_DUMP_STATE stage_a=${hasStageA?'present':'absent'} section09=${hasSection9?'present':'absent'} dump_sha256=${dumpSha}`);
  if(!hasStageA||!hasSection9) throw new Error(`the hash-bound baseline dump is missing schema this proof asserts against (stage_a=${hasStageA?'present':'absent'}, section09=${hasSection9?'present':'absent'}); regenerate supabase/baselines from a database at or past both migrations`);
  // The baseline dump needs its companion ACL artifact. A schema dump can only
  // GRANT, and this image's ALTER DEFAULT PRIVILEGES re-grants EXECUTE to
  // anon/authenticated as each function is created, which `REVOKE ... FROM
  // PUBLIC` does not strip. Without this step the smoke matrix correctly fails
  // its app-role privilege assertion. The artifact owns its own transaction, so
  // it is applied without the BEGIN/COMMIT wrapper, and it self-verifies via
  // BASELINE_ACL_ANON_EXECUTE_DRIFTED. Safe here precisely because the dump is
  // pinned to this generation: its GRANTs name objects that an older dump would
  // not contain, and it cannot mask drift in a schema it did not come from.
  sql('\\i /tmp/aclLockdown.sql');
  console.log('PHASE3_BASELINE_ACL_LOCKDOWN_APPLIED');
  // Bring the restored snapshot up to the migration set production actually has.
  // Ordered after the ACL artifact because that is the order production saw: the
  // lockdown belongs to the baseline generation, and each of these migrations
  // issues its own REVOKEs afterwards. Non-idempotent statements are safe -- this
  // is a fresh restore and each file is applied exactly once, as on production.
  // Every migration's own terminal verification block runs as part of the replay,
  // so a migration whose postflight assertions no longer hold on this schema
  // fails here instead of being skipped.
  for(const local of pendingMigrations){
    const name=path.basename(local);
    // A migration that opens its own transaction must not be wrapped in a second
    // one: the inner COMMIT would end the outer transaction early and silently
    // drop the rest of the file into autocommit. `BEGIN;` with a semicolon at the
    // start of a line is the discriminator -- PL/pgSQL block openers inside a
    // function body are a bare `BEGIN` with no semicolon, so they do not match.
    const ownsTransaction=/^[ \t]*BEGIN[ \t]*;/mi.test(readFileSync(local,'utf8'));
    file(local,`pending_${name}`);
    if(ownsTransaction) sql(`\\i /tmp/pending_${name}`); else apply(`pending_${name}`);
    console.log(`PHASE3_POST_BASELINE_MIGRATION_APPLIED ${name}${ownsTransaction?' (self-transacted)':''}`);
  }
  console.log(`PHASE3_POST_BASELINE_REPLAY_PASS count=${pendingMigrations.length} baseline_high_water=${manifest.migrations_high_water}`);
  // Both migrations arrive inside the dump, so neither one's postflight security
  // assertions have run in this container. The probes above only establish that
  // one table and one trigger name exist; they say nothing about SECURITY
  // DEFINER, `search_path`, trigger relation/binding identity, function-body
  // hashes, grants, deferred-constraint timing, or AP overload counts. Each
  // migration ends with exactly one terminal assertion block that checks all of
  // that, and those blocks are pure reads, so replay both here. Without this, a
  // baseline regenerated from a drifted database -- an unsafe function
  // definition, a wrongly bound trigger, an extra AP overload -- would still
  // print every success marker below.
  function terminalAssertionBlock(local){
    const source=readFileSync(local,'utf8').replace(/\r\n/g,'\n');
    const opener=[...source.matchAll(/^DO \$([A-Za-z0-9_]+)\$$/gm)].at(-1);
    if(!opener) throw new Error(`no terminal DO block found in ${path.basename(local)}`);
    const tag=`$${opener[1]}$`, block=source.slice(opener.index).trimEnd();
    if(!block.endsWith(`${tag};`)) throw new Error(`terminal ${tag} block in ${path.basename(local)} is not the final statement; postflight assertions cannot be replayed safely`);
    return block;
  }
  for(const [label,local] of [['section09',files.section9],['stage_a',files.stageA]]){
    sql(terminalAssertionBlock(local));
    console.log(`PHASE3_MIGRATION_POSTFLIGHT_ASSERTIONS_PASS ${label}`);
  }
  // Section 9's own postflight block is weaker than its marker suggests: it counts
  // pg_proc rows across three AP routine names and demands the total be 3, so a
  // dropped routine paired with an extra overload of another still totals 3 and
  // passes. It also never looks at the recompute trigger's binding. Nothing later
  // in this proof exercises those objects, so without the assertions below a
  // baseline carrying either drift would print a postflight-pass marker anyway.
  // Assert full identity instead of counts: exact argument lists (which is what
  // an overload changes), SECURITY DEFINER, search_path, and the trigger's
  // relation/events/function as PostgreSQL itself renders them.
  sql(`DO $sec9$
DECLARE v_def text; v_norm text; v_expected text; v_actual text; v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM pg_trigger WHERE tgname='trg_po_items_recompute_on_order' AND NOT tgisinternal;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SECTION9_TRIGGER_COUNT_UNEXPECTED: %', v_count;
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE t.tgname='trg_po_items_recompute_on_order' AND NOT t.tgisinternal
     AND n.nspname='public' AND c.relname='purchase_order_items';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'SECTION9_TRIGGER_NOT_BOUND_TO_PURCHASE_ORDER_ITEMS';
  END IF;
  v_norm := btrim(regexp_replace(v_def,'\\s+',' ','g'));
  v_expected := 'CREATE TRIGGER trg_po_items_recompute_on_order AFTER INSERT OR DELETE OR UPDATE OF purchase_order_id, product_id, quantity_ordered, quantity_received ON public.purchase_order_items FOR EACH ROW EXECUTE FUNCTION trg_po_items_recompute_on_order()';
  IF v_norm <> v_expected THEN
    RAISE EXCEPTION 'SECTION9_TRIGGER_DEFINITION_DRIFTED: %', v_norm;
  END IF;

  -- Identity here means more than the argument list. These three are SECURITY
  -- DEFINER money routines, so the properties that decide whether they are safe
  -- are: who may EXECUTE them, what they return, and what language body runs
  -- with the definer's rights. A baseline carrying an AP routine re-granted to
  -- anon -- the exact shape of incidents B7/B8/B9 -- satisfied every earlier
  -- assertion here, because prosecdef and proconfig are unchanged by a GRANT.
  -- Grantees are compared as a set with the owner excluded, so this does not
  -- break if the restored dump is owned by postgres rather than supabase_admin;
  -- PUBLIC is rendered by name so a re-grant to it fails loudly rather than
  -- disappearing into an oid. A NULL proacl means "default privileges apply",
  -- which for these routines is itself the failure, so it is rendered as
  -- <default> and cannot match.
  --
  -- prosrc is deliberately NOT pinned. A body hash would be the strongest
  -- assertion available, but these routines are under active change (the
  -- in-flight vendor-bill period-close work rewrites two of the three), so a
  -- hash would fail this proof on every legitimate AP edit and train whoever
  -- hits it to update the literal without reading the diff.
  --
  -- Be clear about what that leaves uncovered: this asserts the routines'
  -- INTERFACE and REACHABILITY -- signature, overload set, definer rights,
  -- resolved search_path, return type, language, who may call them -- and not
  -- their behavior. A rewritten body that keeps all of those intact passes
  -- here, so actor-forgery, idempotency and money-arithmetic drift are NOT
  -- detected by this block. Those are covered, where they are covered at all,
  -- by the behavioral proofs later in this file; this block's job is to stop a
  -- drifted baseline from reaching them wearing the right signature.
  SELECT string_agg(sig,';' ORDER BY sig) INTO v_actual FROM (
    SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||') secdef='||p.prosecdef::text
           ||' config='||coalesce(array_to_string(p.proconfig,','),'<none>')
           ||' returns='||pg_get_function_result(p.oid)
           ||' lang='||l.lanname
           -- '+grant' marks WITH GRANT OPTION. Without it a holder could hand
           -- EXECUTE on a money routine to anon and the grantee set here would
           -- never name anon, so the delegation itself has to be in the string.
           ||' execgrantees='||coalesce((
                SELECT string_agg(DISTINCT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                                            ||CASE WHEN a.is_grantable THEN '+grant' ELSE '' END),','
                                  ORDER BY (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                                            ||CASE WHEN a.is_grantable THEN '+grant' ELSE '' END))
                  FROM aclexplode(p.proacl) a
                 WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner
              ),CASE WHEN p.proacl IS NULL THEN '<default>' ELSE '<none>' END)
           -- A SECURITY DEFINER routine executes AS ITS OWNER, so ownership is
           -- part of the security identity, not bookkeeping: transferring these
           -- to an unsafe role changes what they can do while leaving the ACL
           -- untouched. The owner is not compared by name because the restored
           -- container owns as postgres and live owns as supabase_admin, so pin
           -- membership of the trusted set instead and name the owner only when
           -- it has left that set -- that way the failure says who took it.
           ||' owner='||CASE WHEN pg_get_userbyid(p.proowner) IN ('postgres','supabase_admin')
                             THEN '<trusted>' ELSE pg_get_userbyid(p.proowner) END
           -- The grantee list above is the DIRECT grants only. anon could still
           -- reach a routine by inheriting a role that holds EXECUTE, which adds
           -- no anon ACL entry at all, so ask the effective question too. A
           -- missing anon role renders a value that cannot match, rather than
           -- quietly reporting "not executable".
           ||' anonexec='||CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')
                                THEN has_function_privilege('anon',p.oid,'EXECUTE')::text
                                ELSE '<no-anon-role>' END AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname='public'
       AND p.proname IN ('create_vendor_bill','get_ap_aging','update_vendor_bill')
  ) s;
  v_expected :=
    'create_vendor_bill(p_vendor_id uuid, p_purchase_order_id uuid, p_bill_number text, p_bill_date date, p_due_date date, p_payment_terms text, p_subtotal_cents bigint, p_adjustment_cents bigint, p_notes text, p_idempotency_key text) secdef=true config=search_path=public, pg_temp returns=uuid lang=plpgsql execgrantees=authenticated,service_role owner=<trusted> anonexec=false'
    ||';get_ap_aging(p_as_of_date date) secdef=true config=search_path=public, pg_temp returns=TABLE(vendor_id uuid, vendor_name text, current_amount bigint, days_1_30 bigint, days_31_60 bigint, days_61_90 bigint, over_90 bigint, total_outstanding bigint, bill_count integer) lang=plpgsql execgrantees=authenticated,service_role owner=<trusted> anonexec=false'
    ||';update_vendor_bill(p_bill_id uuid, p_subtotal_cents bigint, p_adjustment_cents bigint, p_bill_date date, p_due_date date, p_notes text, p_idempotency_key text) secdef=true config=search_path=public, pg_temp returns=jsonb lang=plpgsql execgrantees=authenticated,service_role owner=<trusted> anonexec=false';
  IF coalesce(v_actual,'<none>') <> v_expected THEN
    RAISE EXCEPTION 'SECTION9_AP_ROUTINE_IDENTITY_DRIFTED: %', coalesce(v_actual,'<none>');
  END IF;
END;
$sec9$;`);
  console.log('PHASE3_SECTION9_OBJECT_IDENTITY_PASS');
  // Every trigger assertion above and in both replayed terminal blocks reads
  // pg_get_triggerdef(), whose output is byte-identical whether the trigger is
  // enabled, disabled, or replica-only -- tgenabled is simply not part of the
  // rendered definition. A baseline captured from a database where any of these
  // was left disabled would therefore satisfy every identity check while the
  // behavior it guards silently does not run. Assert the whole set in one place,
  // relation-qualified, so a disabled, dropped, renamed, or rebound trigger all
  // land as the same failure. This is checked for the full load-bearing set, not
  // only the two triggers the definition checks above happen to name.
  // tgenabled is PostgreSQL's internal "char" type, which has no unambiguous
  // concatenation operator with text -- the cast is required, not cosmetic.
  const triggerState=scalar(`SELECT coalesce(string_agg(c.relname||'.'||t.tgname||'='||t.tgenabled::text,';' ORDER BY c.relname||'.'||t.tgname COLLATE "C"),'<none>')
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname='public'
     AND t.tgname IN ('set_product_families_updated_at','trigger_w_defer_phase3_return_item_product_fk',
       'trigger_x_validate_phase3_return_item_policy','trigger_y_lock_assert_phase3_return_item_insert_policy',
       'trigger_y_lock_assert_phase3_return_item_update_policy','trigger_x_lock_phase3_return_status_products',
       'trigger_x_require_governed_phase3_product_metadata','trg_po_items_recompute_on_order',
       'trg_po_status_recompute_on_order');`);
  assert.equal(triggerState,[
    'product_families.set_product_families_updated_at=O',
    'products.trigger_x_require_governed_phase3_product_metadata=O',
    'purchase_order_items.trg_po_items_recompute_on_order=O',
    'purchase_orders.trg_po_status_recompute_on_order=O',
    'return_items.trigger_w_defer_phase3_return_item_product_fk=O',
    'return_items.trigger_x_validate_phase3_return_item_policy=O',
    'return_items.trigger_y_lock_assert_phase3_return_item_insert_policy=O',
    'return_items.trigger_y_lock_assert_phase3_return_item_update_policy=O',
    'returns.trigger_x_lock_phase3_return_status_products=O',
  ].join(';'),`the baseline's Phase 3 / Section 9 trigger set is not the expected fully-enabled set (O=enabled, D=disabled, R/A=replica-only): ${triggerState}`);
  console.log('PHASE3_TRIGGER_ENABLED_STATE_PASS');
  // Stage A's own terminal block checks product_families grants and that no
  // policy targets anon, but it never asserts that RLS is still ENABLED. Every
  // later check in this proof runs as `postgres`, which bypasses RLS, so a dump
  // with `relrowsecurity` off would sail through undetected. The catalog is the
  // only instrument that can see this: a permissive SELECT policy that admits
  // the reader reads identically whether RLS is enabled or disabled.
  sql(`DO $rls$
DECLARE v_pol record; v_count integer; v_qual text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='product_families' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PHASE3_PRODUCT_FAMILIES_RLS_DISABLED';
  END IF;
  SELECT count(*) INTO v_count FROM pg_policies WHERE schemaname='public' AND tablename='product_families';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'PHASE3_PRODUCT_FAMILIES_POLICY_COUNT_UNEXPECTED: %', v_count;
  END IF;
  SELECT * INTO v_pol FROM pg_policies WHERE schemaname='public' AND tablename='product_families';
  -- The predicate is asserted from the catalog, not inferred from a role-scoped
  -- read. Stage A restores an empty product_families, so a predicate narrowed to
  -- admit nothing returns the same count(*) = 0 as an unconditional one, and no
  -- read-based probe can tell them apart. The catalog text is the only witness.
  --
  -- Stage A created this policy as USING (true); 20260727174657 then tightened
  -- it to require an active profile, which is the state both the baseline and
  -- production now carry. Assert the WHOLE predicate, not the presence of a
  -- substring: searching for 'is_active_profile' is fail-open, because
  -- true OR is_active_profile() contains it and admits everyone. Only three
  -- rendering artifacts are normalized away -- identifier quoting, schema
  -- qualification, and PostgreSQL's own whitespace -- none of which can change
  -- what the predicate admits.
  v_qual := replace(btrim(regexp_replace(replace(replace(v_pol.qual,'"',''),'public.',''),'\\s+',' ','g')),'( ','(');
  IF v_pol.policyname <> 'product_families_select'
     OR v_pol.cmd <> 'SELECT'
     OR v_pol.permissive <> 'PERMISSIVE'
     OR v_pol.roles <> ARRAY['authenticated']::name[]
     OR v_qual IS DISTINCT FROM '(SELECT is_active_profile() AS is_active_profile)'
     OR v_pol.with_check IS NOT NULL THEN
    RAISE EXCEPTION 'PHASE3_PRODUCT_FAMILIES_POLICY_IDENTITY_DRIFTED: % / % / % / % / qual=% / normalized=% / with_check=%',
      v_pol.policyname, v_pol.cmd, v_pol.permissive, v_pol.roles, v_pol.qual, v_qual, v_pol.with_check;
  END IF;
END;
$rls$;`);
  // ...and confirm the GRANT layer agrees: reachable by the intended
  // application role, refused for anon, exercised as those roles rather than as
  // the RLS-bypassing superuser every other statement here runs as. This pair
  // proves grant reachability only -- the policy predicate itself is asserted
  // from the catalog above, because the restored table is empty.
  sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT count(*) FROM public.product_families; ROLLBACK;`);
  assertExactFailure(sql(`BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM public.product_families; ROLLBACK;`,{fail:true}),'permission denied for table product_families','anon read of product_families');
  console.log('PHASE3_PRODUCT_FAMILIES_RLS_IN_FORCE_PASS');
  sql(`INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-00000000a001'),('00000000-0000-0000-0000-00000000a002') ON CONFLICT DO NOTHING; INSERT INTO public.profiles(id,email,role,is_active) VALUES ('00000000-0000-0000-0000-00000000a001','phase3-admin@example.invalid','admin',true),('00000000-0000-0000-0000-00000000a002','phase3-sales@example.invalid','sales_rep',true) ON CONFLICT (id) DO UPDATE SET role=excluded.role,is_active=true;`);
  // Behavioral counterpart to the catalog assertion above: prove the predicate
  // actually gates, by reading one real row as an active profile and then as a
  // deactivated one. The catalog check alone cannot show that -- it reads text --
  // and the empty restored table made every earlier read-based probe blind. This
  // runs the genuine article: the image's own auth.uid(), the dump's own
  // is_active_profile(), and the restored policy, with nothing stubbed.
  // Everything this block adds -- the a003 deactivated profile, one b-series
  // profile per declared role, and one product_families row, none of which
  // anything else here provides -- is rolled back, so the rest continues on
  // exactly the schema it did before. It reuses the already-seeded a002 rather than seeding
  // its own active profile, and a001/a002 deliberately stay outside this
  // transaction: the actor-binding fixtures below depend on both surviving it.
  // Do not move that seed in here.
  //
  // The active and deactivated controls are both sales_rep, which makes them a
  // clean one-variable test of is_active -- and blind to the drift this gate is
  // most likely to suffer. is_active_profile() is documented as the
  // "role-agnostic active-account gate", but its own migration says it was
  // "modelled exactly on the existing is_admin() / is_sales_rep() / is_driver()
  // / is_applicator() helpers", all of which DO test role. If a future edit
  // copies one of those bodies too faithfully and the predicate starts
  // requiring a role, both controls above still behave exactly as asserted
  // (active sales_rep reads, inactive sales_rep does not) while the roles that
  // were dropped silently lose read access to product_families. The catalog
  // assertion cannot see it either: the policy text still reads
  // is_active_profile(); the drift is inside the function body.
  //
  // So probe EVERY role, and take the role list from the database rather than a
  // literal here: profiles_role_check is the definition of "every role", so a
  // migration that adds a sixth role automatically gets a control, and one that
  // is not admitted by the gate fails this proof instead of shipping. Spot-
  // checking one extra role would leave the same hole one level down -- a
  // predicate narrowed to "sales_rep or driver" passes a two-role probe.
  const roleCheck=scalar(`SELECT coalesce(pg_get_constraintdef(c.oid),'<missing>') FROM pg_constraint c WHERE c.conname='profiles_role_check' AND c.conrelid='public.profiles'::regclass;`);
  // Take EVERY quoted literal, then insist each one is a plain identifier. A
  // narrower pattern would silently skip a role it did not match, which is the
  // one failure mode this probe cannot afford: a skipped role is an unproven
  // role that still reads as green.
  const declaredRoles=[...new Set([...roleCheck.matchAll(/'([^']*)'::text/g)].map(m=>m[1]))].sort();
  if(!declaredRoles.length) throw new Error(`could not enumerate profiles roles from profiles_role_check, so the role-agnostic gate cannot be proven: ${roleCheck}`);
  const oddRoles=declaredRoles.filter(r=>!/^[a-z0-9_]{1,40}$/.test(r));
  if(oddRoles.length) throw new Error(`profiles_role_check declares role(s) this probe cannot safely template into a fixture, so they would go unproven: ${oddRoles.join(', ')} -- teach this proof to handle them rather than skipping them`);
  if(declaredRoles.length>99) throw new Error(`too many declared roles to allocate distinct probe uuids: ${declaredRoles.length}`);
  const roleProbes=declaredRoles.map((role,i)=>({role,id:`00000000-0000-0000-0000-000000000b${String(i+1).padStart(2,'0')}`}));
  const rlsBehavior=sql(`BEGIN;
INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-00000000a003'),${roleProbes.map(p=>`('${p.id}')`).join(',')} ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(id,email,role,is_active) VALUES ('00000000-0000-0000-0000-00000000a003','phase3-deactivated@example.invalid','sales_rep',false),${roleProbes.map(p=>`('${p.id}','phase3-${p.role}@example.invalid','${p.role}',true)`).join(',')} ON CONFLICT (id) DO UPDATE SET role=excluded.role,is_active=excluded.is_active;
INSERT INTO public.product_families(name) VALUES ('[PROOF] Phase3 RLS gate');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000a002';
SET LOCAL ROLE authenticated;
SELECT 'PHASE3_RLS_ACTIVE_ROWS=' || count(*)::text FROM public.product_families;
RESET ROLE;
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-0000-0000-00000000a003';
SET LOCAL ROLE authenticated;
SELECT 'PHASE3_RLS_DEACTIVATED_ROWS=' || count(*)::text FROM public.product_families;
RESET ROLE;
${roleProbes.map(p=>`SET LOCAL "request.jwt.claim.sub" = '${p.id}';
SET LOCAL ROLE authenticated;
SELECT 'PHASE3_RLS_ROLE_${p.role}_ROWS=' || count(*)::text FROM public.product_families;
RESET ROLE;`).join('\n')}
ROLLBACK;`).stdout;
  assert.match(rlsBehavior,/PHASE3_RLS_ACTIVE_ROWS=1$/m,`active profile could not read the seeded product_families row: ${rlsBehavior}`);
  assert.match(rlsBehavior,/PHASE3_RLS_DEACTIVATED_ROWS=0$/m,`deactivated profile could still read product_families -- the policy predicate does not gate: ${rlsBehavior}`);
  for(const p of roleProbes) assert.match(rlsBehavior,new RegExp(`PHASE3_RLS_ROLE_${p.role}_ROWS=1$`,'m'),`an active ${p.role} could not read product_families -- the gate is no longer role-agnostic, so ${p.role} staff have silently lost access: ${rlsBehavior}`);
  console.log(`PHASE3_RLS_ROLE_AGNOSTIC_GATE_PASS roles=${declaredRoles.join(',')}`);
  assert.equal(scalar(`SELECT count(*)::text FROM public.product_families;`),'0','the rolled-back RLS behavior fixture leaked a product_families row');
  console.log('PHASE3_PRODUCT_FAMILIES_ACTIVE_PROFILE_GATE_PASS');
  const smoke=sql('\\i /tmp/smoke.sql',{fail:true}); const smokeOut=`${smoke.stdout}\n${smoke.stderr}`; assert.match(smokeOut,/SMOKE_PASS_ROLLBACK/,'rollback matrix did not reach its terminal marker'); assert.match(smokeOut,/PHASE3_UNRELATED_CREDIT_MEMO_UNAPPLY_PASS/,'unrelated credit-memo unapply regression did not pass'); console.log('PHASE3_UNRELATED_CREDIT_MEMO_UNAPPLY_PASS');
  const source=readFileSync(files.stageA,'utf8'); for(const x of ['lock_phase3_product_policy_products','RETURN_POLICY_NO_RETURN','trigger_x_validate_phase3_return_item_policy'])assert.match(source,new RegExp(x));
  sql(`INSERT INTO public.products(product_name) VALUES ('[PROOF] Phase3 lock A'),('[PROOF] Phase3 lock B');`);
  const ids=sql(`SELECT id FROM public.products ORDER BY id LIMIT 2;`).stdout.trim().split(/\r?\n/).filter(Boolean); if(ids.length<2)throw new Error('schema dump has fewer than two Products for real lock proof'); const [a,b]=ids;
  // Two independent psql sessions call the actual Stage A helper, opposite UUID
  // order. Both must finish: no replacement tables/functions are installed.
  const first=session(`BEGIN; SELECT public.lock_phase3_product_policy_products(ARRAY['${a}'::uuid,'${b}'::uuid]); SELECT 'FIRST_LOCKED'; SELECT pg_sleep(2); COMMIT;`,'FIRST_LOCKED'); await first.ready;
  const second=session(`BEGIN; SET lock_timeout='10s'; SELECT public.lock_phase3_product_policy_products(ARRAY['${b}'::uuid,'${a}'::uuid]); SELECT 'SECOND_LOCKED'; COMMIT;`,'SECOND_LOCKED'); const [r1,r2]=await Promise.all([first.done,second.done]); assert.equal(r1.code,0,r1.err); assert.equal(r2.code,0,r2.err);

  // The remainder deliberately uses the public wrappers and the actual
  // governed metadata function.  It is not a focused-function substitute:
  // every fixture is real Product -> order -> return lifecycle data in the
  // restored schema, and every race uses two independent psql connections.
  const admin='00000000-0000-0000-0000-00000000a001';
  const sales='00000000-0000-0000-0000-00000000a002';
  let fixtureNo=0;
  function metadataSql(f,key){return `SELECT public.set_product_phase3_metadata('${f.productId}'::uuid,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'${key}');`}
  function wrapperSql(f,operation,key){
    if(operation==='create_return') return `SELECT public.create_return('{\"customer_id\":\"${f.customerId}\",\"order_id\":\"${f.orderId}\",\"reason\":\"overstock\"}'::jsonb,'[{\"order_item_id\":\"${f.orderItemId}\",\"quantity\":2,\"condition\":\"unopened\",\"restock\":true}]'::jsonb,'${key}');`;
    if(operation==='approve_return') return `SELECT public.approve_return('${f.returnId}'::uuid,'${sales}'::uuid,'${key}');`;
    if(operation==='receive_return') return `SELECT public.receive_return('${f.returnId}'::uuid,'${sales}'::uuid,'${key}');`;
    if(operation==='issue_return_credit') return `SELECT public.issue_return_credit('${f.returnId}'::uuid,'${admin}'::uuid,'${key}');`;
    throw new Error(`unsupported wrapper ${operation}`);
  }
  function makeFixture(label,state='requested',sharedProductId=null){
    const n=++fixtureNo, tag=`[PROOF P3 ${process.pid}-${n}] ${label}`;
    const productId=sharedProductId||scalar(`INSERT INTO public.products(product_name) VALUES ('${tag} Product') RETURNING id;`);
    const customerId=scalar(`INSERT INTO public.customers(farm_name) VALUES ('${tag} Customer') RETURNING id;`);
    const orderId=scalar(`INSERT INTO public.orders(order_number,customer_id,salesman_id,status) VALUES ('P3-${process.pid}-${n}','${customerId}'::uuid,'${sales}'::uuid,'confirmed') RETURNING id;`);
    const orderItemId=scalar(`INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining) VALUES ('${orderId}'::uuid,'${productId}'::uuid,'${tag} Product',10,4,'ea',40,4,0) RETURNING id;`);
    if(!sharedProductId) scalar(`INSERT INTO public.inventory(product_id,location,quantity_available,unit_size) VALUES ('${productId}'::uuid,'Main Warehouse',7,'ea') RETURNING id;`);
    const f={label,n,productId,customerId,orderId,orderItemId,returnId:null};
    if(state==='none') return f;
    const result=json(`${claims(sales)} ${wrapperSql(f,'create_return',`fixture-${n}-create`)}`);
    f.returnId=result.return_id;
    if(!f.returnId) throw new Error(`fixture ${label} did not create a return`);
    if(state==='approved'||state==='received') json(`${claims(sales)} ${wrapperSql(f,'approve_return',`fixture-${n}-approve`)}`);
    if(state==='received') json(`${claims(sales)} ${wrapperSql(f,'receive_return',`fixture-${n}-receive`)}`);
    return f;
  }
  function snapshot(f,key){const match=f.returnId?`r.id='${f.returnId}'::uuid`:`r.order_id='${f.orderId}'::uuid`; return json(`SELECT jsonb_build_object(
    'status',(SELECT r.status FROM public.returns r WHERE ${match}),
    'returns',(SELECT count(*) FROM public.returns r WHERE ${match}),
    'items',(SELECT count(*) FROM public.return_items ri JOIN public.returns r ON r.id=ri.return_id WHERE ${match}),
    'inventory',(SELECT quantity_available FROM public.inventory WHERE product_id='${f.productId}'::uuid AND location='Main Warehouse'),
    'transactions',(SELECT count(*) FROM public.inventory_transactions WHERE product_id='${f.productId}'::uuid),
    'invoices',(SELECT count(*) FROM public.invoices i JOIN public.returns r ON r.credit_invoice_id=i.id WHERE ${match}),
    'audit',(SELECT count(*) FROM public.financial_audit_log fa WHERE ${f.returnId?`fa.entity_id='${f.returnId}'::uuid OR fa.new_values->>'return_id'='${f.returnId}'`:'false'}),
    'activity',(SELECT count(*) FROM public.activity_feed WHERE related_entity_type='return' AND customer_id='${f.customerId}'::uuid),
    'idempotency',(SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='${key}')
  );`)}
  function policy(f){return scalar(`SELECT return_policy FROM public.products WHERE id='${f.productId}'::uuid;`)}
  function directItemSql(returnId,productId,label){return `INSERT INTO public.return_items(return_id,product_id,product_name,quantity,unit,unit_price_cents,extended_cents,condition,restock,sort_order) VALUES ('${returnId}'::uuid,'${productId}'::uuid,'[PROOF P3] ${label}',1,'ea',1,1,'unopened',false,99);`;}
  function unapplySql(invoiceId,key){return `SELECT public.unapply_credit_memo('${invoiceId}'::uuid,'Phase 3 concurrency reversal','${admin}'::uuid,'${key}');`;}
  function createTarget(label){return scalar(`INSERT INTO public.products(product_name) VALUES ('[PROOF P3] ${label} target') RETURNING id;`);}
  function autocommitDeferredFkTiming(){
    const f=makeFixture('autocommit deferred FK timing','requested'), target=createTarget(`autocommit ${f.n}`);
    // sql() launches psql without BEGIN, so this is an implicit/autocommit
    // statement. The BEFORE trigger defers then the AFTER trigger restores the
    // FK to immediate before the statement returns.
    sql(directItemSql(f.returnId,target,'autocommit timing'));
    assert.equal(scalar(`SELECT count(*) FROM public.return_items WHERE return_id='${f.returnId}'::uuid AND product_id='${target}'::uuid;`),'1');
    sql(`DELETE FROM public.return_items WHERE return_id='${f.returnId}'::uuid AND product_id='${target}'::uuid;`);
    assert.equal(scalar(`SELECT condeferrable::text || ':' || condeferred::text FROM pg_constraint WHERE conrelid='public.return_items'::regclass AND conname='return_items_product_id_fkey';`),'true:false');
    console.log('PHASE3_AUTOCOMMIT_DEFERRED_FK_TIMING_PASS');
  }
  async function directItemMetadataRace(metadataFirst){
    const f=makeFixture(`direct-item ${metadataFirst?'metadata':'direct'} first`,'requested');
    const target=createTarget(`direct-item ${f.n}`), directKey=`direct-item-${f.n}`, metaKey=`direct-meta-${f.n}`;
    const marker=`P3_DIRECT_ITEM_${metadataFirst?'META':'ITEM'}_LOCKED_${f.n}`;
    if(metadataFirst){
      const meta=session(`BEGIN; ${claims(admin)} SELECT public.set_product_phase3_metadata('${target}'::uuid,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'${metaKey}'); SELECT '${marker}'; SELECT pg_sleep(2); COMMIT;`,marker);
      await meta.ready;
      const direct=session(`BEGIN; SET lock_timeout='10s'; SELECT 'P3_DIRECT_ITEM_CALLING_${f.n}'; ${directItemSql(f.returnId,target,'metadata-first')} COMMIT;`,`P3_DIRECT_ITEM_CALLING_${f.n}`);
      await direct.ready; await assertWaiting(direct.done,'metadata-first direct return_item insert');
      const [metaResult,directResult]=await Promise.all([meta.done,direct.done]);
      assert.equal(metaResult.code,0,metaResult.err); assertExactFailure(directResult,'RETURN_POLICY_NO_RETURN','metadata-first direct return_item insert');
      assert.equal(scalar(`SELECT count(*) FROM public.return_items WHERE return_id='${f.returnId}'::uuid AND product_id='${target}'::uuid;`),'0');
      assert.equal(scalar(`SELECT return_policy FROM public.products WHERE id='${target}'::uuid;`),'no_return');
      console.log('PHASE3_RACE_METADATA_FIRST_DIRECT_RETURN_ITEM_NO_RETURN_PASS');
      return;
    }
    const direct=session(`BEGIN; SET lock_timeout='10s'; ${directItemSql(f.returnId,target,'direct-first')} SELECT '${marker}'; SELECT pg_sleep(2); COMMIT;`,marker);
    await direct.ready;
    const meta=session(`BEGIN; SET lock_timeout='10s'; ${claims(admin)} SELECT 'P3_DIRECT_ITEM_METADATA_CALLING_${f.n}'; SELECT public.set_product_phase3_metadata('${target}'::uuid,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'${metaKey}'); COMMIT;`,`P3_DIRECT_ITEM_METADATA_CALLING_${f.n}`);
    await meta.ready; await assertWaiting(meta.done,'direct-first metadata');
    const [directResult,metaResult]=await Promise.all([direct.done,meta.done]);
    assert.equal(directResult.code,0,directResult.err); assertExactFailure(metaResult,'RETURN_POLICY_ACTIVE_RETURN','direct-first metadata');
    assert.equal(scalar(`SELECT count(*) FROM public.return_items WHERE return_id='${f.returnId}'::uuid AND product_id='${target}'::uuid;`),'1');
    assert.equal(scalar(`SELECT return_policy FROM public.products WHERE id='${target}'::uuid;`),'unknown');
    console.log('PHASE3_RACE_DIRECT_RETURN_ITEM_FIRST_METADATA_ACTIVE_REFUSAL_PASS');
  }
  async function unapplyMetadataRace(metadataFirst){
    const f=makeFixture(`unapply ${metadataFirst?'metadata':'unapply'} first`,'received');
    const creditKey=`unapply-race-${f.n}-credit`, credit=json(`${claims(admin)} ${wrapperSql(f,'issue_return_credit',creditKey)}`), invoiceId=credit.credit_invoice_id;
    assert.ok(invoiceId,'unapply race did not issue credit');
    const unapplyKey=`unapply-race-${f.n}-unapply`, metaKey=`unapply-race-${f.n}-metadata`, marker=`P3_UNAPPLY_${metadataFirst?'META':'UNAPPLY'}_LOCKED_${f.n}`;
    if(metadataFirst){
      const meta=session(`BEGIN; ${claims(admin)} ${metadataSql(f,metaKey)} SELECT '${marker}'; SELECT pg_sleep(2); COMMIT;`,marker);
      await meta.ready;
      const unapply=session(`BEGIN; SET lock_timeout='10s'; ${claims(admin)} SELECT 'P3_UNAPPLY_CALLING_${f.n}'; ${unapplySql(invoiceId,unapplyKey)} COMMIT;`,`P3_UNAPPLY_CALLING_${f.n}`);
      await unapply.ready; await assertWaiting(unapply.done,'metadata-first unapply');
      const [metaResult,unapplyResult]=await Promise.all([meta.done,unapply.done]);
      assert.equal(metaResult.code,0,metaResult.err); assert.equal(unapplyResult.code,0,unapplyResult.err);
      assert.equal(snapshot(f,creditKey).status,'received'); assert.equal(policy(f),'no_return');
      assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='${unapplyKey}';`),'1');
      console.log('PHASE3_RACE_METADATA_FIRST_UNAPPLY_NO_RETURN_REVERSAL_PASS');
      return;
    }
    const unapply=session(`BEGIN; SET lock_timeout='10s'; ${claims(admin)} ${unapplySql(invoiceId,unapplyKey)} SELECT '${marker}'; SELECT pg_sleep(2); COMMIT;`,marker);
    await unapply.ready;
    const meta=session(`BEGIN; SET lock_timeout='10s'; ${claims(admin)} SELECT 'P3_UNAPPLY_METADATA_CALLING_${f.n}'; ${metadataSql(f,metaKey)} COMMIT;`,`P3_UNAPPLY_METADATA_CALLING_${f.n}`);
    await meta.ready; await assertWaiting(meta.done,'unapply-first metadata');
    const [unapplyResult,metaResult]=await Promise.all([unapply.done,meta.done]);
    assert.equal(unapplyResult.code,0,unapplyResult.err); assertExactFailure(metaResult,'RETURN_POLICY_ACTIVE_RETURN','unapply-first metadata');
    assert.equal(snapshot(f,creditKey).status,'received'); assert.equal(policy(f),'unknown');
    assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='${unapplyKey}';`),'1');
    console.log('PHASE3_RACE_UNAPPLY_FIRST_METADATA_ACTIVE_REFUSAL_PASS');
  }
  function forceNoReturnForDisposableFixture(f){
    sql(`ALTER TABLE public.products DISABLE TRIGGER trigger_x_require_governed_phase3_product_metadata; UPDATE public.products SET return_policy='no_return' WHERE id='${f.productId}'::uuid; ALTER TABLE public.products ENABLE TRIGGER trigger_x_require_governed_phase3_product_metadata;`);
    assert.equal(scalar(`SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.products'::regclass AND tgname='trigger_x_require_governed_phase3_product_metadata';`),'O','hostile-fixture metadata trigger was not re-enabled');
  }
  function hostileNoReturnApproveReceive(){
    const approveFixture=makeFixture('hostile no_return approve','requested'); forceNoReturnForDisposableFixture(approveFixture);
    const approve=sql(`${claims(sales)} ${wrapperSql(approveFixture,'approve_return',`hostile-${approveFixture.n}-approve`)}`,{fail:true}); assertExactFailure(approve,'RETURN_POLICY_NO_RETURN','hostile no_return approve'); assert.equal(snapshot(approveFixture,`hostile-${approveFixture.n}-approve`).status,'requested');
    const receiveFixture=makeFixture('hostile no_return receive','approved'); forceNoReturnForDisposableFixture(receiveFixture);
    const before=snapshot(receiveFixture,`hostile-${receiveFixture.n}-receive`); const receive=sql(`${claims(sales)} ${wrapperSql(receiveFixture,'receive_return',`hostile-${receiveFixture.n}-receive`)}`,{fail:true}); assertExactFailure(receive,'RETURN_POLICY_NO_RETURN','hostile no_return receive'); assert.deepEqual(snapshot(receiveFixture,`hostile-${receiveFixture.n}-receive`),before,'hostile no_return receive leaked effects');
    console.log('PHASE3_HOSTILE_NO_RETURN_APPROVE_RECEIVE_REFUSAL_PASS');
  }
  async function metadataFirstSuccessCreate(){
    const f=makeFixture('metadata-first create','none');
    const key=`race-${f.n}-create`, before=snapshot(f,key), marker=`P3_META_LOCKED_CREATE_${f.n}`, call=`P3_WRAPPER_CALLING_CREATE_${f.n}`;
    const meta=session(`BEGIN; ${claims(admin)} ${metadataSql(f,`meta-${f.n}`)} SELECT '${marker}'; SELECT pg_sleep(2); COMMIT;`,marker);
    await meta.ready;
    const wrapper=session(`BEGIN; SET lock_timeout='10s'; ${claims(sales)} SELECT '${call}'; ${wrapperSql(f,'create_return',key)} COMMIT;`,call);
    await wrapper.ready; await assertWaiting(wrapper.done,'metadata-first create wrapper');
    const metaResult=await meta.done, wrapperResult=await wrapper.done;
    assert.equal(metaResult.code,0,metaResult.err); assertExactFailure(wrapperResult,'RETURN_POLICY_NO_RETURN','metadata-first create');
    assert.deepEqual(snapshot(f,key),before,'metadata-first create left partial effects'); assert.equal(policy(f),'no_return');
    console.log('PHASE3_RACE_METADATA_FIRST_CREATE_NO_RETURN_PASS');
  }
  async function metadataFirstActiveRefusal(operation,state){
    const f=makeFixture(`metadata-first ${operation}`,state), key=`race-${f.n}-${operation}`, before=snapshot(f,key), marker=`P3_META_LOCKED_${operation}_${f.n}`, call=`P3_WRAPPER_CALLING_${operation}_${f.n}`;
    const meta=session(`BEGIN; ${claims(admin)} SELECT public.lock_phase3_product_policy_products(ARRAY['${f.productId}'::uuid]); SELECT '${marker}'; SELECT pg_sleep(2); ${metadataSql(f,`meta-${f.n}`)} COMMIT;`,marker);
    await meta.ready;
    const wrapper=session(`BEGIN; SET lock_timeout='10s'; ${claims(operation==='issue_return_credit'?admin:sales)} SELECT '${call}'; ${wrapperSql(f,operation,key)} COMMIT;`,call);
    await wrapper.ready; await assertWaiting(wrapper.done,`metadata-first ${operation} wrapper`);
    const metaResult=await meta.done, wrapperResult=await wrapper.done;
    assertExactFailure(metaResult,'RETURN_POLICY_ACTIVE_RETURN',`metadata-first ${operation} metadata`); assert.equal(wrapperResult.code,0,wrapperResult.err);
    const after=snapshot(f,key); assert.equal(after.idempotency,before.idempotency+1,`metadata refusal corrupted ${operation} idempotency`);
    const expected=operation==='approve_return'?'approved':operation==='receive_return'?'received':'credited'; assert.equal(after.status,expected,`metadata-first ${operation} did not complete its wrapper`);
    if(operation==='receive_return'){assert.equal(after.inventory,before.inventory+2,'receive did not restock exactly two units');assert.equal(after.transactions,before.transactions+1,'receive did not write exactly one inventory transaction')}
    if(operation==='issue_return_credit'){assert.equal(after.invoices,before.invoices+1,'credit did not create exactly one invoice');assert.equal(after.audit,before.audit+2,'credit did not write exact financial audit rows')}
    assert.equal(policy(f),'unknown'); console.log(`PHASE3_RACE_METADATA_FIRST_${operation.toUpperCase()}_ACTIVE_REFUSAL_PASS`);
  }
  async function wrapperFirst(operation,state){
    const f=makeFixture(`wrapper-first ${operation}`,state), key=`race-${f.n}-${operation}`, marker=`P3_WRAPPER_LOCKED_${operation}_${f.n}`, call=`P3_METADATA_CALLING_${operation}_${f.n}`;
    const holder=session(`BEGIN; SET lock_timeout='10s'; ${claims(operation==='issue_return_credit'?admin:sales)} ${wrapperSql(f,operation,key)} SELECT '${marker}'; SELECT pg_sleep(2); COMMIT;`,marker);
    await holder.ready;
    const meta=session(`BEGIN; SET lock_timeout='10s'; ${claims(admin)} SELECT '${call}'; ${metadataSql(f,`meta-${f.n}`)} COMMIT;`,call);
    await meta.ready; await assertWaiting(meta.done,`wrapper-first ${operation} metadata`);
    const holderResult=await holder.done, metaResult=await meta.done;
    assert.equal(holderResult.code,0,holderResult.err);
    if(operation==='issue_return_credit'){
      assert.equal(metaResult.code,0,metaResult.err); assert.equal(policy(f),'no_return'); assert.equal(snapshot(f,key).status,'credited');
    } else {
      assertExactFailure(metaResult,'RETURN_POLICY_ACTIVE_RETURN',`wrapper-first ${operation} metadata`);
      const expected=operation==='create_return'?'requested':operation==='approve_return'?'approved':'received'; assert.equal(snapshot(f,key).status,expected); assert.equal(policy(f),'unknown');
    }
    console.log(`PHASE3_RACE_WRAPPER_FIRST_${operation.toUpperCase()}_PASS`); return f;
  }
  function proveCreditedReversalBoundary(){
    const f=makeFixture('credited reversal boundary','received'), creditKey=`reversal-${f.n}-credit`;
    const credit=json(`${claims(admin)} ${wrapperSql(f,'issue_return_credit',creditKey)}`); const invoiceId=credit.credit_invoice_id;
    assert.ok(invoiceId,'credit fixture did not return a real credit invoice id'); assert.equal(snapshot(f,creditKey).status,'credited');
    json(`${claims(admin)} ${metadataSql(f,`reversal-${f.n}-metadata`)}`); assert.equal(policy(f),'no_return','credited product should allow governed no_return');
    json(`${claims(admin)} SELECT public.unapply_credit_memo('${invoiceId}'::uuid,'Phase 3 proof reversal','${admin}'::uuid,'reversal-${f.n}-unapply');`);
    assert.equal(snapshot(f,creditKey).status,'received','unapply did not restore received status');
    const before=snapshot(f,`reversal-${f.n}-recredit`); const failed=sql(`${claims(admin)} ${wrapperSql(f,'issue_return_credit',`reversal-${f.n}-recredit`)}`,{fail:true}); assertExactFailure(failed,'RETURN_POLICY_NO_RETURN','re-credit after governed no_return'); assert.deepEqual(snapshot(f,`reversal-${f.n}-recredit`),before,'blocked re-credit left money or audit effects');
    console.log('PHASE3_CREDITED_REVERSAL_BOUNDARY_PASS');
  }
  function metadataIdempotencyBinding(){
    const first=makeFixture('metadata idempotency binding','none');
    const second=makeFixture('metadata idempotency other product','none');
    const key=`metadata-idempotency-${first.n}`;
    const call=(productId,expectedPolicy,targetPolicy)=>`SELECT public.set_product_phase3_metadata('${productId}'::uuid,NULL,'${expectedPolicy}',NULL,false,NULL,'${targetPolicy}',NULL,false,'${key}');`;
    const initial=json(`${claims(admin)} ${call(first.productId,'unknown','no_return')}`);
    const replay=json(`${claims(admin)} ${call(first.productId,'unknown','no_return')}`);
    assert.deepEqual(replay,initial,'identical metadata retry must replay its original response');
    const changedTarget=sql(`${claims(admin)} ${call(first.productId,'no_return','returnable')}`,{fail:true});
    assertExactFailure(changedTarget,'IDEMPOTENCY_PAYLOAD_MISMATCH','metadata idempotency changed target');
    const changedProduct=sql(`${claims(admin)} ${call(second.productId,'unknown','no_return')}`,{fail:true});
    assertExactFailure(changedProduct,'IDEMPOTENCY_PAYLOAD_MISMATCH','metadata idempotency changed product');
    assert.equal(policy(first),'no_return','changed-target replay mutated the original Product');
    assert.equal(policy(second),'unknown','changed-product replay mutated a second Product');
    assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key='${key}';`),'1');
    console.log('PHASE3_METADATA_IDEMPOTENCY_BINDING_PASS');
  }
  function metadataAuthorizationScope(){
    const f=makeFixture('metadata authorization scope','none'), key=`metadata-scope-${f.n}`;
    const call=`SELECT public.set_product_phase3_metadata('${f.productId}'::uuid,NULL,'unknown',NULL,false,NULL,'no_return',NULL,false,'${key}');`;
    const scoped=sql(`BEGIN; ${claims(admin)} ${call} DO $scope$ BEGIN
      UPDATE public.products SET return_policy='returnable' WHERE id='${f.productId}'::uuid;
      RAISE EXCEPTION 'PHASE3_AUTH_SCOPE_LEAK';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'PHASE3_AUTH_SCOPE_LEAK%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'PRODUCT_PHASE3_METADATA_GOVERNED%' THEN
        RAISE EXCEPTION 'PHASE3_AUTH_SCOPE_UNEXPECTED_FAILURE: %', SQLERRM;
      END IF;
    END $scope$; COMMIT;`,{fail:true});
    assert.equal(scoped.status,0,`metadata authorization scope transaction failed: ${scoped.stderr||scoped.stdout}`);
    assert.equal(policy(f),'no_return','governed metadata update did not persist before direct-write refusal');
    console.log('PHASE3_METADATA_AUTHORIZATION_SCOPE_PASS');
  }
  async function cancelReceiveSharedProductRace(){
    // These wrappers exert opposite pressure on the same inventory row:
    // received cancellation decrements it while approved receive increments it.
    // They run in independent sessions and both must finish, so this catches a
    // Product-before-inventory ordering regression as a real deadlock/timeout.
    const cancelFixture=makeFixture('cancel receive shared product cancel','received');
    const receiveFixture=makeFixture('cancel receive shared product receive','approved',cancelFixture.productId);
    const before=snapshot(cancelFixture,`cancel-receive-${cancelFixture.n}-before`);
    const beforeTransactions=Number(before.transactions);
    const invId=scalar(`SELECT id FROM public.inventory WHERE product_id='${cancelFixture.productId}'::uuid AND location='Main Warehouse';`);
    const holderMarker=`P3_SHARED_INVENTORY_HELD_${cancelFixture.n}`, cancelMarker=`P3_CANCEL_SHARED_PRODUCT_CALLING_${cancelFixture.n}`, receiveMarker=`P3_RECEIVE_SHARED_PRODUCT_GOT_ADVISORY_${receiveFixture.n}`;
    const cancelKey=`cancel-receive-${cancelFixture.n}-cancel`, receiveKey=`cancel-receive-${receiveFixture.n}-receive`;
    const holder=session(`BEGIN; SELECT id FROM public.inventory WHERE id='${invId}'::uuid FOR UPDATE; SELECT '${holderMarker}'; SELECT pg_sleep(3); COMMIT;`,holderMarker);
    await holder.ready;
    const cancelling=session(`BEGIN; SET lock_timeout='10s'; ${claims(sales)} SELECT '${cancelMarker}'; SELECT public.cancel_return('${cancelFixture.returnId}'::uuid,'Phase 3 shared-product race','${sales}'::uuid,'${cancelKey}'); COMMIT;`,cancelMarker);
    await cancelling.ready;
    // Give cancel_return time to acquire its Product advisory lock and block on
    // the held inventory row. The receive session must then wait at the helper.
    await pause(500);
    const receiving=session(`BEGIN; SET lock_timeout='10s'; ${claims(sales)} SELECT public.lock_phase3_product_policy_products(ARRAY['${cancelFixture.productId}'::uuid]); SELECT '${receiveMarker}'; ${wrapperSql(receiveFixture,'receive_return',receiveKey)} COMMIT;`,receiveMarker);
    await assertMarkerBlocked(receiving.ready,'shared-product receive advisory lock while cancellation waits on inventory');
    const [held,cancelled,received]=await Promise.all([holder.done,cancelling.done,receiving.done]);
    assert.equal(held.code,0,held.err);
    assert.equal(cancelled.code,0,cancelled.err); assert.equal(received.code,0,received.err);
    assert.equal(snapshot(cancelFixture,cancelKey).status,'cancelled');
    assert.equal(snapshot(receiveFixture,receiveKey).status,'received');
    const afterInventory=Number(scalar(`SELECT quantity_available FROM public.inventory WHERE product_id='${cancelFixture.productId}'::uuid AND location='Main Warehouse';`));
    assert.equal(afterInventory,Number(before.inventory),'shared Product inventory net effect must be zero');
    assert.equal(Number(scalar(`SELECT count(*) FROM public.inventory_transactions WHERE product_id='${cancelFixture.productId}'::uuid;`)),beforeTransactions+2,'shared Product race must write exact cancel+receive transactions');
    assert.equal(scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key IN ('${cancelKey}','${receiveKey}');`),'2');
    console.log('PHASE3_RACE_CANCEL_RECEIVE_SHARED_PRODUCT_NO_DEADLOCK_PASS');
  }
  // Positive control first: this fixture must restock Main Warehouse through
  // the real receive wrapper before the race cases assert its no-effect path.
  const receiveControl=makeFixture('receive positive control','approved'), receiveBefore=snapshot(receiveControl,`control-${receiveControl.n}`);
  json(`${claims(sales)} ${wrapperSql(receiveControl,'receive_return',`control-${receiveControl.n}`)}`); const receiveAfter=snapshot(receiveControl,`control-${receiveControl.n}`);
  assert.equal(receiveAfter.inventory,receiveBefore.inventory+2,'receive control did not restock Main Warehouse exactly'); assert.equal(receiveAfter.transactions,receiveBefore.transactions+1,'receive control did not create exactly one transaction');
  console.log('PHASE3_RECEIVE_RESTOCK_EFFECTS_PASS');
  autocommitDeferredFkTiming();
  await metadataFirstSuccessCreate();
  await metadataFirstActiveRefusal('approve_return','requested');
  await metadataFirstActiveRefusal('receive_return','approved');
  await metadataFirstActiveRefusal('issue_return_credit','received');
  await wrapperFirst('create_return','requested');
  await wrapperFirst('approve_return','requested');
  await wrapperFirst('receive_return','approved');
  await wrapperFirst('issue_return_credit','received');
  await directItemMetadataRace(true);
  await directItemMetadataRace(false);
  await unapplyMetadataRace(true);
  await unapplyMetadataRace(false);
  hostileNoReturnApproveReceive();
  proveCreditedReversalBoundary();
  metadataIdempotencyBinding();
  metadataAuthorizationScope();
  await cancelReceiveSharedProductRace();
  console.log('PHASE3_REAL_SCHEMA_RESTORE_PASS'); console.log('PHASE3_ROLLBACK_MATRIX_PASS'); console.log('PHASE3_REAL_TWO_CONNECTION_LOCK_ORDER_PASS');
  console.log('PHASE3_REAL_WRAPPER_CONCURRENCY_PASS');
} finally { run(['rm','-f',NAME],{fail:true}); }
