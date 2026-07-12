import { supabaseUntyped as supabase, assertRpcResult } from './db';

interface StampJobPrintedResult {
  success: boolean;
  job_id?: string;
  error?: string;
}

/**
 * Stamp through the RPC instead of a direct jobs update because applicator-role
 * users can see jobs but jobs_update RLS is admin/sales-only. The SECURITY DEFINER
 * RPC preserves the print audit for every user who is allowed to see that job.
 */
export async function stampJobPrinted(jobId: string): Promise<void> {
  const { data, error } = await supabase.rpc('stamp_job_printed', { p_job_id: jobId });
  if (error) throw error;

  const result = assertRpcResult<StampJobPrintedResult>(data, 'stamp_job_printed');
  if (result.success === false) {
    throw new Error(result.error ?? 'stamp_job_printed failed');
  }
}
