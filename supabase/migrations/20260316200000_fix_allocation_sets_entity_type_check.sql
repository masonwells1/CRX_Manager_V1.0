-- Fix: allocation_sets entity_type check constraint only allows 'order' and 'invoice',
-- but allocate_payment RPC inserts 'payment'. This is a critical bug that prevents
-- all payment processing. Add 'payment' to the allowed values.

ALTER TABLE allocation_sets
  DROP CONSTRAINT IF EXISTS allocation_sets_entity_type_check;

ALTER TABLE allocation_sets
  ADD CONSTRAINT allocation_sets_entity_type_check
  CHECK (entity_type IN ('order', 'invoice', 'payment'));
