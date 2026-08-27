-- Migration 031: Add 'discounted', 'unassigned', and 'markup' customer types
-- Note: 'markup' was originally intended for 032, but production had 'markup'
-- added out-of-band via Supabase console prior to migrations 031-034 running.
-- Including 'markup' here prevents check constraint violation on existing 'markup' rows.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_customer_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('regular', 'wholesaler', 'discounted', 'markup', 'unassigned'));
