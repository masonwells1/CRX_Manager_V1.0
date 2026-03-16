-- Migration: Add mark_overdue_invoices() batch function
-- Purpose: Auto-detect posted invoices past their due date and transition them
--          to 'overdue' status.  Designed to be called from a cron job or
--          Edge Function on a daily schedule.
-- Safety:  Read-only scan → targeted UPDATE → audit log.  No idempotency key
--          needed because the function is naturally idempotent (re-running it
--          when no posted+past-due invoices exist is a no-op).

CREATE OR REPLACE FUNCTION public.mark_overdue_invoices()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice  record;
  v_count    integer := 0;
BEGIN
  -- Find all posted invoices whose due_date has passed
  FOR v_invoice IN
    SELECT id, invoice_number, customer_id, due_date
    FROM invoices
    WHERE status = 'posted'
      AND due_date < CURRENT_DATE
      AND deleted_at IS NULL
    FOR UPDATE
  LOOP
    -- Transition to overdue
    UPDATE invoices
    SET status     = 'overdue',
        updated_at = now()
    WHERE id = v_invoice.id;

    -- Append-only audit trail
    INSERT INTO financial_audit_log (
      event_type, entity_type, entity_id,
      description, performed_by, metadata
    ) VALUES (
      'invoice_marked_overdue',
      'invoice',
      v_invoice.id,
      'Invoice ' || v_invoice.invoice_number || ' auto-marked overdue (due ' || v_invoice.due_date || ')',
      NULL,   -- system action, no human performer
      jsonb_build_object(
        'invoice_number', v_invoice.invoice_number,
        'customer_id',    v_invoice.customer_id,
        'due_date',       v_invoice.due_date,
        'marked_at',      now()
      )
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'invoices_marked_overdue', v_count,
    'run_at', now()
  );
END;
$$;

-- Allow authenticated users (admin dashboard) to call this
GRANT EXECUTE ON FUNCTION public.mark_overdue_invoices() TO authenticated;
