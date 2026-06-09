require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function createUser() {
  const email    = process.env.NEW_USER_EMAIL;
  const password = process.env.NEW_USER_PASSWORD;
  const fullName = process.env.NEW_USER_NAME || 'Admin';
  const role     = process.env.NEW_USER_ROLE || 'admin';

  if (!email || !password) {
    console.error('Set NEW_USER_EMAIL and NEW_USER_PASSWORD before running.');
    console.error('Example (Windows):');
    console.error('  set NEW_USER_EMAIL=someone@leyblevhub.local');
    console.error('  set NEW_USER_PASSWORD=TheirPassword');
    console.error('  set NEW_USER_NAME=Their Name');
    console.error('  npm run create-user');
    process.exit(1);
  }

  if (role !== 'admin' && role !== 'viewer') {
    console.error(`NEW_USER_ROLE must be 'admin' or 'viewer' (got '${role}').`);
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const { rows: [existing] } = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existing) {
      console.log(`  ↳ User '${email}' already exists — nothing to do.`);
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await client.query(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, role`,
      [email, hash, fullName, role]
    );
    console.log(`  ✓ User created: ${user.email} (${user.full_name}, ${user.role})`);
  } catch (err) {
    console.error('Create user failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

createUser();
