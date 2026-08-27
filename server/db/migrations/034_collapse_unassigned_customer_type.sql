-- Migration 034 — V3.0 / ADR 0009: collapse 'unassigned' into 'regular'.
--
-- 'unassigned' only ever existed because saving a custom price forced the customer onto a
-- pricing-bearing type, and 'regular' was the one type that silently disabled custom
-- pricing (ADR 0001). ADR 0009 removes that coupling: custom pricing is now derived from
-- rows in customer_product_prices, and customer_type is a purely descriptive tag. With the
-- coupling gone, 'unassigned' says nothing a reader can act on, so it goes.
--
-- Safe to deploy ahead of the server and APK (ADR 0014 / V3-D19). Production's constraint
-- currently permits ('regular','wholesaler') only — migrations 031 and 032 have never been
-- applied there — so the live V1 server cannot be holding or writing an 'unassigned' row.
-- On the development database, where 031/032 did run, the UPDATE below relabels whatever
-- is there before the narrowed constraint is installed.

-- Relabel any legacy rows first, so the constraint below cannot fail on existing data.
UPDATE customers SET customer_type = 'regular', updated_at = NOW()
WHERE customer_type = 'unassigned';

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_customer_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('regular', 'wholesaler', 'discounted', 'markup'));
