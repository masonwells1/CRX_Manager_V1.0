import { useEffect, useRef, useState } from 'react';
import { Sentry } from '../lib/sentry';
import { supabase } from '../lib/db';

const POLL_INTERVAL = 30000;

/**
 * Monitors the OCR processing queue and re-triggers the Edge Function
 * for any stuck/pending items as a fallback recovery mechanism.
 * The primary trigger is the immediate Edge Function call in BulkTicketUpload.
 */
export function useOCRProcessor(enabled: boolean = true) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const pollIntervalRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    if (!enabled) return;

    checkQueue();
    pollIntervalRef.current = setInterval(checkQueue, POLL_INTERVAL);

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = undefined;
      }
    };
  }, [enabled]);

  async function checkQueue() {
    try {
      // Check for pending or stuck processing items
      const { data: queueItems, error } = await supabase
        .from('ocr_processing_queue')
        .select('*, blend_tickets!inner(*)')
        .in('status', ['pending', 'processing'])
        .lt('retry_count', 3)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(5);

      if (error || !queueItems || queueItems.length === 0) {
        setIsProcessing(false);
        return;
      }

      setIsProcessing(true);

      for (const item of queueItems) {
        // Skip items that are actively processing (started less than 2 minutes ago)
        if (item.status === 'processing' && item.started_at) {
          const startedAt = new Date(item.started_at).getTime();
          const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
          if (startedAt > twoMinutesAgo) continue;
        }

        // Re-trigger the Edge Function for stuck/pending items
        try {
          await supabase.functions.invoke('process-blend-ticket', {
            body: { blend_ticket_id: item.blend_ticket_id },
          });
          setProcessedCount(prev => prev + 1);
        } catch (err) {
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'Failed to re-trigger OCR for ticket', blend_ticket_id: item.blend_ticket_id } });
        }
      }

      setIsProcessing(false);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'Queue check error' } });
      setIsProcessing(false);
    }
  }

  return {
    isProcessing,
    processedCount,
  };
}
