-- Wholesale-only business model: remove retail price, add case size reference
ALTER TABLE products DROP COLUMN base_retail_price;
ALTER TABLE products ADD COLUMN units_per_case INT NOT NULL DEFAULT 1;
