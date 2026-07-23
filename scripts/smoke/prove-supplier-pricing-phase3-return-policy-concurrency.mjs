#!/usr/bin/env node
/**
 * Real-schema, network-isolated Phase 3 proof.  The required schema dump is
 * read-only input; this runner never reads a DB URL or connects to Supabase.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');
const dump=process.argv[2]==='--schema-dump'?process.argv[3]:process.env.CRXP3_SCHEMA_DUMP;
if(!dump||!existsSync(dump)) throw new Error('usage: node scripts/smoke/prove-supplier-pricing-phase3-return-policy-concurrency.mjs --schema-dump <read-only-public-schema.sql>');
const NAME=`crx-phase3-real-${process.pid}-${Date.now().toString(36)}`;
const image='public.ecr.aws/supabase/postgres:17.6.1.141';
const files={ extensions:path.join(ROOT,'supabase/baselines/20260719092832_extensions.sql'), dump:path.resolve(dump), section9:path.join(ROOT,'supabase/migrations/20260722222742_section9_po_ap_high_remediation.sql'), stageA:path.join(ROOT,'supabase/migrations/20260722222743_product_families_return_policy_foundation.sql'), smoke:path.join(ROOT,'scripts/smoke/smoke-supplier-pricing-phase3-return-policy.sql') };
for(const [k,v] of Object.entries(files)) if(!existsSync(v)) throw new Error(`missing ${k}: ${v}`);
function run(args,o={}){const r=spawnSync('docker',args,{cwd:ROOT,encoding:'utf8',input:o.input,maxBuffer:50*1024*1024});if(r.error||(!o.fail&&r.status!==0))throw new Error(`${r.error?.message||''}\n${r.stderr||r.stdout}`);return r}
function psqlArgs(){return ['exec','-i',NAME,'psql','-U','postgres','-d','postgres','-X','-q','-A','-t','-v','ON_ERROR_STOP=1']}
function sql(s,o={}){return run(psqlArgs(),{input:s,fail:o.fail})}
function adminSql(s,o={}){return run(['exec','-i',NAME,'psql','-U','supabase_admin','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1'],{input:s,fail:o.fail})}
function file(local,name){run(['cp',local,`${NAME}:/tmp/${name}`])}
function apply(name){return sql(`BEGIN;
\\i /tmp/${name}
COMMIT;`)}
function session(s,marker){const c=spawn('docker',psqlArgs(),{cwd:ROOT,stdio:['pipe','pipe','pipe']});let out='',err='',timer,settled=false;let resolve,reject;const ready=new Promise((r,j)=>{resolve=r;reject=j;timer=setTimeout(()=>{if(!settled){settled=true;j(new Error(`timeout waiting for ${marker}: ${err||out}`))}},20000)});c.stdout.on('data',x=>{out+=x;if(!settled&&out.includes(marker)){settled=true;clearTimeout(timer);resolve()}});c.stderr.on('data',x=>err+=x);c.stdin.end(s);const done=new Promise(r=>c.on('close',code=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error(`session ended before ${marker}: ${err||out}`))}r({code,out,err})}));return {ready,done} }
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function scalar(statement){const out=sql(statement).stdout.trim(); if(!out)throw new Error(`expected scalar output: ${statement}`); return out.split(/\r?\n/).at(-1)}
function json(statement){return JSON.parse(scalar(statement))}
function claims(userId){return `SET \"request.jwt.claim.sub\" = '${userId}'; SET \"request.jwt.claim.role\" = 'authenticated';`}
function assertExactFailure(result,code,label){const exit=result.code??result.status, out=result.out??result.stdout??'', err=result.err??result.stderr??'';assert.notEqual(exit,0,`${label} unexpectedly succeeded: ${out}`);assert.match(`${out}\n${err}`,new RegExp(`ERROR:\\s+${code}`),`${label} did not fail ${code}: ${out}\n${err}`)}
async function assertWaiting(done,label){const state=await Promise.race([done.then(()=> 'finished'),pause(500).then(()=> 'waiting')]);assert.equal(state,'waiting',`${label} did not wait for the advisory lock`)}
try {
  run(['run','-d','--name',NAME,'--network','none','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m','-e','POSTGRES_PASSWORD=postgres',image]);
  let healthy=false; for(let i=0;i<90;i++){if(run(['exec',NAME,'pg_isready','-U','postgres','-d','postgres'],{fail:true}).status===0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);if(run(['exec',NAME,'pg_isready','-U','postgres','-d','postgres'],{fail:true}).status===0){healthy=true;break}}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)} if(!healthy)throw new Error('disposable Postgres did not become healthy');
  for(const [k,v] of Object.entries(files)) file(v,`${k}.sql`);
  adminSql('CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);');
  apply('extensions.sql'); apply('dump.sql');
  // The real dump is deliberately pre-Section09. Each migration is a separate
  // transaction so a failure proves which boundary failed and stops the proof.
  apply('section9.sql'); apply('stageA.sql');
  sql(`INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-00000000a001'),('00000000-0000-0000-0000-00000000a002') ON CONFLICT DO NOTHING; INSERT INTO public.profiles(id,email,role,is_active) VALUES ('00000000-0000-0000-0000-00000000a001','phase3-admin@example.invalid','admin',true),('00000000-0000-0000-0000-00000000a002','phase3-sales@example.invalid','sales_rep',true) ON CONFLICT (id) DO UPDATE SET role=excluded.role,is_active=true;`);
  const smoke=sql('\\i /tmp/smoke.sql',{fail:true}); const smokeOut=`${smoke.stdout}\n${smoke.stderr}`; assert.match(smokeOut,/SMOKE_PASS_ROLLBACK/,'rollback matrix did not reach its terminal marker');
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
  function makeFixture(label,state='requested'){
    const n=++fixtureNo, tag=`[PROOF P3 ${process.pid}-${n}] ${label}`;
    const productId=scalar(`INSERT INTO public.products(product_name) VALUES ('${tag} Product') RETURNING id;`);
    const customerId=scalar(`INSERT INTO public.customers(farm_name) VALUES ('${tag} Customer') RETURNING id;`);
    const orderId=scalar(`INSERT INTO public.orders(order_number,customer_id,salesman_id,status) VALUES ('P3-${process.pid}-${n}','${customerId}'::uuid,'${sales}'::uuid,'confirmed') RETURNING id;`);
    const orderItemId=scalar(`INSERT INTO public.order_items(order_id,product_id,product_name,price_per_unit,total_units_needed,unit_size,total_price,quantity_delivered,quantity_remaining) VALUES ('${orderId}'::uuid,'${productId}'::uuid,'${tag} Product',10,4,'ea',40,4,0) RETURNING id;`);
    scalar(`INSERT INTO public.inventory(product_id,location,quantity_available,unit_size) VALUES ('${productId}'::uuid,'Main Warehouse',7,'ea') RETURNING id;`);
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
  async function metadataFirstSuccessCreate(){
    const f=makeFixture('metadata-first create','none');
    const key=`race-${f.n}-create`, before=snapshot(f,key), marker=`P3_META_LOCKED_CREATE_${f.n}`, call=`P3_WRAPPER_CALLING_CREATE_${f.n}`;
    const meta=session(`BEGIN; ${claims(admin)} SELECT public.lock_phase3_product_policy_products(ARRAY['${f.productId}'::uuid]); SELECT '${marker}'; SELECT pg_sleep(2); ${metadataSql(f,`meta-${f.n}`)} COMMIT;`,marker);
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
    const holder=session(`BEGIN; SET lock_timeout='10s'; ${claims(operation==='issue_return_credit'?admin:sales)} SELECT public.lock_phase3_product_policy_products(ARRAY['${f.productId}'::uuid]); SELECT '${marker}'; SELECT pg_sleep(2); ${wrapperSql(f,operation,key)} COMMIT;`,marker);
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
  // Positive control first: this fixture must restock Main Warehouse through
  // the real receive wrapper before the race cases assert its no-effect path.
  const receiveControl=makeFixture('receive positive control','approved'), receiveBefore=snapshot(receiveControl,`control-${receiveControl.n}`);
  json(`${claims(sales)} ${wrapperSql(receiveControl,'receive_return',`control-${receiveControl.n}`)}`); const receiveAfter=snapshot(receiveControl,`control-${receiveControl.n}`);
  assert.equal(receiveAfter.inventory,receiveBefore.inventory+2,'receive control did not restock Main Warehouse exactly'); assert.equal(receiveAfter.transactions,receiveBefore.transactions+1,'receive control did not create exactly one transaction');
  console.log('PHASE3_RECEIVE_RESTOCK_EFFECTS_PASS');
  await metadataFirstSuccessCreate();
  await metadataFirstActiveRefusal('approve_return','requested');
  await metadataFirstActiveRefusal('receive_return','approved');
  await metadataFirstActiveRefusal('issue_return_credit','received');
  await wrapperFirst('create_return','requested');
  await wrapperFirst('approve_return','requested');
  await wrapperFirst('receive_return','approved');
  await wrapperFirst('issue_return_credit','received');
  proveCreditedReversalBoundary();
  console.log('PHASE3_REAL_SCHEMA_RESTORE_PASS'); console.log('PHASE3_ROLLBACK_MATRIX_PASS'); console.log('PHASE3_REAL_TWO_CONNECTION_LOCK_ORDER_PASS');
  console.log('PHASE3_REAL_WRAPPER_CONCURRENCY_PASS');
} finally { run(['rm','-f',NAME],{fail:true}); }
