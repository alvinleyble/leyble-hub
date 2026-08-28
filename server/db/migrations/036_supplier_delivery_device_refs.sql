-- 036 — device-issued delivery references (ADR 0015 §8, Slice 3.3).
--
-- Logging an incoming supplier delivery now works offline. A delivery logged on a
-- blind tablet is queued in the outbox and can therefore be SENT MORE THAN ONCE: a
-- POST that commits on the server and then loses its response on the way back is
-- retried, and without an identity of its own that retry becomes a second truckload
-- of stock. This gives supplier_deliveries the same anti-duplicate mechanism orders
-- have carried since migration 033 (ADR 0006).
--
-- The column names deliberately match the orders pair. server/src/lib/idempotency.js
-- was written table-agnostic over exactly this shape and has named supplier_deliveries
-- as its second table since it was first added; adopting it here is one entry in that
-- module's whitelist rather than a second mechanism.
--
-- Purely additive, and correct standing alone: both columns are nullable with no
-- default, every existing row satisfies the CHECK with two NULLs, the partial unique
-- index covers only rows that actually carry a reference, and the previously deployed
-- server's INSERT/SELECT statements in server/src/routes/incoming.js are unaffected by
-- their presence. That matters because Render runs migrations on every deploy to the
-- one production environment, ahead of the server code that uses them (ADR 0014).

ALTER TABLE supplier_deliveries
  ADD COLUMN receipt_station  INT,
  ADD COLUMN receipt_sequence INT;

-- Wholly present or wholly absent — a half-filled pair would slip past the partial
-- unique index below.
ALTER TABLE supplier_deliveries ADD CONSTRAINT supplier_deliveries_receipt_number_complete
  CHECK ((receipt_station IS NULL) = (receipt_sequence IS NULL));

CREATE UNIQUE INDEX supplier_deliveries_receipt_number_uniq
  ON supplier_deliveries (receipt_station, receipt_sequence)
  WHERE receipt_station IS NOT NULL;

-- Display form, e.g. '1-DEL-00007'. GENERATED so it can never drift from the pair it
-- is derived from. `DEL` in the middle keeps a delivery reference from ever being
-- read as, or colliding with, a customer's receipt number — the two series are issued
-- off separate counters on the device (see client/src/offline/keys.js).
ALTER TABLE supplier_deliveries
  ADD COLUMN delivery_ref TEXT GENERATED ALWAYS AS (
    CASE
      WHEN receipt_station IS NULL THEN NULL
      ELSE receipt_station::TEXT || '-DEL-' || LPAD(receipt_sequence::TEXT, 5, '0')
    END
  ) STORED;
