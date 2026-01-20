/**
 * Database Service - PostgreSQL Connection Pool
 * 
 * Manages a connection pool to PostgreSQL.
 * Provides transaction-aware query execution.
 * 
 * WHY pg directly instead of TypeORM?
 * - Explicit control over transactions
 * - No ORM magic that could hide race conditions
 * - Clear visibility into actual SQL being executed
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
    private pool!: Pool;

    async onModuleInit(): Promise<void> {
        const connectionString = process.env.DATABASE_URL;

        if (!connectionString) {
            throw new Error('DATABASE_URL environment variable is required');
        }

        this.pool = new Pool({
            connectionString,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        const client = await this.pool.connect();
        try {
            await client.query('SELECT 1');
            console.log('Database connection established');
        } finally {
            client.release();
        }
    }

    async onModuleDestroy(): Promise<void> {
        await this.pool.end();
        console.log('Database connection pool closed');
    }

    async query<T extends QueryResultRow>(text: string, params?: unknown[]) {
        return this.pool.query<T>(text, params);
    }

    async getClient(): Promise<PoolClient> {
        return this.pool.connect();
    }

    async withTransaction<T>(
        fn: (client: PoolClient) => Promise<T>
    ): Promise<T> {
        const client = await this.getClient();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}
