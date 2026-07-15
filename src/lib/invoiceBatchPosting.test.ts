import { describe, expect, it } from 'vitest';
import { buildInvoicePostTargets, describeInvoicePostScope } from './invoiceBatchPosting';

describe('buildInvoicePostTargets', () => {
  it('routes standalone invoices through post_invoice', () => {
    expect(buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: null },
    ])).toEqual([
      expect.objectContaining({
        key: 'invoice:inv-1',
        operation: 'post_invoice',
        invoiceId: 'inv-1',
        selectedIds: ['inv-1'],
      }),
    ]);
  });

  it('deduplicates selected split siblings into one atomic group action', () => {
    const targets = buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1' },
      { id: 'inv-2', invoice_number: 'INV-2', invoice_group_id: 'group-1' },
      { id: 'inv-3', invoice_number: 'INV-3', invoice_group_id: null },
    ]);

    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual(expect.objectContaining({
      key: 'group:group-1',
      operation: 'post_invoice_group',
      invoiceGroupId: 'group-1',
      selectedIds: ['inv-1', 'inv-2'],
      label: 'Split group (INV-1, INV-2)',
    }));
    expect(targets[1]).toEqual(expect.objectContaining({
      operation: 'post_invoice',
      invoiceId: 'inv-3',
    }));
  });

  it('uses the group RPC even when only one visible group member is selected', () => {
    const [target] = buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1' },
    ]);

    expect(target.operation).toBe('post_invoice_group');
    expect(target.invoiceId).toBeUndefined();
    expect(target.invoiceGroupId).toBe('group-1');
  });

  it('explicitly discloses that a selected split invoice posts the full server group', () => {
    const confirmation = describeInvoicePostScope([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1' },
    ]);

    expect(confirmation.message).toContain('every current invoice in that split group');
    expect(confirmation.message).toContain('outside current filters or loaded results');
    expect(confirmation.confirmLabel).toContain('full split groups');
  });
});
