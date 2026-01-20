/**
 * Database Client for Worker
 * 
 * Provides connection pooling and transaction support.
 * Uses SELECT FOR UPDATE for payment locking.
 */

import { Pool, PoolClient, QueryResultRow } from 'pg';
import { logger } from './logger';

let pool: Pool | null = null;

export async function initDatabase(): Promise<void> {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error('DATABASE_URL environment variable is required');
    }

    pool = new Pool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    // Test connection
    const client = await pool.connect();
    try {
        await client.query('SELECT 1');
        logger.info('Database connection established');
    } finally {
        client.release();
    }
}

export async function closeDatabase(): Promise<void> {
    if (pool) {
        await pool.end();
        logger.info('Database connection pool closed');
    }
}

export async function query<T extends QueryResultRow>(
    text: string,
    params?: unknown[]
) {
    if (!pool) throw new Error('Database not initialized');
    return pool.query<T>(text, params);
}

export async function getClient(): Promise<PoolClient> {
    if (!pool) throw new Error('Database not initialized');
    return pool.connect();
}

// Payment status types (matches DB CHECK constraint)
export type PaymentStatus =
    | 'CREATED'
    | 'PROCESSING'
    | 'SUCCESS'
    | 'FAILED'
    | 'RETRY_SCHEDULED'
    | 'DEAD_LETTERED';

export interface Payment extends QueryResultRow {
    id: string;
    idempotency_key: string;
    amount: number;
    currency: string;
    status: PaymentStatus;
    retry_count: number;
    max_retries: number;
    next_retry_at: Date | null;
    failure_reason: string | null;
    created_at: Date;
    updated_at: Date;
}

/**
 * Fetch and lock a payment for processing.
 * Uses SELECT FOR UPDATE to prevent concurrent processing.
 * 
 * @param client - Database client (must be in transaction)
 * @param paymentId - UUID of the payment to lock
 * @returns Payment if found and locked, null otherwise
 */
export async function lockPaymentForProcessing(
    client: PoolClient,
    paymentId: string
): Promise<Payment | null> {
    const result = await client.query<Payment>(
        `SELECT * FROM payments 
         WHERE id = $1 
         FOR UPDATE NOWAIT`,
        [paymentId]
    );
    return result.rows[0] || null;
}

/**
 * Update payment status atomically.
 * All state transitions go through this function.
 */
export async function updatePaymentStatus(
    client: PoolClient,
    paymentId: string,
    status: PaymentStatus,
    updates: {
        retry_count?: number;
        next_retry_at?: Date | null;
        failure_reason?: string | null;
    } = {}
): Promise<Payment> {
    const result = await client.query<Payment>(
        `UPDATE payments 
         SET status = $2,
             retry_count = COALESCE($3, retry_count),
             next_retry_at = $4,
             failure_reason = $5,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
            paymentId,
            status,
            updates.retry_count ?? null,
            updates.next_retry_at ?? null,
            updates.failure_reason ?? null,
        ]
    );

    if (!result.rows[0]) {
        throw new Error(`Payment not found: ${paymentId}`);
    }

    return result.rows[0];
}

/**
 * Find payments ready for retry.
 * Used by the retry scanner to pick up scheduled retries.
 */
export async function findPaymentsForRetry(limit: number = 10): Promise<Payment[]> {
    const result = await query<Payment>(
        `SELECT * FROM payments 
         WHERE status = 'RETRY_SCHEDULED' 
           AND next_retry_at <= NOW()
         ORDER BY next_retry_at ASC
         LIMIT $1`,
        [limit]
    );
    return result.rows;
}
