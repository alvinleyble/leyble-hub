-- custom_deposit_fee is unused since migration 023 moved deposit tracking
-- to the product level (products.deposit_fee, per-bottle). No code reads or
-- writes this column anymore.
ALTER TABLE customer_product_prices DROP COLUMN IF EXISTS custom_deposit_fee;
