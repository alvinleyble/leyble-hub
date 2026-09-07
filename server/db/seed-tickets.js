require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const isRemote = dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (isRemote || process.env.NODE_ENV === 'production') ? { rejectUnauthorized: false } : false,
});

async function seedTickets() {
  const client = await pool.connect();
  try {
    console.log('Checking tickets table in database...');

    // Find an active admin user to attribute ticket creation to
    const { rows: users } = await client.query(
      "SELECT id, full_name FROM users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1"
    );
    const adminUser = users[0] || { id: 1, full_name: 'Admin' };

    // Find recent orders for realistic linkages
    const { rows: orders } = await client.query(
      "SELECT id, receipt_number FROM orders WHERE receipt_number IS NOT NULL ORDER BY id DESC LIMIT 5"
    );

    // Find an active personnel if available
    const { rows: personnel } = await client.query(
      "SELECT id, full_name FROM personnel WHERE is_active = TRUE ORDER BY id LIMIT 1"
    );
    const activePersonnelId = personnel.length ? personnel[0].id : null;

    const order1 = orders[0] || null;
    const order2 = orders.length > 1 ? orders[1] : null;

    const testTickets = [
      {
        title: order1
          ? `Short payment on delivery — Order ${order1.receipt_number}`
          : 'Short payment on delivery — Order 2A-00002',
        description: 'Customer paid ₱300.00 in cash upon delivery; remaining balance of ₱135.00 to be collected on the next delivery run.',
        related_order_id: order1 ? order1.id : null,
        related_personnel_id: activePersonnelId,
        amount: -135.00,
        status: 'pending',
      },
      {
        title: order2
          ? `Bottle deposit credit adjustment — Order ${order2.receipt_number}`
          : 'Bottle deposit credit adjustment — Order 1-00112',
        description: 'Customer returned 1 case with 2 damaged bottles upon unloading at Antipolo store. Deposit fee deduction of ₱120.00 pending owner review.',
        related_order_id: order2 ? order2.id : null,
        related_personnel_id: null,
        amount: 120.00,
        status: 'pending',
      },
    ];

    let createdCount = 0;
    for (const t of testTickets) {
      const { rows: existing } = await client.query(
        'SELECT id FROM tickets WHERE title = $1',
        [t.title]
      );
      if (existing.length > 0) {
        console.log(`  ↳ Ticket '${t.title}' already exists (id: ${existing[0].id}) — skipping.`);
        continue;
      }

      await client.query('BEGIN');
      const { rows: [inserted] } = await client.query(
        `INSERT INTO tickets (title, description, related_order_id, related_personnel_id, amount, status, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING *`,
        [t.title, t.description, t.related_order_id, t.related_personnel_id, t.amount, t.status, adminUser.id]
      );

      await client.query(
        `INSERT INTO activity_logs (entity_type, entity_id, action, summary, performed_by, created_at)
         VALUES ('ticket', $1, 'created', $2, $3, NOW())`,
        [inserted.id, `Ticket '${inserted.title}' created`, adminUser.id]
      );
      await client.query('COMMIT');

      console.log(`  ✓ Created pending ticket #${inserted.id}: '${inserted.title}' (Amount: ${inserted.amount}, Order: ${inserted.related_order_id})`);
      createdCount++;
    }

    console.log(createdCount === 0 ? 'No new tickets needed.' : `\n${createdCount} ticket(s) seeded successfully.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Ticket seeding failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seedTickets();
