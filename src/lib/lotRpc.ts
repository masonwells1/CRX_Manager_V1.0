// B1 Lot Capture & Trace — typed data-access shim.
//
// The table application_record_lots and the RPCs get_recent_lots_for_product /
// set_application_record_lots are introduced by migration 20260622170000, which is
// PARKED pending go-live. Until it is applied AND src/types/supabase.ts is regenerated
// (`generate_typescript_types`), the generated `Database` type the typed client is built
// on does not know them, so a direct typed supabase.from()/.rpc() call won't compile.
//
// This module bridges that gap WITHOUT `any` / @ts-ignore / editing the generated file:
//   - the parked table read goes through a one-line `as unknown as` cast to a hand-written
//     interface (`b1`), keeping the call site fully typed;
//   - the parked RPC names are passed through real `supabase.rpc(...)` with an `as never`
//     name/args cast, so they stay covered by the assertRpcResult contract (eslint
//     require-assert-rpc-result + the assertRpcCoverage test both still see them).
// POST-APPLY: regenerate supabase.ts and these become first-class typed calls.

import { supabase, assertRpcResult } from './db';
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

// Narrow typed view of the parked table for the read path only.
interface B1FromClient {
  from(table: 'application_record_lots'): {
    select(cols: string): {
      eq(col: string, val: string): Promise<{ data: ExistingLotRow[] | null; error: unknown }>;
    };
  };
}
const b1 = supabase as unknown as B1FromClient;

/** Existing lots for one application record (empty array when none / RLS-filtered). */
export async function fetchRecordLots(recordId: string): Promise<ExistingLotRow[]> {
  const { data, error } = await b1
    .from('application_record_lots')
    .select('product_id, lot_number, source_receiving_record_id, quantity_from_lot, unit')
    .eq('application_record_id', recordId);
  if (error) throw error;
  return data ?? [];
}

/** Recent received lots for a product — the application-time suggestion dropdown. */
export async function fetchRecentLots(productId: string): Promise<RecentLotForProduct[]> {
  const { data, error } = await supabase.rpc(
    'get_recent_lots_for_product' as never,
    { p_product_id: productId } as never
  );
  if (error) throw error;
  return assertRpcResult<RecentLotForProduct[]>(data, 'get_recent_lots_for_product');
}

/** Replace-all save of an application record's lots via the validated SECURITY DEFINER RPC. */
export async function saveRecordLots(args: SaveRecordLotsArgs): Promise<SetApplicationRecordLotsResult> {
  const { data, error } = await supabase.rpc('set_application_record_lots' as never, args as never);
  if (error) throw error;
  return assertRpcResult<SetApplicationRecordLotsResult>(data, 'set_application_record_lots');
}

/** Recall / compliance trace: every application that used a lot (case-insensitive match). */
export async function traceLot(lotNumber: string): Promise<LotApplicationTraceRow[]> {
  const { data, error } = await supabase.rpc('get_lot_application_trace' as never, { p_lot_number: lotNumber } as never);
  if (error) throw error;
  return assertRpcResult<LotApplicationTraceRow[]>(data, 'get_lot_application_trace');
}
