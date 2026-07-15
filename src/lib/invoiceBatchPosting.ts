export interface BatchPostInvoice {
  id: string;
  invoice_number: string;
  invoice_group_id?: string | null;
}

export interface InvoicePostTarget {
  key: string;
  operation: 'post_invoice' | 'post_invoice_group';
  scopeId: string;
  label: string;
  selectedIds: string[];
  invoiceId?: string;
  invoiceGroupId?: string;
}

export function describeInvoicePostScope(invoices: BatchPostInvoice[]): {
  message: string;
  confirmLabel: string;
} {
  if (invoices.some((invoice) => Boolean(invoice.invoice_group_id))) {
    return {
      message: `Post ${invoices.length} selected invoice(s)? Selecting any split invoice posts every current invoice in that split group, including members outside current filters or loaded results. The full posting scope will be locked into AR.`,
      confirmLabel: 'Post selected + full split groups',
    };
  }
  return {
    message: `Post ${invoices.length} selected invoice(s)? Posting locks them into AR.`,
    confirmLabel: `Post ${invoices.length}`,
  };
}

/**
 * Build one posting action per standalone invoice and one action per split group.
 * A group RPC posts every sibling atomically, even when the user selected only
 * one visible member, so grouped rows must never fall through to post_invoice.
 */
export function buildInvoicePostTargets(invoices: BatchPostInvoice[]): InvoicePostTarget[] {
  const targets: InvoicePostTarget[] = [];
  const groupTargets = new Map<string, InvoicePostTarget>();

  for (const invoice of invoices) {
    if (!invoice.invoice_group_id) {
      targets.push({
        key: `invoice:${invoice.id}`,
        operation: 'post_invoice',
        scopeId: invoice.id,
        label: invoice.invoice_number,
        selectedIds: [invoice.id],
        invoiceId: invoice.id,
      });
      continue;
    }

    const existing = groupTargets.get(invoice.invoice_group_id);
    if (existing) {
      existing.selectedIds.push(invoice.id);
      existing.label += `, ${invoice.invoice_number}`;
      continue;
    }

    const target: InvoicePostTarget = {
      key: `group:${invoice.invoice_group_id}`,
      operation: 'post_invoice_group',
      scopeId: invoice.invoice_group_id,
      label: `Split group (${invoice.invoice_number}`,
      selectedIds: [invoice.id],
      invoiceGroupId: invoice.invoice_group_id,
    };
    groupTargets.set(invoice.invoice_group_id, target);
    targets.push(target);
  }

  for (const target of groupTargets.values()) {
    target.label += ')';
  }
  return targets;
}
