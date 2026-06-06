-- Rename role_label → remarks; also widen to TEXT for longer free-form notes.
ALTER TABLE personnel RENAME COLUMN role_label TO remarks;
ALTER TABLE personnel ALTER COLUMN remarks TYPE TEXT;
