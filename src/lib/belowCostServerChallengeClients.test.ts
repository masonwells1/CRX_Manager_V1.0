import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const newOrderSource = readFileSync(join(root, 'src', 'pages', 'NewOrder.tsx'), 'utf8');
const bulkImportSource = readFileSync(
  join(root, 'src', 'components', 'orders', 'BulkOrderImport.tsx'),
  'utf8',
);

function rpcWindow(source: string, rpcName: string): string {
  const marker = `supabase.rpc('${rpcName}'`;
  const start = source.indexOf(marker);
  expect(start, `${rpcName} call must remain present`).toBeGreaterThanOrEqual(0);
  return source.slice(Math.max(0, start - 700), start + 1_300);
}

describe('below-cost server-challenge clients', () => {
  it('creates direct orders reasonless before any locked-cost approval retry', () => {
    const call = rpcWindow(newOrderSource, 'create_direct_order');

    expect(newOrderSource).toContain('await submitOrder();');
    expect(newOrderSource).toContain('const submitOrder = async () =>');
    expect(newOrderSource).not.toContain('BelowCostConfirmModal');
    expect(newOrderSource).not.toContain('reason ?? belowCostReason');
    expect(call).toContain('runWithBelowCostApproval((reason) =>');
    expect(call).toContain('}, reason)))');
  });

  it('imports each order reasonless before using the database locked-cost challenge', () => {
    const call = rpcWindow(bulkImportSource, 'bulk_import_order');

    expect(bulkImportSource).not.toContain('BelowCostConfirmModal');
    expect(bulkImportSource).not.toContain('belowCostPrompt');
    expect(bulkImportSource).not.toContain('belowCostReasonRef');
    expect(call).toContain('runWithBelowCostApproval((reason) =>');
    expect(bulkImportSource).toContain('if (reason) approvalReasonUsed = reason;');
    expect(call).toContain('}, recordApprovalReason(reason)))');
    expect(bulkImportSource).toContain('onClose={approvalOpen ? () => {} : handleClose}');
  });
});
