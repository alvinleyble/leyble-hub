-- Match delta precision to order_items.quantity (now NUMERIC to support 0.5-case adjustments)
ALTER TABLE inventory_audit_logs ALTER COLUMN delta TYPE NUMERIC(10,2);
