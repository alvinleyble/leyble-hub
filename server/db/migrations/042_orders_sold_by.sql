-- 042 — who sold it, on the order itself (ADR 0017 #10).
--
-- The receipt prints `Sold by: Luis` alongside the number. That is the EXIT RAMP the
-- decision names: once the seller's name is on the paper in words, the person digit
-- leading the receipt number is an optional convenience rather than the only record of
-- who made the sale.
--
-- Until now the seller was recorded only in `activity_logs.performed_by`, which is an
-- append-only change feed — reachable, but not by a receipt being printed from a
-- device that may never have been online since the sale. So the order carries the
-- seller itself, exactly like the two `*_receipt_printed_by` columns beside it.
--
-- Purely additive and correct standing alone in front of the previously deployed
-- server (Render runs migrations on every deploy, ahead of the code that uses them —
-- ADR 0014): nullable, no default, no backfill. Every pre-042 order keeps a NULL and
-- simply prints no `Sold by:` line, the same no-backfill rule receipt numbers
-- themselves live under (ADR 0017 #12). Historical attribution is unaffected —
-- `activity_logs` remains the record for orders created before this column existed.
--
-- Guarded so a second run is a no-op, per the rule migration 040 learned the hard way.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id);

-- ADR 0017 #11 — order search accepts BARE DIGITS: typing `42` must return every order
-- whose sequence is 42, across all prefixes. That is an equality on `receipt_sequence`
-- alone, which the receipt-number unique index cannot serve (it leads with
-- `receipt_station`). Partial, because the ~1,300 legacy orders carry no sequence at
-- all and are found by row id instead.
CREATE INDEX IF NOT EXISTS idx_orders_receipt_sequence
  ON orders (receipt_sequence)
  WHERE receipt_sequence IS NOT NULL;
