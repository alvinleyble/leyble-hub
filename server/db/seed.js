require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const isRemote = dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (isRemote || process.env.NODE_ENV === 'production') ? { rejectUnauthorized: false } : false,
});

// All prices and stock are per CASE.
// deposit_fee is the returnable-bottle deposit per case (0 if no deposit).
const PRODUCTS = [
  // ── Soft Drinks ──────────────────────────────────────────────────
  {
    name: 'Coke 1.5L', category: 'Soft Drinks', unit: 'case', sku: 'CC-15L',
    base_wholesale_price: 660.00, deposit_fee: 0.00,
    current_stock: 15, units_per_case: 12,
  },
  {
    name: 'Coke 1L', category: 'Soft Drinks', unit: 'case', sku: 'CC-1L',
    base_wholesale_price: 504.00, deposit_fee: 0.00,
    current_stock: 10, units_per_case: 12,
  },
  {
    name: 'Coke 8oz (Glass)', category: 'Soft Drinks', unit: 'case', sku: 'CC-8OZ',
    base_wholesale_price: 432.00, deposit_fee: 120.00,
    current_stock: 10, units_per_case: 24,
  },
  {
    name: 'Sprite 1.5L', category: 'Soft Drinks', unit: 'case', sku: 'SP-15L',
    base_wholesale_price: 636.00, deposit_fee: 0.00,
    current_stock: 8, units_per_case: 12,
  },
  {
    name: 'Royal Tru-Orange 1.5L', category: 'Soft Drinks', unit: 'case', sku: 'RO-15L',
    base_wholesale_price: 636.00, deposit_fee: 0.00,
    current_stock: 8, units_per_case: 12,
  },
  // ── Water ────────────────────────────────────────────────────────
  {
    name: 'Wilkins Distilled Water 1L', category: 'Water', unit: 'case', sku: 'WK-1L',
    base_wholesale_price: 204.00, deposit_fee: 0.00,
    current_stock: 8, units_per_case: 12,
  },
  {
    name: 'Viva Mineral Water 500ml', category: 'Water', unit: 'case', sku: 'VV-500',
    base_wholesale_price: 240.00, deposit_fee: 0.00,
    current_stock: 10, units_per_case: 24,
  },
  // ── Beer ─────────────────────────────────────────────────────────
  {
    name: 'San Miguel Pale Pilsen Grande (1L)', category: 'Beer', unit: 'case', sku: 'SM-GD',
    base_wholesale_price: 900.00, deposit_fee: 120.00,
    current_stock: 10, units_per_case: 12,
  },
  {
    name: 'San Miguel Pale Pilsen Small (330ml)', category: 'Beer', unit: 'case', sku: 'SM-SM',
    base_wholesale_price: 1152.00, deposit_fee: 120.00,
    current_stock: 15, units_per_case: 24,
  },
  {
    name: 'San Mig Light (330ml)', category: 'Beer', unit: 'case', sku: 'SML-330',
    base_wholesale_price: 1248.00, deposit_fee: 120.00,
    current_stock: 12, units_per_case: 24,
  },
  {
    name: 'Red Horse Beer 1L', category: 'Beer', unit: 'case', sku: 'RH-1L',
    base_wholesale_price: 960.00, deposit_fee: 120.00,
    current_stock: 10, units_per_case: 12,
  },
];

async function seedAdmin(client) {
  const email    = process.env.SEED_ADMIN_EMAIL || 'admin@leyblevhub.local';
  const password = process.env.SEED_ADMIN_PASSWORD;
  const fullName = process.env.SEED_ADMIN_NAME  || 'Admin';

  if (!password) {
    console.error('SEED_ADMIN_PASSWORD is not set in .env — aborting.');
    process.exit(1);
  }

  const { rows: [existing] } = await client.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existing) {
    console.log(`  ↳ Admin '${email}' already exists — skipping.`);
    return existing.id;
  }

  const hash = await bcrypt.hash(password, 12);
  const { rows: [user] } = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'admin')
     RETURNING id`,
    [email, hash, fullName]
  );
  console.log(`  ✓ Admin created: ${email}`);
  return user.id;
}

async function seedProducts(client, adminId) {
  let created = 0;
  let updated = 0;

  for (const p of PRODUCTS) {
    const { rows: [existing] } = await client.query(
      'SELECT id FROM products WHERE sku = $1',
      [p.sku]
    );

    if (existing) {
      // Update prices, case size, and stock so re-seeding always reflects correct values
      await client.query(
        `UPDATE products SET
           name                 = $1,
           category             = $2,
           unit                 = $3,
           base_wholesale_price = $4,
           deposit_fee          = $5,
           current_stock        = $6,
           units_per_case       = $7,
           updated_at           = NOW()
         WHERE id = $8`,
        [p.name, p.category, p.unit,
         p.base_wholesale_price, p.deposit_fee, p.current_stock,
         p.units_per_case, existing.id]
      );
      updated++;
      continue;
    }

    const { rows: [inserted] } = await client.query(
      `INSERT INTO products
         (name, category, unit, sku,
          base_wholesale_price, deposit_fee, current_stock, units_per_case)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [p.name, p.category, p.unit, p.sku,
       p.base_wholesale_price, p.deposit_fee, p.current_stock, p.units_per_case]
    );

    if (p.current_stock > 0) {
      await client.query(
        `INSERT INTO inventory_audit_logs
           (product_id, action_type, field_changed, previous_value, new_value, delta, reason, performed_by)
         VALUES ($1, 'manual_adjustment', 'current_stock', '0', $2, $3, 'Initial stock (seed)', $4)`,
        [inserted.id, String(p.current_stock), p.current_stock, adminId]
      );
    }

    created++;
  }

  console.log(`  ✓ Products: ${created} created, ${updated} updated.`);
}

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Seeding database...');
    await client.query('BEGIN');
    const adminId = await seedAdmin(client);
    await seedProducts(client, adminId);
    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
