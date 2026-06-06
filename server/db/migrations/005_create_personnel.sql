-- Covers all field workers (drivers, helpers, or anyone filling either role).
-- role_label is informational only — no CHECK constraint.
-- Any personnel record may occupy driver_id or helper_id on any given order.
CREATE TABLE personnel (
  id                 SERIAL PRIMARY KEY,
  full_name          VARCHAR(255)  NOT NULL,
  role_label         VARCHAR(100),
  phone              VARCHAR(50),
  license_number     VARCHAR(100),
  id_image_base64    TEXT,
  id_image_mime_type VARCHAR(50),
  is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
