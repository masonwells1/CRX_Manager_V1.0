-- Add missing foreign key constraints so Supabase/PostgREST can join these tables
ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_purchase_order_id_fkey
    FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id);

ALTER TABLE public.inventory_transactions
  ADD CONSTRAINT inventory_transactions_delivery_id_fkey
    FOREIGN KEY (delivery_id) REFERENCES public.deliveries(id);
