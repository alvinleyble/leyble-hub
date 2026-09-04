-- 040 — the per-person device letter in a receipt number (ADR 0017).
--
-- A receipt number becomes `<person><device letter>-<sequence>`, e.g. `1A-00042`:
-- the leading number identifies the PERSON who sold it, the letter distinguishes
-- that person's own devices, and the sequence counts within that pair. Delivery
-- references take the same shape, `1A-DEL-00007` (ADR 0017 #14).
--
-- This migration is step 1 of the switchover ordering in ADR 0014's ADR-0017
-- section: the schema and the server must accept BOTH shapes before any tablet can
-- emit a letter, because tablets are updated one at a time over several days and an
-- un-updated one is still issuing `3-00061` while an updated one may still be
-- holding unsynced old-format receipts. Nothing visible changes here and no number
-- is backfilled — the ~1,300 legacy `#<id>` orders and every slot-scheme number
-- stay exactly as they are, and all three shapes coexist permanently (ADR 0017 #12).
--
-- Purely additive and correct standing alone in front of the previously deployed
-- server (Render runs migrations on every deploy, ahead of the code that uses them —
-- ADR 0014): the new column is nullable with no default, the rebuilt generated
-- expression reproduces today's value byte for byte whenever the letter is absent,
-- and the rebuilt index keeps its name so the route code that recognises its unique
-- violation is unaffected.

-- ── orders ──────────────────────────────────────────────────────────────────

ALTER TABLE orders ADD COLUMN receipt_device VARCHAR(2);

-- Letters only, and never a letter without the person number it qualifies.
ALTER TABLE orders ADD CONSTRAINT orders_receipt_device_shape
  CHECK (receipt_device IS NULL OR receipt_device ~ '^[A-Z]{1,2}$');
ALTER TABLE orders ADD CONSTRAINT orders_receipt_device_requires_station
  CHECK (receipt_device IS NULL OR receipt_station IS NOT NULL);

-- THE detail a reviewer has to actually verify rather than assume (ADR 0017,
-- Implementation Notes). Once a blank letter is possible, a plain
-- (receipt_station, receipt_device, receipt_sequence) unique index STOPS PROTECTING
-- every pre-letter row: SQL treats NULLs as distinct, so `3-00061` could be inserted
-- twice without collision and the anti-duplicate key (ADR 0006) would silently
-- vanish for the entire old format. COALESCE inside the index expression folds the
-- blank letter into a real value so those rows collide as they always did.
--
-- `NULLS NOT DISTINCT` (PostgreSQL 15+) would also work; COALESCE is chosen because
-- it is version-independent and states the intent in the index itself.
--
-- The index keeps the name migration 033 gave it: server/src/routes/orders.js reads
-- err.constraint against RECEIPT_NUMBER_INDEX to tell a duplicate receipt number
-- apart from any other unique violation.
DROP INDEX orders_receipt_number_uniq;
CREATE UNIQUE INDEX orders_receipt_number_uniq
  ON orders (receipt_station, COALESCE(receipt_device, ''), receipt_sequence)
  WHERE receipt_station IS NOT NULL;

-- The display form is GENERATED so it can never drift from the columns it derives
-- from. A generation expression cannot be altered in place before PostgreSQL 17, so
-- the column is dropped and rebuilt; the whole migration runs in one transaction
-- (server/db/migrate.js), so it is never observably absent.
--
-- With no letter this produces exactly what migration 033 produced, which is what
-- keeps every already-issued number unchanged.
ALTER TABLE orders DROP COLUMN receipt_number;
ALTER TABLE orders
  ADD COLUMN receipt_number TEXT GENERATED ALWAYS AS (
    CASE
      WHEN receipt_station IS NULL THEN NULL
      ELSE receipt_station::TEXT || COALESCE(receipt_device, '')
           || '-' || LPAD(receipt_sequence::TEXT, 5, '0')
    END
  ) STORED;

-- ── supplier_deliveries (same pair since migration 036, same treatment) ──────

ALTER TABLE supplier_deliveries ADD COLUMN receipt_device VARCHAR(2);

ALTER TABLE supplier_deliveries ADD CONSTRAINT supplier_deliveries_receipt_device_shape
  CHECK (receipt_device IS NULL OR receipt_device ~ '^[A-Z]{1,2}$');
ALTER TABLE supplier_deliveries ADD CONSTRAINT supplier_deliveries_receipt_device_requires_station
  CHECK (receipt_device IS NULL OR receipt_station IS NOT NULL);

DROP INDEX supplier_deliveries_receipt_number_uniq;
CREATE UNIQUE INDEX supplier_deliveries_receipt_number_uniq
  ON supplier_deliveries (receipt_station, COALESCE(receipt_device, ''), receipt_sequence)
  WHERE receipt_station IS NOT NULL;

ALTER TABLE supplier_deliveries DROP COLUMN delivery_ref;
ALTER TABLE supplier_deliveries
  ADD COLUMN delivery_ref TEXT GENERATED ALWAYS AS (
    CASE
      WHEN receipt_station IS NULL THEN NULL
      ELSE receipt_station::TEXT || COALESCE(receipt_device, '')
           || '-DEL-' || LPAD(receipt_sequence::TEXT, 5, '0')
    END
  ) STORED;
