-- Wholesale-only: remove 'retail' customer type (all customers are wholesale; suki = VIP pricing)
UPDATE customers SET customer_type = 'wholesale' WHERE customer_type = 'retail';
ALTER TABLE customers DROP CONSTRAINT customers_customer_type_check;
ALTER TABLE customers ALTER COLUMN customer_type SET DEFAULT 'wholesale';
ALTER TABLE customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('wholesale', 'suki'));
