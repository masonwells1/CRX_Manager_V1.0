import type { BelowCostApprovalDetail, BelowCostApprovalError } from '../types';
export type { BelowCostApprovalDetail, BelowCostApprovalError } from '../types';

const BELOW_COST_PREFIXES = {
  BELOW_COST_CONTEXT_REQUIRED: 'context',
  BELOW_COST_ADMIN_REQUIRED: 'admin',
  BELOW_COST_REASON_REQUIRED: 'reason',
} as const;

export class BelowCostApprovalHandledError extends Error {
  constructor() {
    super('Below-cost approval was handled in the UI');
    this.name = 'BelowCostApprovalHandledError';
  }
}

export function isBelowCostApprovalHandledError(error: unknown): boolean {
  return error instanceof BelowCostApprovalHandledError;
}

type ErrorLike = {
  message?: unknown;
  details?: unknown;
  hint?: unknown;
  error_description?: unknown;
};

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function parseDetail(raw: string): BelowCostApprovalDetail | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const detail = value as Record<string, unknown>;
    return {
      operation: nullableString(detail.operation),
      entity_type: nullableString(detail.entity_type),
      entity_id: nullableString(detail.entity_id),
      line_id: nullableString(detail.line_id),
      product_id: nullableString(detail.product_id),
      product_name: nullableString(detail.product_name),
      unit_price_cents: nullableInteger(detail.unit_price_cents),
      locked_unit_cost_cents: nullableInteger(detail.locked_unit_cost_cents),
    };
  } catch {
    return null;
  }
}

/** Parse the fail-closed PostgreSQL below-cost error without throwing. */
export function parseBelowCostApprovalError(error: unknown): BelowCostApprovalError | null {
  const candidate = error as ErrorLike | null;
  const texts = error instanceof Error
    ? [error.message]
    : [candidate?.message, candidate?.details, candidate?.hint, candidate?.error_description]
        .filter((value): value is string => typeof value === 'string');

  for (const text of texts) {
    const normalized = text.trim();
    for (const [prefix, kind] of Object.entries(BELOW_COST_PREFIXES)) {
      const marker = `${prefix}:`;
      if (normalized.startsWith(marker)) {
        return { kind, detail: parseDetail(normalized.slice(marker.length).trim()) };
      }
    }
  }
  return null;
}

const APPROVAL_NOTE_PREFIX = 'Below-cost approved:';

function appendApprovalNote(notes: unknown, reason: string): string {
  const base = typeof notes === 'string' ? notes.trim() : '';
  const marker = `${APPROVAL_NOTE_PREFIX} ${reason.replace(/\s+/g, ' ').trim()}`;
  return base ? `${base}\n${marker}` : marker;
}

function addReasonToJson(value: unknown, reason: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => (
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { ...entry, below_cost_reason: reason }
        : entry
    ));
  }
  if (value && typeof value === 'object') return { ...value, below_cost_reason: reason };
  return value;
}

type BelowCostOperation =
  | 'create_direct_order'
  | 'create_rush_order'
  | 'bulk_import_order'
  | 'update_order_items'
  | 'price_order'
  | 'save_invoice'
  | 'save_quote'
  | 'convert_quote_to_order'
  | 'draw_down_quote'
  | 'restore_quote_version'
  | 'duplicate_quote';

export type BelowCostApprovalRunner = <T>(
  attempt: (reason: string | null) => PromiseLike<T>,
) => Promise<T>;

/** Add a fresh approval reason using the authoritative wrapper's exact transport. */
export function withBelowCostReason<T extends Record<string, unknown>>(
  operation: BelowCostOperation,
  args: T,
  reason: string | null,
): T {
  if (!reason) return args;
  switch (operation) {
    case 'create_direct_order':
    case 'bulk_import_order':
      return { ...args, p_notes: appendApprovalNote(args.p_notes, reason) } as T;
    case 'create_rush_order':
    case 'update_order_items':
    case 'price_order':
    case 'save_invoice':
      return { ...args, p_items: addReasonToJson(args.p_items, reason) } as T;
    case 'save_quote':
      return { ...args, p_sections: addReasonToJson(args.p_sections, reason) } as T;
    case 'convert_quote_to_order':
    case 'draw_down_quote':
    case 'restore_quote_version':
    case 'duplicate_quote':
      return { ...args, p_below_cost_reason: reason } as T;
  }
}

/** Remove the internal marker before order notes are rendered for a customer. */
export function stripBelowCostApprovalNote(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const visible = notes
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(APPROVAL_NOTE_PREFIX))
    .join('\n')
    .trim();
  return visible || null;
}
