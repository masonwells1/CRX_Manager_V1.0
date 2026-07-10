-- Credit-memo apply — Migration 2 of 5: the immutable application ledger
-- =======================================================================
-- One row per (credit_memo → target_invoice) application. Traceable, append-only,
-- reversible-with-a-marker (never deleted). Codex blockers #3, #8:
--   * FKs ON DELETE RESTRICT, amount > 0, applied_by NOT NULL, indexes on both FKs.
--   * NO client DML — only the SECURITY DEFINER RPCs write. Authenticated = SELECT only.
--   * A DB immutability guard blocks UPDATE (except the one-time reversal stamp) and all DELETE.

CREATE TABLE public.credit_memo_applications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_memo_id     uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  target_invoice_id  uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  applied_by         uuid NOT NULL REFERENCES public.profiles(id),
  applied_at         timestamptz NOT NULL DEFAULT now(),
  reversed_at        timestamptz,
  reversed_by        uuid REFERENCES public.profiles(id),
  reversal_reason    text,
  CONSTRAINT credit_memo_apps_distinct CHECK (credit_memo_id <> target_invoice_id),
  -- the reversal stamp is all-or-nothing (never a half-written reversal)
  CONSTRAINT credit_memo_apps_reversal_complete CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL)
  )
);

CREATE INDEX idx_cma_credit_memo ON public.credit_memo_applications(credit_memo_id);
CREATE INDEX idx_cma_target      ON public.credit_memo_applications(target_invoice_id);
-- fast "active applications touching invoice X" lookups for the reversal/void paths
CREATE INDEX idx_cma_active_memo   ON public.credit_memo_applications(credit_memo_id)    WHERE reversed_at IS NULL;
CREATE INDEX idx_cma_active_target ON public.credit_memo_applications(target_invoice_id) WHERE reversed_at IS NULL;

COMMENT ON TABLE public.credit_memo_applications IS
  'Immutable ledger of credit-memo applications. Written only by apply_credit_memo_to_invoice / '
  'reverse_credit_memo_application (SECURITY DEFINER). Append-only: a reversal stamps '
  'reversed_at/by/reason, it never deletes the row. Each invoice.credit_applied_cents reconciles '
  'to SUM(amount_cents) of its unreversed rows on that side.';

-- ---- RLS: SELECT for admin + sales_rep; NO client INSERT/UPDATE/DELETE (Codex #3) ----
ALTER TABLE public.credit_memo_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY credit_memo_apps_select ON public.credit_memo_applications
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ));

-- Defense in depth on top of RLS (no write policies exist, so writes are already denied):
-- strip table-level write privileges; the SECDEF RPCs run as owner and bypass RLS + these grants.
REVOKE ALL ON public.credit_memo_applications FROM anon;
REVOKE ALL ON public.credit_memo_applications FROM authenticated;
GRANT SELECT ON public.credit_memo_applications TO authenticated;

-- ---- Immutability guard: append-only with a one-time reversal stamp ----
CREATE OR REPLACE FUNCTION public._guard_credit_memo_application_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit_memo_applications are append-only and cannot be deleted (id %)', OLD.id;
  END IF;

  -- UPDATE: the core columns are frozen forever.
  IF NEW.id                IS DISTINCT FROM OLD.id
  OR NEW.credit_memo_id    IS DISTINCT FROM OLD.credit_memo_id
  OR NEW.target_invoice_id IS DISTINCT FROM OLD.target_invoice_id
  OR NEW.amount_cents      IS DISTINCT FROM OLD.amount_cents
  OR NEW.applied_by        IS DISTINCT FROM OLD.applied_by
  OR NEW.applied_at        IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION 'credit_memo_applications core columns are immutable (id %)', OLD.id;
  END IF;

  -- Only allowed mutation: stamp a reversal exactly once (unreversed -> reversed).
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'credit_memo_application % is already reversed; it cannot be modified', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_cma_immutable
  BEFORE UPDATE OR DELETE ON public.credit_memo_applications
  FOR EACH ROW EXECUTE FUNCTION public._guard_credit_memo_application_immutable();
