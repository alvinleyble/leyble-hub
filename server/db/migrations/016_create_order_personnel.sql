-- Replace single driver_id / helper_id columns with a join table so that
-- any number of personnel (drivers, helpers) can be assigned per order.

CREATE TABLE order_personnel (
  id           SERIAL PRIMARY KEY,
  order_id     INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  personnel_id INT NOT NULL REFERENCES personnel(id),
  role         VARCHAR(50) NOT NULL DEFAULT 'Driver',
  UNIQUE (order_id, personnel_id)
);

CREATE INDEX idx_order_personnel_order ON order_personnel (order_id);

ALTER TABLE orders DROP COLUMN driver_id;
ALTER TABLE orders DROP COLUMN helper_id;
