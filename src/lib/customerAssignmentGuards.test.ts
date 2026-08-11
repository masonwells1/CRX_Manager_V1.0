import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(join(
  root,
  'supabase/migrations/20260811183317_assign_customers_sales_rep.sql',
), 'utf8').replace(/\r\n/g, '\n');

const functionBodyMatch = migration.match(
  /CREATE OR REPLACE FUNCTION public\.assign_customers_sales_rep\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
);
if (!functionBodyMatch) throw new Error('assign_customers_sales_rep function body not found');
const executableFunctionBody = functionBodyMatch[1]
  .replace(/--[^\n]*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

describe('atomic customer sales-rep assignment migration', () => {
  it('locks and validates the active rep inside the assignment transaction', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(executableFunctionBody).toMatch(
      /SELECT p\.role INTO v_actor_role FROM public\.profiles p WHERE p\.id = v_actor AND p\.is_active = true;/,
    );
    expect(executableFunctionBody).toContain("v_actor_role IS DISTINCT FROM 'admin'");
    expect(executableFunctionBody).toMatch(
      /PERFORM p\.id FROM public\.profiles p WHERE p\.id = p_sales_rep_id AND p\.role = 'sales_rep' AND p\.is_active = true FOR SHARE;/,
    );
    expect(executableFunctionBody).not.toContain('FOR KEY SHARE');
    expect(executableFunctionBody.indexOf('FOR SHARE;')).toBeLessThan(
      executableFunctionBody.indexOf('UPDATE public.customers'),
    );
  });

  it('rolls back instead of accepting a partial active-customer match', () => {
    expect(migration).toMatch(
      /UPDATE public\.customers c[\s\S]*c\.id = ANY\(v_customer_ids\)[\s\S]*c\.is_active = true/,
    );
    expect(migration).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT');
    expect(migration).toContain('v_updated_count IS DISTINCT FROM cardinality(v_customer_ids)');
    expect(migration).toContain('ASSIGNMENT_CUSTOMER_SET_CHANGED');
  });

  it('makes the migration postflight inspect executable SQL and pinned security settings', () => {
    expect(migration).toContain('p.prosrc, p.prosecdef, p.proconfig');
    expect(migration).toContain("('search_path=public, pg_temp' = ANY (v_config)) IS NOT TRUE");
    expect(migration).toContain("regexp_replace(v_source, E'--[^\\n\\r]*', '', 'g')");
    expect(migration).toContain("regexp_replace(v_executable_source, '[[:space:]]+', ' ', 'g')");
    expect(migration).toContain(
      "PERFORM p.id FROM public.profiles p WHERE p.id = p_sales_rep_id AND p.role = ''sales_rep'' AND p.is_active = true FOR SHARE;",
    );
  });

  it('binds replay to the actor, exact customer set, and target rep with narrow grants', () => {
    expect(migration).toContain("'actor', v_actor");
    expect(migration).toContain("'customer_ids', to_jsonb(v_customer_ids)");
    expect(migration).toContain("'sales_rep_id', p_sales_rep_id");
    expect(migration).toContain("public.check_idempotency(");
    expect(migration).toContain('ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH');
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.assign_customers_sales_rep\(uuid\[\], uuid, text\)[\s\S]*FROM PUBLIC, anon;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.assign_customers_sales_rep\(uuid\[\], uuid, text\)[\s\S]*TO authenticated;/,
    );
  });
});
