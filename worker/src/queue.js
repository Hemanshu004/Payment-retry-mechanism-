/**
 * BullMQ Worker
 *
 * Consumes payment jobs from the Redis queue.
 *
 * CRITICAL BEHAVIORS:
 *   - Delegates processing to `processor.js`.
 *   - Listens to 'failed' event to mark DEAD_LETTERED only when all retries are exhausted.
 */

const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { log } = require('./logger');
const { processPaymentJob } = require('./processor');
const { markPaymentDeadLettered } = require('./db');

let connection = null;
let worker = null;

async function startWorker() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL environment variable is required');
  }

  // Enable TLS for managed Redis (e.g., Upstash uses rediss:// URLs)
  const redisOpts = { maxRetriesPerRequest: null };
  if (url.startsWith('rediss://')) {
    redisOpts.tls = {};
  }

  connection = new IORedis(url, redisOpts);

  const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '1', 10);

  worker = new Worker('payment_jobs', async (job) => {
    log.info('Processing payment job', { payment_id: job.data.payment_id, attempt: job.attemptsMade + 1 });
    await processPaymentJob(job);
  }, {
    connection,
    concurrency,
  });

  // Listen to failed events to handle the DEAD_LETTERED status ONLY after all retries are exhausted.
  worker.on('failed', async (job, err) => {
    log.warn('Job failed', { payment_id: job.data.payment_id, error: err.message, attempt: job.attemptsMade });
    
    if (job.attemptsMade === job.opts.attempts) {
      log.error('Job exhausted all attempts, marking as DEAD_LETTERED', { payment_id: job.data.payment_id });
      try {
        await markPaymentDeadLettered(job.data.payment_id, err.message);
      } catch (dbErr) {
        log.error('Failed to mark payment as DEAD_LETTERED', { payment_id: job.data.payment_id, error: dbErr.message });
      }
    }
  });

  worker.on('error', err => {
    log.error('BullMQ Worker error', { error: err.message });
  });

  log.info('BullMQ worker started, waiting for jobs', { concurrency });
}

async function stopWorker() {
  log.info('Stopping BullMQ worker...');
  if (worker) await worker.close();
  if (connection) await connection.quit();
  log.info('Worker stopped');
}

module.exports = { startWorker, stopWorker };
