/**
 * Database — PostgreSQL Connection Pool (API side)
 *
 * Thin wrapper around pg.Pool.
 * Provides query(), getClient(), and a withTransaction() helper.
 */

const { Pool } = require('pg');

let pool = null;

/**
 * Create and test the connection pool.
 * Call once at startup.
 */
async function initPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Verify connectivity
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'payment-api', msg: 'Database connection established' }));
  } finally {
    client.release();
  }
}

/**
 * Run a query against the pool (auto-acquires and releases a connection).
 */
function query(text, params) {
  if (!pool) throw new Error('Database not initialized');
  return pool.query(text, params);
}

/**
 * Check out a client for manual transaction control.
 * IMPORTANT: caller MUST call client.release() in a finally block.
 */
function getClient() {
  if (!pool) throw new Error('Database not initialized');
  return pool.connect();
}

/**
 * Shut down the pool (call on process exit).
 */
async function closePool() {
  if (pool) {
    await pool.end();
    console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'payment-api', msg: 'Database connection pool closed' }));
  }
}

module.exports = { initPool, query, getClient, closePool };
