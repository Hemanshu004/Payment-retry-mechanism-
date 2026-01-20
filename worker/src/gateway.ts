/**
 * Mock Payment Gateway
 * 
 * Simulates a real payment gateway with configurable failure rates.
 * Returns different result types:
 * - SUCCESS: Payment completed
 * - RETRYABLE_ERROR: Temporary failure (network, timeout, rate limit)
 * - FATAL_ERROR: Permanent failure (invalid card, insufficient funds)
 * 
 * This is the ONLY component that "processes" payments.
 * In production, this would call Stripe/Razorpay/etc.
 */

import { logger } from './logger';

// Gateway result types
export type GatewayResultType = 'SUCCESS' | 'RETRYABLE_ERROR' | 'FATAL_ERROR';

export interface GatewayResult {
    type: GatewayResultType;
    message: string;
    transactionId?: string;
}

// Configurable failure rates (0-100)
const config = {
    successRate: parseInt(process.env.GATEWAY_SUCCESS_RATE || '70', 10),
    retryableErrorRate: parseInt(process.env.GATEWAY_RETRYABLE_RATE || '20', 10),
    // Fatal error rate = 100 - successRate - retryableErrorRate
    minLatencyMs: parseInt(process.env.GATEWAY_MIN_LATENCY || '100', 10),
    maxLatencyMs: parseInt(process.env.GATEWAY_MAX_LATENCY || '500', 10),
    timeoutRate: parseInt(process.env.GATEWAY_TIMEOUT_RATE || '5', 10),
    timeoutMs: parseInt(process.env.GATEWAY_TIMEOUT_MS || '5000', 10),
};

// Retryable error messages
const RETRYABLE_ERRORS = [
    'GATEWAY_TIMEOUT',
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'SERVICE_UNAVAILABLE',
    'TEMPORARY_FAILURE',
];

// Fatal error messages
const FATAL_ERRORS = [
    'CARD_DECLINED',
    'INSUFFICIENT_FUNDS',
    'INVALID_CARD_NUMBER',
    'EXPIRED_CARD',
    'FRAUD_DETECTED',
    'ACCOUNT_CLOSED',
];

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateTransactionId(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Process a payment through the mock gateway.
 * 
 * @param paymentId - UUID of the payment (for logging)
 * @param amount - Amount in smallest currency unit
 * @param currency - ISO 4217 currency code
 * @returns Gateway result indicating success or failure type
 */
export async function processPayment(
    paymentId: string,
    amount: number,
    currency: string
): Promise<GatewayResult> {
    const log = logger.child({
        payment_id: paymentId,
        amount,
        currency,
        component: 'mock_gateway'
    });

    log.info('Processing payment through mock gateway');

    // Simulate network latency
    const latency = randomBetween(config.minLatencyMs, config.maxLatencyMs);
    await sleep(latency);

    // Simulate timeout
    const timeoutRoll = Math.random() * 100;
    if (timeoutRoll < config.timeoutRate) {
        log.warn({ latency_ms: config.timeoutMs }, 'Gateway timeout');
        await sleep(config.timeoutMs);
        return {
            type: 'RETRYABLE_ERROR',
            message: 'GATEWAY_TIMEOUT',
        };
    }

    // Determine result based on configured rates
    const roll = Math.random() * 100;

    if (roll < config.successRate) {
        // SUCCESS
        const transactionId = generateTransactionId();
        log.info({
            transaction_id: transactionId,
            latency_ms: latency
        }, 'Payment successful');

        return {
            type: 'SUCCESS',
            message: 'Payment processed successfully',
            transactionId,
        };
    } else if (roll < config.successRate + config.retryableErrorRate) {
        // RETRYABLE ERROR
        const error = RETRYABLE_ERRORS[Math.floor(Math.random() * RETRYABLE_ERRORS.length)];
        log.warn({
            error,
            latency_ms: latency
        }, 'Retryable gateway error');

        return {
            type: 'RETRYABLE_ERROR',
            message: error,
        };
    } else {
        // FATAL ERROR
        const error = FATAL_ERRORS[Math.floor(Math.random() * FATAL_ERRORS.length)];
        log.error({
            error,
            latency_ms: latency
        }, 'Fatal gateway error');

        return {
            type: 'FATAL_ERROR',
            message: error,
        };
    }
}
