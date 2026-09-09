-- ADR 0019: server-authoritative optimistic concurrency for orders.
--
-- The revision is an opaque, exact-on-the-wire token. Every UPDATE advances it,
-- including item/personnel-only edits whose route touches the order row solely to
-- update updated_at. Draft autosaves and additive receipt-print records do not carry
-- a precondition, but still advance the token so the next full snapshot is current.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_order_revision()
RETURNS trigger AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-runnable and convergent whichever migration path a database arrived by.
DROP TRIGGER IF EXISTS trg_bump_order_revision ON orders;
CREATE TRIGGER trg_bump_order_revision
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION bump_order_revision();
