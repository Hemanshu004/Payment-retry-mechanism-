/**
 * Reconciliation Scanner
 *
 * A background task that periodically scans for payments in the CREATED
 * state that are older than a threshold (e.g., 1 minute).
 *
 * This recovers payments where the PostgreSQL transaction committed successfully,
 * but the Express API crashed or failed to reach Redis before enqueueing the BullMQ job.
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { findOldCreatedPayments } = require('./db');
const { log } = require('./logger');

const SCAN_INTERVAL_MS = 60000; // 1 minute
const OLDER_THAN_MINUTES = 1;

let connection = null;
let queue = null;
let scanInterval = null;
let isScanning = false;

async function startReconciliation() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL required for reconciliation');

  connection = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue('payment_jobs', { connection });

  log.info('Starting reconciliation scanner', { interval_ms: SCAN_INTERVAL_MS });

  await scanForUnqueuedPayments();
  scanInterval = setInterval(scanForUnqueuedPayments, SCAN_INTERVAL_MS);
}

function stopReconciliation() {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  if (queue) queue.close();
  if (connection) connection.quit();
  log.info('Reconciliation scanner stopped');
}

async function scanForUnqueuedPayments() {
  if (isScanning) return;
  isScanning = true;

  try {
    const payments = await findOldCreatedPayments(OLDER_THAN_MINUTES);
    if (payments.length === 0) return;

    log.warn('Found CREATED payments that were never processed. Re-enqueueing.', { count: payments.length });

    for (const payment of payments) {
      if (!queue) break;

      await queue.add('process_payment', { payment_id: payment.id }, {
        jobId: payment.id, // using payment.id prevents double-enqueueing
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });

      log.info('Reconciled and enqueued payment', { payment_id: payment.id });
    }
  } catch (err) {
    log.error('Error during reconciliation scan', { error: err.message });
  } finally {
    isScanning = false;
  }
}

module.exports = { startReconciliation, stopReconciliation };
