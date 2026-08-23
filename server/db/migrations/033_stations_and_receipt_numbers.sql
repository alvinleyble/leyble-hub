-- V2.5 Release 1, piece 1 — station registry and device-issued receipt numbers (D1, D13).
--
-- Additive only. Every statement below is safe with the previously deployed server
-- still running: nothing is dropped, renamed or retyped, the new orders columns are
-- nullable with no default, and the existing INSERT/SELECT statements in
-- server/src/routes/orders.js are unaffected by their presence.
--
-- The ~1,300 existing orders are deliberately NOT backfilled. D1 accepts a one-time
-- visible discontinuity: historical orders keep displaying their plain row id, and
-- only receipts issued by a registered device from here on carry a receipt number.

-- ── Station registry ────────────────────────────────────────────────────────
-- One row per device that has completed the one-time install registration.
-- device_key is generated on the device and is the idempotency key for
-- registration, so a retried or duplicated register call returns the same station
-- instead of burning a second number.
--
-- station_number comes from a SEQUENCE rather than MAX(station_number)+1: a
-- sequence is concurrency-safe without table locking and never hands the same
-- value out twice, which is exactly D1's "numbers only creep upward, never
-- reused" invariant. A wiped device registers with a fresh device_key and so
-- receives a new station number rather than reclaiming its old one. Gaps (from a
-- rolled-back insert) are harmless and expected.
CREATE SEQUENCE station_number_seq AS INT START WITH 1;

CREATE TABLE stations (
  id             SERIAL       PRIMARY KEY,
  device_key     VARCHAR(64)  NOT NULL UNIQUE,
  station_number INT          NOT NULL UNIQUE DEFAULT nextval('station_number_seq'),
  label          VARCHAR(100),
  registered_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ
);

ALTER SEQUENCE station_number_seq OWNED BY stations.station_number;

-- ── Device-issued receipt numbers on orders ─────────────────────────────────
-- The receipt number is issued by the device at Save, online or offline, and is
-- stored decomposed so the uniqueness rule can be expressed in SQL. The display
-- form is derived, never written to.
ALTER TABLE orders
  ADD COLUMN receipt_station  INT,
  ADD COLUMN receipt_sequence INT;

-- A receipt number is either wholly present or wholly absent — a half-filled pair
-- would slip past the partial unique index below. Every existing row has both
-- columns NULL and so already satisfies this.
ALTER TABLE orders ADD CONSTRAINT orders_receipt_number_complete
  CHECK ((receipt_station IS NULL) = (receipt_sequence IS NULL));

-- D13: the receipt number is the unique identity of the receipt, and therefore the
-- anti-duplicate key for a resent outbox record.
--
-- Chosen: a PARTIAL unique index over rows that actually carry a receipt number,
-- rather than a plain UNIQUE (receipt_station, receipt_sequence) constraint.
-- Both tolerate the ~1,300 historical rows (SQL treats NULLs as distinct, so a
-- plain constraint would not have collided either), but the partial index states
-- the intent — uniqueness applies to *issued* receipt numbers only — and keeps the
-- historical rows out of the index entirely.
CREATE UNIQUE INDEX orders_receipt_number_uniq
  ON orders (receipt_station, receipt_sequence)
  WHERE receipt_station IS NOT NULL;

-- Display form, e.g. '1-00042'. GENERATED so it can never drift from the pair it
-- is derived from — the same treatment order_items.line_total already gets.
ALTER TABLE orders
  ADD COLUMN receipt_number TEXT GENERATED ALWAYS AS (
    CASE
      WHEN receipt_station IS NULL THEN NULL
      ELSE receipt_station::TEXT || '-' || LPAD(receipt_sequence::TEXT, 5, '0')
    END
  ) STORED;
