/**
 * Payment Worker Service - Entry Point
 * 
 * This is the ONLY component that processes payments.
 * The API service NEVER calls the payment gateway directly.
 * 
 * Responsibilities:
 * - Initialize database connection
 * - Connect to RabbitMQ
 * - Consume payment job messages
 * - Execute payments via mock gateway
 * - Handle retries with exponential backoff
 * - Graceful shutdown on SIGTERM/SIGINT
 */

import { logger } from './logger';
import { initDatabase, closeDatabase } from './database';
import { startConsumer, stopConsumer } from './consumer';

async function main(): Promise<void> {
    logger.info('Starting payment worker service');

    // Log configuration (redacted)
    logger.info({
        node_env: process.env.NODE_ENV ?? 'development',
        database_configured: !!process.env.DATABASE_URL,
        rabbitmq_configured: !!process.env.RABBITMQ_URL,
        worker_concurrency: process.env.WORKER_CONCURRENCY ?? '1',
    }, 'Worker configuration');

    try {
        // Initialize database
        logger.info('Initializing database connection');
        await initDatabase();

        // Start message consumer
        logger.info('Starting message consumer');
        await startConsumer();

        logger.info('Worker service started successfully');
    } catch (error) {
        logger.fatal({ error }, 'Failed to start worker service');
        process.exit(1);
    }
}

// Graceful shutdown handlers
async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');

    try {
        await stopConsumer();
        await closeDatabase();
        logger.info('Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Uncaught exception');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
});

main();
