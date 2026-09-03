import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const migration = source('supabase', 'migrations', '20260903193000_align_invoice_due_date_to_chicago_posting_date.sql');
const transferDefinition = source('supabase', 'migrations', '20260713060000_harden_field_split_sum100.sql');
const terminalOrderDefinition = source(
  'supabase',
  'migrations',
  '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql',
);
const lifecycleSmoke = source('scripts', 'smoke', 'smoke-govern-invoice-order-money-lifecycle.sql');
const groupSmoke = source('scripts', 'smoke', 'smoke-field-app-split-penny-exact.sql');
const transferSmoke = source('scripts', 'smoke', 'smoke-transfer_job_invoice_machine_fee.sql');
const unpostGroupSmoke = source('scripts', 'smoke', 'smoke-unpost-invoice-group.sql');

const normalFunction = '_post_invoice_impl_20260714';
const recoveryFunction = '_post_deleted_delivery_recovery_invoice_20260719';
const saveFunction = '_save_invoice_scoped_impl';
const fieldBillingFunction = 'update_field_app_invoice_billing';
const unpostFunction = 'unpost_invoice';
const saveWrapperChain = [
  [
    'public.save_invoice(jsonb,jsonb,text)',
    'RETURN public._save_invoice_below_cost_impl_20260810(',
  ],
  [
    'public._save_invoice_below_cost_impl_20260810(jsonb,jsonb,text)',
    'RETURN public._save_invoice_intent_impl_20260802(',
  ],
  [
    'public._save_invoice_intent_impl_20260802(jsonb,jsonb,text)',
    'RETURN public._save_invoice_governed_split_guard_impl_20260720(',
  ],
  [
    'public._save_invoice_governed_split_guard_impl_20260720(jsonb,jsonb,text)',
    'v_saved_id := public._save_invoice_split_provenance_impl_20260719(',
  ],
  [
    'public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)',
    'RETURN public._save_invoice_scoped_impl(',
  ],
] as const;

function occurrenceCount(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function functionBody(name: string, sqlSource = migration): string | undefined {
  const declaration = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const declarationStart = sqlSource.indexOf(declaration);
  if (declarationStart < 0) return undefined;

  const bodyMarker = 'AS $function$';
  const bodyStart = sqlSource.indexOf(bodyMarker, declarationStart);
  if (bodyStart < 0) return undefined;

  const bodyContentStart = bodyStart + bodyMarker.length;
  const bodyEnd = sqlSource.indexOf('$function$;', bodyContentStart);
  if (bodyEnd < 0) return undefined;

  return sqlSource.slice(bodyContentStart, bodyEnd);
}

function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe('invoice posting due-date migration', () => {
  it('adds constrained provenance without guessing that every legacy date was explicit', () => {
    const sql = compact(migration);

    expect(sql).toContain('ADD COLUMN due_date_source text;');
    expect(sql).toContain("due_date_source IN ('system', 'explicit', 'legacy')");
    expect(sql).toContain("AND (due_date_source = 'system' OR due_date IS NOT NULL)");
    expect(sql).toContain("ALTER COLUMN due_date_source SET DEFAULT 'system'");
    expect(sql).toContain('ALTER COLUMN due_date_source SET NOT NULL');
    expect(sql).toContain(
      "SET due_date_source = CASE WHEN due_date IS NULL THEN 'system' ELSE 'legacy' END;",
    );
    expect(sql).not.toContain('AND due_date = invoice_date + 30');
    expect(sql).not.toContain("WHEN invoice_type = 'field_application'");
    expect(sql).not.toContain("WHEN due_date IS NOT NULL THEN 'explicit'");
  });

  it('pins every exact live preimage before replacing a money-path body', () => {
    expect(migration).toContain('f3e0dc65b1e565257a0342199f45e467c5db3a5ff81251db43141f13e95747c3');
    expect(migration).toContain('f581dfe487296a5b48e600988a6903b947b44140e3c4a3d4e9b5ee8e933c8c99');
    expect(migration).toContain('cab2bde1aa6bf26d918639cfb8d328ac579d0b7f5429123aa24710a1a835866e');
    expect(migration).toContain('57dbda49bc4f96a9afcfed6e22cd83ae74d4d8ade171ff87c2b5d595a261c700');
    expect(migration).toContain('e10a91958b0c482d90601a7d4ee9bce39b7fc123a20c8f66e4b73ee9cf53e041');
    expect(migration).toContain("p.proargtypes = '2951 25 25 25 1082 25 25 3802 2950 25'::oidvector");
    expect(migration).toContain("p.proconfig = ARRAY['search_path=public, pg_temp']::text[]");
  });

  it('pins every adjacent save wrapper edge before and after replacing the scoped implementation', () => {
    for (const [signature, executableEdge] of saveWrapperChain) {
      expect(migration).toContain(`'${signature}'`);
      expect(occurrenceCount(migration, `'${executableEdge}' IN p.prosrc`)).toBe(2);
    }

    expect(migration).not.toContain("'public._save_invoice_scoped_impl' IN p.prosrc");
  });

  it('pins and restores the two exact triggers needed for a recovery-safe metadata backfill', () => {
    const sql = compact(migration);
    const updatedAtDisable = migration.indexOf(
      "EXECUTE 'ALTER TABLE public.invoices DISABLE TRIGGER set_invoices_updated_at'"
    );
    const terminalOrderDisable = migration.indexOf(
      "EXECUTE 'ALTER TABLE public.invoices DISABLE TRIGGER trg_guard_invoice_terminal_order'",
      updatedAtDisable,
    );
    const backfill = migration.indexOf('UPDATE public.invoices', terminalOrderDisable);
    const terminalOrderEnable = migration.indexOf(
      "EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER trg_guard_invoice_terminal_order'",
      backfill,
    );
    const updatedAtEnable = migration.indexOf(
      "EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER set_invoices_updated_at'",
      backfill
    );
    const terminalBody = functionBody('guard_invoice_terminal_order', terminalOrderDefinition);

    expect(sql).toContain("t.tgname = 'set_invoices_updated_at'");
    expect(sql).toContain("t.tgenabled = 'O'");
    expect(sql).toContain('t.tgtype = 19');
    expect(sql).toContain("position('NEW.updated_at = now();' IN p.prosrc) > 0");
    expect(sql).toContain("t.tgname = 'trg_guard_invoice_terminal_order'");
    expect(sql).toContain('t.tgtype = 23');
    expect(sql).toContain('t.tgnargs = 0');
    expect(terminalBody).toBeDefined();
    expect(bodySha256(terminalBody ?? '')).toBe(
      '12e1161cc8ceb4eef7105b1bdd8b1b0d25f76b29dfacf385c6701016f65d14fb',
    );
    expect(occurrenceCount(
      migration,
      '12e1161cc8ceb4eef7105b1bdd8b1b0d25f76b29dfacf385c6701016f65d14fb',
    )).toBe(2);
    expect(updatedAtDisable).toBeGreaterThan(-1);
    expect(terminalOrderDisable).toBeGreaterThan(updatedAtDisable);
    expect(backfill).toBeGreaterThan(terminalOrderDisable);
    expect(terminalOrderEnable).toBeGreaterThan(backfill);
    expect(updatedAtEnable).toBeGreaterThan(terminalOrderEnable);
    expect(occurrenceCount(
      migration,
      "EXECUTE 'ALTER TABLE public.invoices DISABLE TRIGGER trg_guard_invoice_terminal_order'",
    )).toBe(1);
    expect(occurrenceCount(
      migration,
      "EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER trg_guard_invoice_terminal_order'",
    )).toBe(2);
    expect(occurrenceCount(
      migration,
      "EXECUTE 'ALTER TABLE public.invoices ENABLE TRIGGER set_invoices_updated_at'",
    )).toBe(2);
  });

  it.each([normalFunction, recoveryFunction])(
    '%s recalculates only system dates from Chicago posting date and terms',
    (name) => {
      const body = functionBody(name);
      expect(body).toBeDefined();
      const sql = compact(body ?? '');

      expect(sql).toContain("v_posting_date date := (now() AT TIME ZONE 'America/Chicago')::date;");
      expect(sql).toContain('check_period_open(v_inv.invoice_date);');
      expect(sql).toMatch(
        /due_date = CASE WHEN v_inv\.due_date_source = 'system' THEN \(v_posting_date \+ \(v_terms_days \|\| ' days'\)::interval\)::date ELSE due_date END/
      );
      expect(sql).not.toMatch(/due_date = COALESCE\(/);
      expect(sql).not.toMatch(/v_inv\.invoice_date \+ \(v_terms_days/);
    }
  );

  it('records save and field-app editor intent, then clears only system dates on unpost', () => {
    const save = compact(functionBody(saveFunction) ?? '');
    const fieldBilling = compact(functionBody(fieldBillingFunction) ?? '');
    const unpost = compact(functionBody(unpostFunction) ?? '');

    expect(save).toContain("v_due_date_source NOT IN ('system', 'explicit', 'legacy')");
    expect(save).toContain("WHEN p_invoice ? 'due_date_source' THEN v_due_date_source");
    expect(save).toContain("WHEN p_invoice ? 'due_date' THEN");
    expect(save).toContain('ELSE i.due_date_source');
    expect(fieldBilling).toContain("WHEN p_due_date IS NULL THEN 'system'");
    expect(fieldBilling).toContain("WHEN i.due_date_source = 'legacy'");
    expect(fieldBilling).toContain('AND p_due_date IS NOT DISTINCT FROM i.due_date');
    expect(unpost).toContain("due_date = CASE WHEN v_inv.due_date_source = 'system' THEN NULL ELSE due_date END");
    expect(unpost).toContain("check_idempotency(p_idempotency_key, 'unpost_invoice')");
    expect(unpost).toContain("save_idempotency(p_idempotency_key, 'unpost_invoice', v_result)");
  });

  it('stages an existing explicit or legacy to system save atomically before the historical delegate', () => {
    const save = functionBody(saveFunction) ?? '';
    const sql = compact(save);
    const transition = save.indexOf('UPDATE public.invoices i');
    const delegate = save.indexOf('v_result := public._save_invoice_lineage_unaware_impl_20260827(');

    expect(sql).toContain("p_invoice ? 'due_date_source' AND NULLIF(p_invoice->>'due_date_source', '') = 'system'");
    expect(sql).toContain("NOT (p_invoice ? 'due_date_source') AND p_invoice ? 'due_date' AND NULLIF(p_invoice->>'due_date', '') IS NULL");
    expect(sql).toContain("SET due_date = NULL, due_date_source = 'system', updated_at = now()");
    expect(sql).toContain("i.status IN ('draft', 'unposted') AND i.due_date_source IS DISTINCT FROM 'system'");
    expect(transition).toBeGreaterThan(-1);
    expect(delegate).toBeGreaterThan(transition);
  });

  it('covers transfer defaults and all direct, group, batch, and recovery routes', () => {
    expect(occurrenceCount(transferDefinition, "(CURRENT_DATE + interval '30 days')::date")).toBe(2);
    expect(migration).toContain("ALTER COLUMN due_date_source SET DEFAULT 'system'");
    expect(migration).toContain("p.proname = 'batch_post_invoices'");
    expect(migration).toContain("position('public.post_invoice' IN p.prosrc)");
    expect(migration).toContain("p.proname = '_post_invoice_group_customer_scope_impl'");
    expect(migration).toContain("p.proname = 'unpost_invoice_group'");
    expect(migration).toContain("position('unpost_invoice(' IN p.prosrc)");
    expect(migration).toContain("p.proname = '_post_deleted_delivery_recovery_invoice_20260719'");
  });

  it('preserves mature lifecycle and execution boundaries', () => {
    const normal = compact(functionBody(normalFunction) ?? '');
    const recovery = compact(functionBody(recoveryFunction) ?? '');

    expect(normal).toContain("check_idempotency(p_idempotency_key, 'post_invoice')");
    expect(normal).toContain("save_idempotency(p_idempotency_key, 'post_invoice'");
    expect(normal).toContain('PERFORM generate_rup_sales_records(p_invoice_id);');
    expect(recovery).toContain('DELETED_DELIVERY_RECOVERY_ITEMS_INVALID');
    expect(recovery).toContain('invoice_delivery_recovery_capabilities');
    expect(recovery).toContain('PERFORM public.generate_rup_sales_records(p_invoice_id);');
    expect(migration.match(/^\s*SECURITY DEFINER$/gm)?.length).toBe(5);
    expect(migration).toContain('REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public._post_invoice_impl_20260714(uuid, text)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public._post_deleted_delivery_recovery_invoice_20260719(uuid)');
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.update_field_app_invoice_billing(uuid[], text, text, text, date, text, text, jsonb, uuid, text)'
    );
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.unpost_invoice(uuid, uuid, text)');
  });

  it.each([
    [saveFunction, '0d423e115721d5e10c8c3feb9e1e1f61100ce3e34b5ca3cf60163a6833034ab7'],
    [fieldBillingFunction, 'c354f16186a59ac07a6dc3c9b54c05a1cdd4552fed7740bd120c7f3eb0f9bde4'],
    [unpostFunction, 'b370e012ffa787efae7762555d42a72c90128271d64e47c182d5d5d24155a1ea'],
    [normalFunction, '973374598bcf255808edb4af5444817bda7206a45a0e092128df6bbc6dc9d9b9'],
    [recoveryFunction, '7831288229860f6601499a0b621308d915b4ae8ece123e43fce30dc034b3980b'],
  ])('pins the exact replacement body for %s', (name, expectedHash) => {
    const body = functionBody(name);
    expect(body).toBeDefined();

    const hash = bodySha256(body ?? '');
    expect(hash).toBe(expectedHash);
    expect(migration).toContain(hash);
  });

  it('registers rollback-only behavior proofs for the adversarial regression matrix', () => {
    expect(lifecycleSmoke).toContain("payment_terms = 'Net 15'");
    expect(lifecycleSmoke).toContain(
      'SMOKE_FAIL: batch posting did not derive system due dates from Chicago posting date and terms'
    );
    expect(lifecycleSmoke).toContain('SMOKE_FAIL: unpost retained a system-generated due date');
    expect(lifecycleSmoke).toContain('SMOKE_FAIL: repost did not recalculate the system due date');
    expect(lifecycleSmoke).toContain('SMOKE_FAIL: repost replaced an explicit due date');
    expect(lifecycleSmoke).toContain("payment_terms = 'Net 45'");
    expect(lifecycleSmoke).toContain(
      'SMOKE_FAIL: recovery posting due date did not use the Chicago posting date or capability cleanup failed'
    );
    expect(groupSmoke).toContain(
      'SMOKE_FAIL(P7): group posting did not derive each system due date from Chicago posting date and terms'
    );
    expect(transferSmoke).toContain('SMOKE_FAIL: A post did not replace transfer +30 with Chicago Net 15');
    expect(transferSmoke).toContain('SMOKE_FAIL: B group post did not replace transfer +30 with each customer term');
    expect(unpostGroupSmoke).toContain('SMOKE_FAIL: group unpost did not clear system and preserve explicit due dates');
    expect(lifecycleSmoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
    expect(groupSmoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
    expect(transferSmoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
    expect(unpostGroupSmoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });
});
