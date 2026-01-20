/**
 * Structured Logger using Pino
 * 
 * All logs are JSON-formatted for observability.
 * Each log includes: timestamp, level, payment_id (when applicable), message, metadata
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: isDev ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
        },
    } : undefined,
    base: {
        service: 'payment-worker',
    },
});

// Create a child logger with payment context
export function createPaymentLogger(paymentId: string) {
    return logger.child({ payment_id: paymentId });
}
