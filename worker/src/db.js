/**
 * Database Client for Worker
 *
 * Provides connection pooling, transaction support,
 * and all payment-related SQL queries.
 *
 * Uses SELECT FOR UPDATE NOWAIT for payment locking.
 */

const { Pool } = require('pg');
const { log } = require('./logger');

let pool = null;

// ─── Pool lifecycle ───────────────────────────────────────────────────────────

async function initDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Verify connectivity
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    log.info('Database connection established');
  } finally {
    client.release();
  }
}

async function closeDatabase() {
  if (pool) {
    await pool.end();
    log.info('Database connection pool closed');
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

// ─── Payment queries ──────────────────────────────────────────────────────────

/**
 * Fetch and lock a payment for processing.
 * Uses SELECT FOR UPDATE NOWAIT — throws if the row is already locked.
 *
 * @param {import('pg').PoolClient} client — must be inside a transaction
 * @param {string} paymentId
 * @returns {object|null} payment row or null
 */
async function lockPaymentForProcessing(client, paymentId) {
  const result = await client.query(
    `SELECT * FROM payments WHERE id = $1 FOR UPDATE NOWAIT`,
    [paymentId]
  );
  return result.rows[0] || null;
}

/**
 * Update payment status atomically.
 * All state transitions go through this function.
 */
async function updatePaymentStatus(client, paymentId, status, updates = {}) {
  const result = await client.query(
    `UPDATE payments
     SET status = $2,
         retry_count = COALESCE($3, retry_count),
         next_retry_at = $4,
         failure_reason = $5,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      paymentId,
      status,
      updates.retry_count !== undefined ? updates.retry_count : null,
      updates.next_retry_at || null,
      updates.failure_reason || null,
    ]
  );

  if (!result.rows[0]) {
    throw new Error(`Payment not found: ${paymentId}`);
  }
  return result.rows[0];
}

/**
 * Find payments in CREATED state older than the given threshold.
 * Used by reconciliation to enqueue jobs that might have failed to reach Redis.
 *
 * @param {number} olderThanMinutes — how old the created_at must be
 */
async function findOldCreatedPayments(olderThanMinutes = 2) {
  const result = await query(
    `SELECT * FROM payments
     WHERE status = 'CREATED'
       AND created_at < NOW() - INTERVAL '1 minute' * $1
     ORDER BY created_at ASC
     LIMIT 50`,
    [olderThanMinutes]
  );
  return result.rows;
}

/**
 * Find payments stuck in PROCESSING for longer than the given threshold.
 * This happens when a worker crashes mid-processing.
 *
 * @param {number} olderThanMinutes — how old the updated_at must be
 */
async function findStuckPayments(olderThanMinutes = 2) {
  const result = await query(
    `SELECT * FROM payments
     WHERE status = 'PROCESSING'
       AND updated_at < NOW() - INTERVAL '1 minute' * $1
     ORDER BY updated_at ASC
     LIMIT 50`,
    [olderThanMinutes]
  );
  return result.rows;
}

/**
 * Reset a stuck PROCESSING payment back to CREATED so it can be re-processed.
 */
async function resetStuckPayment(client, paymentId) {
  const result = await client.query(
    `UPDATE payments
     SET status = 'CREATED',
         updated_at = NOW()
     WHERE id = $1 AND status = 'PROCESSING'
     RETURNING *`,
    [paymentId]
  );
  return result.rows[0] || null;
}

/**
 * Force a payment to DEAD_LETTERED state (used when BullMQ exhausts all attempts).
 */
async function markPaymentDeadLettered(paymentId, reason) {
  const result = await query(
    `UPDATE payments
     SET status = 'DEAD_LETTERED',
         failure_reason = $2,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [paymentId, reason]
  );
  return result.rows[0] || null;
}

module.exports = {
  initDatabase,
  closeDatabase,
  query,
  getClient,
  lockPaymentForProcessing,
  updatePaymentStatus,
  findOldCreatedPayments,
  findStuckPayments,
  resetStuckPayment,
  markPaymentDeadLettered,
};
