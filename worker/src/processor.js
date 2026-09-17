/**
 * Payment Processor
 *
 * Core logic for processing a single payment.
 * Handles the complete lifecycle:
 *   1. Lock payment (SELECT FOR UPDATE NOWAIT)
 *   2. Validate current state
 *   3. Transition to PROCESSING  (commit so state is visible if worker crashes)
 *   4. Call mock gateway         (outside any transaction)
 *   5. Persist final state       (SUCCESS / FAILED / RETRY_SCHEDULED)
 *
 * BULLMQ INTEGRATION:
 *   - On lock contention, we delay the job using BullMQ's DelayedError so it doesn't consume a retry attempt.
 *   - On temporary gateway failure, we throw an Error. BullMQ catches this and handles exponential backoff natively.
 *   - On permanent gateway failure (or success), we DO NOT throw, allowing BullMQ to mark the job completed.
 */

const { DelayedError } = require('bullmq');
const {
  getClient,
  lockPaymentForProcessing,
  updatePaymentStatus,
  insertPaymentAttempt,
  updateProviderTransactionId,
} = require('./db');
const { processPayment } = require('./gateway');
const { createPaymentLogger } = require('./logger');

/**
 * Process a payment job.
 *
 * @param {import('bullmq').Job} job — The BullMQ job
 */
async function processPaymentJob(job) {
  const paymentId = job.data.payment_id;
  const plog = createPaymentLogger(paymentId);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1: Lock → validate → move to PROCESSING → commit
  // ══════════════════════════════════════════════════════════════════════
  let payment;

  const client1 = await getClient();
  try {
    await client1.query('BEGIN');

    // --- Lock ---
    plog.info('Attempting to lock payment for processing');
    try {
      payment = await lockPaymentForProcessing(client1, paymentId);
    } catch (lockErr) {
      plog.warn('Payment is locked by another worker, delaying job without consuming attempt');
      await client1.query('ROLLBACK');
      // Delay for 1 second and throw DelayedError to prevent using an attempt
      await job.moveToDelayed(Date.now() + 1000);
      throw new DelayedError();
    }

    if (!payment) {
      plog.error('Payment not found in database');
      await client1.query('ROLLBACK');
      return; // Complete job normally so it is removed
    }

    // --- Validate state ---
    plog.info('Payment locked successfully', { current_status: payment.status });

    if (payment.status !== 'CREATED' && payment.status !== 'RETRY_SCHEDULED') {
      plog.info('Payment not in processable state, skipping', { status: payment.status });
      await client1.query('ROLLBACK');
      return; // Complete job normally
    }

    // --- Move to PROCESSING ---
    plog.info('Transitioning to PROCESSING state');
    await updatePaymentStatus(client1, paymentId, 'PROCESSING');
    await client1.query('COMMIT');
  } catch (err) {
    try { await client1.query('ROLLBACK'); } catch (_) {}
    if (err instanceof DelayedError) throw err;
    plog.error('Error in phase 1', { error: err.message });
    throw err; // Let BullMQ retry
  } finally {
    client1.release();  // always release, no matter what
  }

  // ══════════════════════════════════════════════════════════════════════
  // GATEWAY CALL (outside any transaction / connection)
  // Pass retry_count from PostgreSQL so demo modes can make deterministic
  // decisions without relying on volatile in-memory state.
  // ══════════════════════════════════════════════════════════════════════
  plog.info('Calling payment gateway', { retry_count: payment.retry_count });

  const currentAttempt = payment.retry_count + 1; // 1-indexed attempt number

  let gatewayResult;
  try {
    gatewayResult = await processPayment(paymentId, payment.amount, payment.currency, payment.retry_count);
  } catch (gatewayErr) {
    plog.error('Unexpected gateway error', { error: gatewayErr.message });
    gatewayResult = { type: 'RETRYABLE_ERROR', message: 'UNEXPECTED_ERROR' };
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2: Persist final state
  // ══════════════════════════════════════════════════════════════════════
  const client2 = await getClient();
  try {
    await client2.query('BEGIN');

    // Re-lock (state may have been modified by another process)
    payment = await lockPaymentForProcessing(client2, paymentId);
    if (!payment || payment.status !== 'PROCESSING') {
      plog.warn('Payment state changed during processing');
      await client2.query('ROLLBACK');
      return; // Complete job normally
    }

    let finalStatus;

    // Log this attempt to payment_attempts table (inside the same transaction)
    await insertPaymentAttempt(
      client2,
      paymentId,
      currentAttempt,
      gatewayResult.type,
      gatewayResult.message,
      gatewayResult.type !== 'SUCCESS' ? gatewayResult.message : null
    );

    switch (gatewayResult.type) {
      case 'SUCCESS':
        finalStatus = 'SUCCESS';
        await updatePaymentStatus(client2, paymentId, finalStatus);
        // Persist the provider transaction ID from the gateway
        if (gatewayResult.transactionId) {
          await updateProviderTransactionId(client2, paymentId, gatewayResult.transactionId);
        }
        plog.info('Payment successful', { transaction_id: gatewayResult.transactionId, attempt: currentAttempt });
        break;

      case 'FATAL_ERROR':
        finalStatus = 'FAILED';
        await updatePaymentStatus(client2, paymentId, finalStatus, {
          failure_reason: gatewayResult.message,
        });
        plog.error('Payment failed permanently', { failure_reason: gatewayResult.message, attempt: currentAttempt });
        // DO NOT throw an error here. We want BullMQ to mark this job as completed, NOT failed.
        break;

      case 'RETRYABLE_ERROR': {
        const newRetryCount = payment.retry_count + 1;
        finalStatus = 'RETRY_SCHEDULED';
        
        await updatePaymentStatus(client2, paymentId, finalStatus, {
          retry_count: newRetryCount,
          failure_reason: gatewayResult.message,
        });
        plog.warn('Payment encountered temporary failure, delegating retry to BullMQ', {
          retry_count: newRetryCount, attempt: currentAttempt,
        });
        
        await client2.query('COMMIT');
        
        // Throw an error so BullMQ knows it failed and will apply exponential backoff.
        // If this is the last attempt, BullMQ will emit a 'failed' event which we catch in queue.js to set DEAD_LETTERED.
        throw new Error(`Gateway temporary error: ${gatewayResult.message}`);
      }

      default:
        throw new Error(`Unknown gateway result type: ${gatewayResult.type}`);
    }

    if (gatewayResult.type !== 'RETRYABLE_ERROR') {
      await client2.query('COMMIT');
    }

    plog.info('Payment processing complete', { final_status: finalStatus, attempt: currentAttempt });
  } catch (err) {
    try { await client2.query('ROLLBACK'); } catch (_) {}
    plog.error('Error in phase 2', { error: err.message });
    throw err; // Throw to trigger BullMQ retry
  } finally {
    client2.release();  // always release, no matter what
  }
}

module.exports = { processPaymentJob };
