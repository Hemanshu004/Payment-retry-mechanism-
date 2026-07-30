/**
 * BullMQ Queue Producer
 *
 * Configures the connection to Redis and manages the 'payment_jobs' queue.
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

let connection = null;
let queue = null;

async function initQueue() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL environment variable is required');
  }

  // Use maxRetriesPerRequest: null to allow BullMQ to handle connection blocking safely
  connection = new IORedis(url, { maxRetriesPerRequest: null });
  
  queue = new Queue('payment_jobs', { connection });
  console.log(JSON.stringify({
    level: 'info', time: new Date().toISOString(), service: 'payment-api',
    msg: 'BullMQ connected to Redis, queue "payment_jobs" ready'
  }));
}

/**
 * Enqueue a new payment job.
 * Uses the payment ID as the Job ID to prevent duplicate jobs in the queue.
 */
async function addPaymentJob(paymentId) {
  if (!queue) {
    throw new Error('BullMQ queue not initialized');
  }

  // Job is added with a specific jobId matching the postgres payment ID.
  // We configure 5 total attempts (1 initial + 4 retries) with exponential backoff.
  await queue.add('process_payment', { payment_id: paymentId }, {
    jobId: paymentId,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  });
}

async function closeQueue() {
  if (queue) await queue.close();
  if (connection) await connection.quit();
  console.log(JSON.stringify({
    level: 'info', time: new Date().toISOString(), service: 'payment-api',
    msg: 'BullMQ queue connection closed'
  }));
}

module.exports = { initQueue, addPaymentJob, closeQueue };
