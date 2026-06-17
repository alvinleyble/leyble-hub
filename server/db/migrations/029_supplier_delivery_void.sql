-- Soft-delete (void) for supplier deliveries. Deliveries are never hard-deleted
-- because inventory_audit_logs rows reference them via related_delivery_id, and
-- that table is append-only (its rows must never be removed). Voiding instead
-- reverses the restock, records a reversing audit entry, and hides the delivery
-- from the list — mirroring how orders are cancelled, never removed.
ALTER TABLE supplier_deliveries
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN voided_by INT REFERENCES users(id);
