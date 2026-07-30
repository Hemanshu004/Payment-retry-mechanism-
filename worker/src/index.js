/**
 * Payment Worker — Entry Point
 *
 * This is the ONLY component that processes payments.
 * The API service NEVER calls the payment gateway directly.
 *
 * Startup sequence:
 *   1. Connect to PostgreSQL
 *   2. Recover payments stuck in PROCESSING (from a previous crash)
 *   3. Connect to RabbitMQ and start consuming
 *   4. Start the retry scanner (re-publishes RETRY_SCHEDULED payments)
 *
 * Graceful shutdown on SIGTERM / SIGINT.
 */

const { log } = require('./logger');
const { initDatabase, closeDatabase, getClient, findStuckPayments, resetStuckPayment } = require('./db');
const { startWorker, stopWorker } = require('./queue');
const { startReconciliation, stopReconciliation } = require('./reconciliation');

// ─── Stuck-payment recovery ──────────────────────────────────────────────────

/**
 * Find payments stuck in PROCESSING (from a crashed worker) and reset them
 * to CREATED so they can be re-processed.
 *
 * NOTE: For this mock project, resetting to CREATED is acceptable.
 * In a real production system, you MUST query the external payment gateway
 * using the idempotency_key to determine if the transaction succeeded or failed,
 * rather than blindly resetting and retrying it.
 */
async function recoverStuckPayments() {
  const stuck = await findStuckPayments(2); // older than 2 minutes
  if (stuck.length === 0) {
    log.info('No stuck payments found');
    return;
  }

  log.warn('Found stuck payments, recovering', { count: stuck.length });

  for (const payment of stuck) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const recovered = await resetStuckPayment(client, payment.id);
      await client.query('COMMIT');

      if (recovered) {
        log.info('Recovered stuck payment', { payment_id: payment.id });
      }
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      log.error('Failed to recover stuck payment', {
        payment_id: payment.id, error: err.message,
      });
    } finally {
      client.release();
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log.info('Starting payment worker service');

  log.info('Worker configuration', {
    node_env: process.env.NODE_ENV || 'development',
    database_configured: !!process.env.DATABASE_URL,
    redis_configured: !!process.env.REDIS_URL,
    worker_concurrency: process.env.WORKER_CONCURRENCY || '1',
  });

  // 1. Database
  log.info('Initializing database connection');
  await initDatabase();

  // 2. Recover stuck payments from a previous crash
  log.info('Checking for stuck payments');
  await recoverStuckPayments();

  // 3. Start the BullMQ worker
  log.info('Starting BullMQ worker');
  await startWorker();

  // 4. Start the reconciliation scanner
  log.info('Starting reconciliation scanner');
  await startReconciliation();

  log.info('Worker service started successfully');
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down`);

  try {
    stopReconciliation();
    await stopWorker();
    await closeDatabase();
    log.info('Graceful shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.fatal('Unhandled rejection', { reason: String(reason) });
  process.exit(1);
});

main().catch((err) => {
  log.fatal('Failed to start worker service', { error: err.message });
  process.exit(1);
});
