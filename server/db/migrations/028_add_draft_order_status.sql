-- Add a 'draft' status to orders. A draft is an in-progress order that has been
-- parked (customer selected, items maybe incomplete) and can be resumed later.
-- Drafts never deduct inventory and are excluded from all lists/totals/history
-- except the dedicated Drafts tab. Finalizing a draft transitions it to 'pending'.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft', 'pending', 'in_transit', 'completed', 'cancelled', 'done'));
