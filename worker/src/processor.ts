/**
 * Payment Processor
 * 
 * Core logic for processing a single payment.
 * Handles the complete lifecycle:
 * 1. Lock payment (SELECT FOR UPDATE)
 * 2. Validate current state
 * 3. Move to PROCESSING
 * 4. Call mock gateway
 * 5. Update final state (SUCCESS/FAILED/RETRY_SCHEDULED/DEAD_LETTERED)
 * 
 * All database operations happen within a transaction.
 * Message ACK happens AFTER transaction commits.
 */

import { PoolClient } from 'pg';
import {
    getClient,
    lockPaymentForProcessing,
    updatePaymentStatus,
    Payment,
    PaymentStatus
} from './database';
import { processPayment, GatewayResult } from './gateway';
import { createPaymentLogger } from './logger';

// Retry configuration
const RETRY_CONFIG = {
    baseDelayMs: 1000,      // 1 second base delay
    maxDelayMs: 300000,     // 5 minutes max delay
    backoffMultiplier: 2,   // Exponential backoff
};

/**
 * Calculate next retry time using exponential backoff.
 * delay = min(maxDelay, baseDelay * (backoffMultiplier ^ retryCount))
 */
function calculateNextRetryTime(retryCount: number): Date {
    const delay = Math.min(
        RETRY_CONFIG.maxDelayMs,
        RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, retryCount)
    );
    return new Date(Date.now() + delay);
}

export interface ProcessingResult {
    success: boolean;
    shouldAck: boolean;
    finalStatus: PaymentStatus;
    error?: string;
}

/**
 * Process a payment job.
 * 
 * @param paymentId - UUID of the payment to process
 * @returns Processing result indicating whether to ACK the message
 */
export async function processPaymentJob(paymentId: string): Promise<ProcessingResult> {
    const log = createPaymentLogger(paymentId);
    let client: PoolClient | null = null;

    try {
        client = await getClient();
        await client.query('BEGIN');

        // ================================================================
        // Step 1: Lock payment for processing
        // ================================================================
        log.info('Attempting to lock payment for processing');

        let payment: Payment | null;
        try {
            payment = await lockPaymentForProcessing(client, paymentId);
        } catch (lockError) {
            // NOWAIT throws error if row is already locked
            log.warn('Payment is locked by another worker, will retry later');
            await client.query('ROLLBACK');
            return {
                success: false,
                shouldAck: false, // Requeue for retry
                finalStatus: 'CREATED',
                error: 'LOCK_CONTENTION',
            };
        }

        if (!payment) {
            log.error('Payment not found in database');
            await client.query('ROLLBACK');
            return {
                success: false,
                shouldAck: true, // ACK to remove phantom message
                finalStatus: 'CREATED',
                error: 'PAYMENT_NOT_FOUND',
            };
        }

        // ================================================================
        // Step 2: Validate current state
        // ================================================================
        log.info({ current_status: payment.status }, 'Payment locked successfully');

        // Only process if in valid starting state
        if (payment.status !== 'CREATED' && payment.status !== 'RETRY_SCHEDULED') {
            log.info(
                { status: payment.status },
                'Payment not in processable state, skipping'
            );
            await client.query('ROLLBACK');
            return {
                success: true,
                shouldAck: true, // ACK - already processed or in terminal state
                finalStatus: payment.status,
            };
        }

        // Check if this is a retry that's too early
        if (payment.status === 'RETRY_SCHEDULED' && payment.next_retry_at) {
            if (new Date() < payment.next_retry_at) {
                log.info(
                    { next_retry_at: payment.next_retry_at },
                    'Retry scheduled for later, requeuing'
                );
                await client.query('ROLLBACK');
                return {
                    success: false,
                    shouldAck: false, // Requeue
                    finalStatus: 'RETRY_SCHEDULED',
                };
            }
        }

        // ================================================================
        // Step 3: Move to PROCESSING
        // ================================================================
        log.info('Transitioning to PROCESSING state');
        await updatePaymentStatus(client, paymentId, 'PROCESSING');

        // COMMIT to persist PROCESSING state
        // This ensures state is visible even if worker crashes during gateway call
        await client.query('COMMIT');

        // ================================================================
        // Step 4: Call mock gateway (outside transaction)
        // ================================================================
        log.info('Calling payment gateway');

        let gatewayResult: GatewayResult;
        try {
            gatewayResult = await processPayment(
                paymentId,
                payment.amount,
                payment.currency
            );
        } catch (gatewayError) {
            // Treat unexpected errors as retryable
            log.error({ error: gatewayError }, 'Unexpected gateway error');
            gatewayResult = {
                type: 'RETRYABLE_ERROR',
                message: 'UNEXPECTED_ERROR',
            };
        }

        // ================================================================
        // Step 5: Persist final state
        // ================================================================
        // Start new transaction for final state update
        client = await getClient();
        await client.query('BEGIN');

        // Re-lock payment (it might have been modified)
        payment = await lockPaymentForProcessing(client, paymentId);
        if (!payment || payment.status !== 'PROCESSING') {
            log.warn('Payment state changed during processing');
            await client.query('ROLLBACK');
            return {
                success: false,
                shouldAck: true, // ACK - state was modified
                finalStatus: payment?.status || 'CREATED',
            };
        }

        let finalStatus: PaymentStatus;

        switch (gatewayResult.type) {
            case 'SUCCESS':
                finalStatus = 'SUCCESS';
                await updatePaymentStatus(client, paymentId, finalStatus);
                log.info(
                    { transaction_id: gatewayResult.transactionId },
                    'Payment successful'
                );
                break;

            case 'FATAL_ERROR':
                finalStatus = 'FAILED';
                await updatePaymentStatus(client, paymentId, finalStatus, {
                    failure_reason: gatewayResult.message,
                });
                log.error(
                    { failure_reason: gatewayResult.message },
                    'Payment failed permanently'
                );
                break;

            case 'RETRYABLE_ERROR':
                const newRetryCount = payment.retry_count + 1;

                if (newRetryCount >= payment.max_retries) {
                    // Max retries exceeded - move to dead letter
                    finalStatus = 'DEAD_LETTERED';
                    await updatePaymentStatus(client, paymentId, finalStatus, {
                        retry_count: newRetryCount,
                        failure_reason: `Max retries exceeded. Last error: ${gatewayResult.message}`,
                    });
                    log.error(
                        {
                            retry_count: newRetryCount,
                            max_retries: payment.max_retries,
                            last_error: gatewayResult.message
                        },
                        'Payment dead-lettered after max retries'
                    );
                } else {
                    // Schedule retry with exponential backoff
                    finalStatus = 'RETRY_SCHEDULED';
                    const nextRetryAt = calculateNextRetryTime(newRetryCount);

                    await updatePaymentStatus(client, paymentId, finalStatus, {
                        retry_count: newRetryCount,
                        next_retry_at: nextRetryAt,
                        failure_reason: gatewayResult.message,
                    });

                    log.warn(
                        {
                            retry_count: newRetryCount,
                            next_retry_at: nextRetryAt,
                            error: gatewayResult.message
                        },
                        'Payment scheduled for retry'
                    );
                }
                break;

            default:
                throw new Error(`Unknown gateway result type: ${gatewayResult.type}`);
        }

        // COMMIT final state
        await client.query('COMMIT');

        log.info(
            { final_status: finalStatus },
            'Payment processing complete'
        );

        return {
            success: gatewayResult.type === 'SUCCESS',
            shouldAck: true, // Always ACK after final state is persisted
            finalStatus,
        };

    } catch (error) {
        log.error({ error }, 'Error processing payment');

        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch {
                // Ignore rollback errors
            }
        }

        return {
            success: false,
            shouldAck: false, // Requeue on unexpected errors
            finalStatus: 'CREATED',
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    } finally {
        if (client) {
            client.release();
        }
    }
}
