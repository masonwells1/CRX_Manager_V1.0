import type { DetailedStatementData } from '../types';

/**
 * Returns the three authoritative statement balance figures, and rejects
 * legacy RPC payloads before a customer-facing document can be generated.
 */
export function getStatementAccountPosition(data: DetailedStatementData) {
  if (
    typeof data.open_credit_cents !== 'number' ||
    typeof data.net_account_position_cents !== 'number'
  ) {
    throw new Error(
      'Statement generation is temporarily unavailable because the database balance disclosure is not ready.',
    );
  }

  return {
    grossOpenInvoiceCents: data.outstanding_balance_cents,
    openCreditCents: data.open_credit_cents,
    netAccountPositionCents: data.net_account_position_cents,
  };
}
