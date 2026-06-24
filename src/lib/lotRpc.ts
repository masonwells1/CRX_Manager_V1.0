// B1 Lot Capture & Trace — typed data-access helpers.
//
// Thin wrapper over the application_record_lots table and its three RPCs
// (get_recent_lots_for_product / set_application_record_lots / get_lot_application_trace),
// introduced by migration 20260622170000 (applied live 2026-06-23). Now that supabase.ts
// is regenerated from the live schema, these are first-class typed supabase.from()/.rpc()
// calls. Kept as named helpers so call sites stay terse and every RPC stays covered by the
// assertRpcResult contract (eslint require-assert-rpc-result + the assertRpcCoverage test).

import { supabase, assertRpcResult } from './db';
import type { Json } from '../types/supabase';
import type {
  ApplicationRecordLot,
  ApplicationRecordLotInput,
  LotApplicationTraceRow,
  RecentLotForProduct,
  SetApplicationRecordLotsResult,
} from '../types';

export type ExistingLotRow = Pick<
  ApplicationRecordLot,
  'product_id' | 'lot_number' | 'source_receiving_record_id' | 'quantity_from_lot' | 'unit'
>;

export interface SaveRecordLotsArgs {
  p_application_record_id: string;
  p_lots: ApplicationRecordLotInput[];
  p_performed_by: string;
  p_idempotency_key: string;
}

/** Existing lots for one application record (empty array when none / RLS-filtered). */
export async function fetchRecordLots(recordId: string): Promise<ExistingLotRow[]> {
  const { data, error } = await supabase
    .from('application_record_lots')
    .select('product_id, lot_number, source_receiving_record_id, quantity_from_lot, unit')
    .eq('application_record_id', recordId);
  if (error) throw error;
  return (data ?? []) as ExistingLotRow[];
}

/** Recent received lots for a product — the application-time suggestion dropdown. */
export async function fetchRecentLots(productId: string): Promise<RecentLotForProduct[]> {
  const { data, error } = await supabase.rpc('get_recent_lots_for_product', { p_product_id: productId });
  if (error) throw error;
  return assertRpcResult<RecentLotForProduct[]>(data, 'get_recent_lots_for_product');
}

/** Replace-all save of an application record's lots via the validated SECURITY DEFINER RPC. */
export async function saveRecordLots(args: SaveRecordLotsArgs): Promise<SetApplicationRecordLotsResult> {
  const { data, error } = await supabase.rpc('set_application_record_lots', {
    p_application_record_id: args.p_application_record_id,
    p_lots: args.p_lots as unknown as Json,
    p_performed_by: args.p_performed_by,
    p_idempotency_key: args.p_idempotency_key,
  });
  if (error) throw error;
  return assertRpcResult<SetApplicationRecordLotsResult>(data, 'set_application_record_lots');
}

/** Recall / compliance trace: every application that used a lot (case-insensitive match). */
export async function traceLot(lotNumber: string): Promise<LotApplicationTraceRow[]> {
  const { data, error } = await supabase.rpc('get_lot_application_trace', { p_lot_number: lotNumber });
  if (error) throw error;
  return assertRpcResult<LotApplicationTraceRow[]>(data, 'get_lot_application_trace');
}
