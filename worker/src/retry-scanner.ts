/**
 * Retry Scanner
 * 
 * Periodically scans for payments in RETRY_SCHEDULED state
 * that are ready to be retried (next_retry_at <= NOW).
 * 
 * This ensures retries happen even if the original message was lost.
 * Payments are republished to the queue for processing.
 */

import * as amqplib from 'amqplib';
import { findPaymentsForRetry } from './database';
import { logger } from './logger';

const PAYMENT_QUEUE = 'payment_jobs';
const SCAN_INTERVAL_MS = parseInt(process.env.RETRY_SCAN_INTERVAL_MS || '10000', 10);

let channel: amqplib.Channel | null = null;
let scanInterval: NodeJS.Timeout | null = null;
let isScanning = false;

export async function startRetryScanner(rabbitChannel: amqplib.Channel): Promise<void> {
    channel = rabbitChannel;

    logger.info(
        { interval_ms: SCAN_INTERVAL_MS },
        'Starting retry scanner'
    );

    // Run immediately, then on interval
    await scanForRetries();
    scanInterval = setInterval(scanForRetries, SCAN_INTERVAL_MS);
}

export function stopRetryScanner(): void {
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
    }
    logger.info('Retry scanner stopped');
}

async function scanForRetries(): Promise<void> {
    // Prevent overlapping scans
    if (isScanning) {
        return;
    }

    isScanning = true;

    try {
        const payments = await findPaymentsForRetry(10);

        if (payments.length === 0) {
            return;
        }

        logger.info(
            { count: payments.length },
            'Found payments ready for retry'
        );

        for (const payment of payments) {
            if (!channel) {
                break;
            }

            const message = { payment_id: payment.id };
            const buffer = Buffer.from(JSON.stringify(message));

            channel.sendToQueue(PAYMENT_QUEUE, buffer, {
                persistent: true,
            });

            logger.info(
                {
                    payment_id: payment.id,
                    retry_count: payment.retry_count
                },
                'Republished payment for retry'
            );
        }
    } catch (error) {
        logger.error({ error }, 'Error during retry scan');
    } finally {
        isScanning = false;
    }
}
