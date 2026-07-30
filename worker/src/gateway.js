/**
 * Mock Payment Gateway
 *
 * Simulates a real payment gateway with configurable failure rates.
 * Returns one of three result types:
 *   - SUCCESS          — payment completed
 *   - RETRYABLE_ERROR  — temporary failure (network, timeout, rate limit)
 *   - FATAL_ERROR      — permanent failure (invalid card, insufficient funds)
 *
 * In production this would call Stripe / Razorpay / etc.
 */

const { log } = require('./logger');

// Configurable rates (0–100)
const config = {
  successRate:        parseInt(process.env.GATEWAY_SUCCESS_RATE   || '70', 10),
  retryableErrorRate: parseInt(process.env.GATEWAY_RETRYABLE_RATE || '20', 10),
  minLatencyMs:       parseInt(process.env.GATEWAY_MIN_LATENCY    || '100', 10),
  maxLatencyMs:       parseInt(process.env.GATEWAY_MAX_LATENCY    || '500', 10),
  timeoutRate:        parseInt(process.env.GATEWAY_TIMEOUT_RATE   || '5', 10),
  timeoutMs:          parseInt(process.env.GATEWAY_TIMEOUT_MS     || '5000', 10),
};

const RETRYABLE_ERRORS = [
  'GATEWAY_TIMEOUT',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'SERVICE_UNAVAILABLE',
  'TEMPORARY_FAILURE',
];

const FATAL_ERRORS = [
  'CARD_DECLINED',
  'INSUFFICIENT_FUNDS',
  'INVALID_CARD_NUMBER',
  'EXPIRED_CARD',
  'FRAUD_DETECTED',
  'ACCOUNT_CLOSED',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateTransactionId() {
  return `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Process a payment through the mock gateway.
 *
 * DETERMINISTIC TESTING OVERRIDES:
 * If amount == 101, always SUCCESS
 * If amount == 102, always RETRYABLE_ERROR (temporary)
 * If amount == 103, always FATAL_ERROR (permanent)
 *
 * @param {string} paymentId — UUID (for logging)
 * @param {number} amount    — amount in smallest currency unit
 * @param {string} currency  — ISO 4217 code
 * @returns {Promise<{type: string, message: string, transactionId?: string}>}
 */
async function processPayment(paymentId, amount, currency) {
  log.info('Processing payment through mock gateway', {
    payment_id: paymentId, amount, currency, component: 'mock_gateway',
  });

  // Simulate network latency
  const latency = randomBetween(config.minLatencyMs, config.maxLatencyMs);
  await sleep(latency);

  // Deterministic outcomes for testing
  if (amount === 101) {
    const transactionId = generateTransactionId();
    log.info('Payment successful (deterministic)', { payment_id: paymentId, transaction_id: transactionId, latency_ms: latency });
    return { type: 'SUCCESS', message: 'Payment processed successfully', transactionId };
  }
  if (amount === 102) {
    log.warn('Retryable gateway error (deterministic)', { payment_id: paymentId, error: 'TEMPORARY_FAILURE', latency_ms: latency });
    return { type: 'RETRYABLE_ERROR', message: 'TEMPORARY_FAILURE' };
  }
  if (amount === 103) {
    log.error('Fatal gateway error (deterministic)', { payment_id: paymentId, error: 'CARD_DECLINED', latency_ms: latency });
    return { type: 'FATAL_ERROR', message: 'CARD_DECLINED' };
  }

  // Simulate timeout
  if (Math.random() * 100 < config.timeoutRate) {
    log.warn('Gateway timeout', { payment_id: paymentId, latency_ms: config.timeoutMs });
    await sleep(config.timeoutMs);
    return { type: 'RETRYABLE_ERROR', message: 'GATEWAY_TIMEOUT' };
  }

  // Determine result
  const roll = Math.random() * 100;

  if (roll < config.successRate) {
    const transactionId = generateTransactionId();
    log.info('Payment successful', {
      payment_id: paymentId, transaction_id: transactionId, latency_ms: latency,
    });
    return { type: 'SUCCESS', message: 'Payment processed successfully', transactionId };
  }

  if (roll < config.successRate + config.retryableErrorRate) {
    const error = RETRYABLE_ERRORS[Math.floor(Math.random() * RETRYABLE_ERRORS.length)];
    log.warn('Retryable gateway error', { payment_id: paymentId, error, latency_ms: latency });
    return { type: 'RETRYABLE_ERROR', message: error };
  }

  const error = FATAL_ERRORS[Math.floor(Math.random() * FATAL_ERRORS.length)];
  log.error('Fatal gateway error', { payment_id: paymentId, error, latency_ms: latency });
  return { type: 'FATAL_ERROR', message: error };
}

module.exports = { processPayment };
