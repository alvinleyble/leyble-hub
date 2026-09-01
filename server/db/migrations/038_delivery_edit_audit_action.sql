-- A delivery edit/void reverses stock it once added. That reversal was logged as
-- `manual_adjustment` — the same action type a person's own stock recount writes —
-- which made the offline reconciliation guard (client/src/offline/productMutations.js,
-- HUMAN_ACTION_FOR_FIELD) read it as "another human counted this shelf" and raise a
-- reconciliation question nobody needed to answer.
--
-- Additive and correct standing alone (ADR 0014 sequencing): the new value simply
-- becomes writable, and a server still running the old code keeps writing values that
-- remain legal. Existing rows are NOT rewritten — inventory_audit_logs is append-only,
-- and a historical mislabel is still an honest record of what was stored at the time.
--
-- The constraint is dropped by lookup rather than by name: migration 011 declared it
-- inline on the column, so its name is Postgres-generated and not guaranteed.
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'inventory_audit_logs'::regclass
    AND contype  = 'c'
    AND pg_get_constraintdef(oid) LIKE '%action_type%';

  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE inventory_audit_logs DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE inventory_audit_logs
  ADD CONSTRAINT inventory_audit_logs_action_type_check
  CHECK (action_type IN (
    'manual_adjustment',
    'restock',
    'price_change',
    'order_fulfillment',
    'order_edit',
    'order_cancel',
    'delivery_edit'
  ));
