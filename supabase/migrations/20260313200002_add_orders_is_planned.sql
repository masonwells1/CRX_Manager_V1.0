-- Add is_planned flag to orders for visual labeling (planned vs committed)
-- This is a display-only flag with no inventory behavior change
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS is_planned boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orders.is_planned IS 'Visual label only — true = planned/tentative, false = committed. No inventory behavior change.';
