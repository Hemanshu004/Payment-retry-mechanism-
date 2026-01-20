/**
 * RabbitMQ Consumer
 * 
 * Consumes payment job messages from the queue.
 * 
 * CRITICAL BEHAVIORS:
 * - At-least-once delivery (messages may be duplicated)
 * - Manual ACK only after DB commit
 * - NACK with requeue on processing failures
 * - Graceful shutdown on SIGTERM/SIGINT
 */

import * as amqplib from 'amqplib';
import { logger } from './logger';
import { processPaymentJob } from './processor';

const PAYMENT_QUEUE = 'payment_jobs';

interface PaymentJobMessage {
    payment_id: string;
}

let connection: amqplib.ChannelModel | null = null;
let channel: amqplib.Channel | null = null;
let isShuttingDown = false;

export async function startConsumer(): Promise<void> {
    const url = process.env.RABBITMQ_URL;

    if (!url) {
        throw new Error('RABBITMQ_URL environment variable is required');
    }

    // Connect to RabbitMQ
    connection = await amqplib.connect(url);
    channel = await connection.createChannel();

    // Ensure queue exists
    await channel.assertQueue(PAYMENT_QUEUE, {
        durable: true,
    });

    // Set prefetch to 1 - process one message at a time
    // This ensures fair distribution and prevents memory issues
    await channel.prefetch(parseInt(process.env.WORKER_CONCURRENCY || '1', 10));

    logger.info({ queue: PAYMENT_QUEUE }, 'Starting message consumer');

    // Start consuming
    await channel.consume(PAYMENT_QUEUE, async (msg) => {
        if (!msg || isShuttingDown) {
            return;
        }

        const content = msg.content.toString();
        let message: PaymentJobMessage;

        try {
            message = JSON.parse(content) as PaymentJobMessage;
        } catch (parseError) {
            logger.error({ content }, 'Invalid message format, discarding');
            channel?.ack(msg);
            return;
        }

        const log = logger.child({ payment_id: message.payment_id });
        log.info('Received payment job');

        try {
            const result = await processPaymentJob(message.payment_id);

            if (result.shouldAck) {
                // ACK - message processed successfully (or in terminal state)
                channel?.ack(msg);
                log.info(
                    { final_status: result.finalStatus },
                    'Message acknowledged'
                );
            } else {
                // NACK with requeue - will be retried
                channel?.nack(msg, false, true);
                log.warn(
                    { error: result.error },
                    'Message requeued for retry'
                );
            }
        } catch (error) {
            log.error({ error }, 'Unexpected error processing message');
            // Requeue on unexpected errors
            channel?.nack(msg, false, true);
        }
    });

    logger.info('Consumer started, waiting for messages');
}

export async function stopConsumer(): Promise<void> {
    isShuttingDown = true;
    logger.info('Stopping consumer...');

    if (channel) {
        await channel.close();
    }
    if (connection) {
        await connection.close();
    }

    logger.info('Consumer stopped');
}
