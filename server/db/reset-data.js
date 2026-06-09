require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Every business table EXCEPT users. CASCADE resolves the foreign keys between
// these tables; users is intentionally omitted so login accounts survive.
const TABLES = [
  'activity_logs',
  'inventory_audit_logs',
  'tickets',
  'order_items',
  'order_personnel',
  'orders',
  'supplier_delivery_items',
  'supplier_deliveries',
  'customer_product_prices',
  'customers',
  'personnel',
  'products',
];

async function reset() {
  if (!process.argv.includes('--yes')) {
    console.error('This wipes ALL orders, inventory, customers, personnel, supplies,');
    console.error('tickets, and audit logs. Login accounts (users) are kept.');
    console.error('');
    console.error('Re-run with --yes to confirm:  npm run reset-data -- --yes');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    console.log('Resetting business data...');
    await client.query('BEGIN');
    await client.query(
      `TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`
    );
    await client.query('COMMIT');
    console.log(`  ✓ Cleared: ${TABLES.join(', ')}`);
    console.log('  ↳ users table preserved — your login still works.');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

reset();
