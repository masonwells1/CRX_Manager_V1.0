import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      content: readFileSync(join(migrationsDir, name), 'utf8'),
    }));
}

function latestFunctionDefinition(functionName: string): string {
  let latest = '';
  const fnPattern = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${functionName}\\b[\\s\\S]*?\\$function\\$;`,
    'i',
  );

  for (const file of migrationFiles()) {
    const match = file.content.match(fnPattern);
    if (match) latest = match[0];
  }

  return latest;
}

function finalPolicyStatements(): Map<string, string> {
  const policies = new Map<string, string>();
  const policyAction =
    /DROP POLICY IF EXISTS\s+"([^"]+)"\s+ON\s+(?:public\.)?([a-z_]+)\s*;|CREATE POLICY\s+"([^"]+)"\s+ON\s+(?:public\.)?([a-z_]+)\b[\s\S]*?;/gi;

  for (const file of migrationFiles()) {
    let match: RegExpExecArray | null;
    while ((match = policyAction.exec(file.content))) {
      if (match[1] && match[2]) {
        policies.delete(`${match[2]}.${match[1]}`);
      } else if (match[3] && match[4]) {
        policies.set(`${match[4]}.${match[3]}`, match[0]);
      }
    }
  }

  return policies;
}

describe('commission payout gauntlet guards', () => {
  it('create_commission_payment rejects stale selections instead of inserting a pending subset', () => {
    const definition = latestFunctionDefinition('create_commission_payment');

    expect(definition).toContain('v_locked_count <> v_selected_count');
    expect(definition).toContain('v_non_pending_count > 0');
    expect(definition).toContain('GET DIAGNOSTICS v_item_count = ROW_COUNT');
    expect(definition).toContain('v_item_count <> v_selected_count');
    expect(definition).toContain('COMMISSION_PAYMENT_SELECTION_STALE');
    expect(definition).toMatch(/SELECT DISTINCT id\s+FROM unnest\(p_commission_ids\)/i);
    expect(definition).toMatch(/FOR UPDATE OF c/i);
  });

  it('commission payment tables expose no direct authenticated write policies', () => {
    const policies = finalPolicyStatements();
    const removedWritePolicies = [
      'commission_payment_items.commission_payment_items_insert_admin',
      'commission_payment_items.commission_payment_items_admin_delete',
      'commission_payments.commission_payments_insert_admin',
      'commission_payments.commission_payments_update_admin',
      'commission_payments.commission_payments_admin_delete',
    ];

    for (const policy of removedWritePolicies) {
      expect(policies.get(policy), `${policy} should not be recreated`).toBeUndefined();
    }

    expect(policies.get('commission_payment_items.commission_payment_items_select_admin')).toMatch(/USING\s*\(\s*is_admin\(\)\s*\)/i);
    expect(policies.get('commission_payments.commission_payments_select_admin')).toMatch(/USING\s*\(\s*is_admin\(\)\s*\)/i);
  });

  it('commissions SELECT policy no longer authorizes by legacy full-name text', () => {
    const commSelect = finalPolicyStatements().get('commissions.comm_select');

    expect(commSelect).toBeDefined();
    expect(commSelect).not.toMatch(/full_name/i);
    expect(commSelect).not.toMatch(/recipient\s*=\s*p\.full_name/i);
    expect(commSelect).toMatch(/recipient_user_id\s*=\s*\(SELECT auth\.uid\(\)\)/i);
  });
});
