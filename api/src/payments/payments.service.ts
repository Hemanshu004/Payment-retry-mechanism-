/**
 * Payments Service
 * 
 * Handles payment creation with idempotency guarantees.
 * 
 * RACE CONDITION HANDLING:
 * PostgreSQL's UNIQUE constraint on idempotency_key prevents duplicates.
 * If two identical requests arrive simultaneously, only one INSERT succeeds.
 * The other gets a UNIQUE violation and returns the existing payment.
 */

import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { QueryResultRow } from 'pg';
import { DatabaseService } from '../database';
import { RabbitMQProducer } from '../rabbitmq';
import { CreatePaymentDto, Payment, CreatePaymentResponse } from './dto';

const PG_UNIQUE_VIOLATION = '23505';

interface PaymentRow extends QueryResultRow {
    id: string;
    idempotency_key: string;
    amount: number;
    currency: string;
    status: string;
    retry_count: number;
    max_retries: number;
    next_retry_at: Date | null;
    failure_reason: string | null;
    created_at: Date;
    updated_at: Date;
}

@Injectable()
export class PaymentsService {
    constructor(
        private readonly db: DatabaseService,
        private readonly rabbitmq: RabbitMQProducer,
    ) { }

    async createPayment(
        idempotencyKey: string,
        dto: CreatePaymentDto,
    ): Promise<CreatePaymentResponse> {
        const paymentId = uuidv4();
        const client = await this.db.getClient();

        try {
            await client.query('BEGIN');

            const insertResult = await client.query<PaymentRow>(
                `INSERT INTO payments (
                    id,
                    idempotency_key,
                    amount,
                    currency,
                    status
                ) VALUES ($1, $2, $3, $4, 'CREATED')
                RETURNING *`,
                [paymentId, idempotencyKey, dto.amount, dto.currency.toUpperCase()],
            );

            await client.query('COMMIT');
            client.release();

            const payment = this.mapRowToPayment(insertResult.rows[0]);

            // CRITICAL: Publish AFTER commit
            try {
                await this.rabbitmq.publishPaymentJob(payment.id);
            } catch (publishError) {
                console.error('Failed to publish payment job:', publishError);
            }

            return { payment, created: true };
        } catch (error) {
            await client.query('ROLLBACK');
            client.release();

            if (this.isUniqueViolation(error)) {
                const existing = await this.getPaymentByIdempotencyKey(idempotencyKey);
                if (!existing) {
                    throw new Error(`Unique violation but payment not found: ${idempotencyKey}`);
                }
                return { payment: existing, created: false };
            }

            throw error;
        }
    }

    async getPaymentByIdempotencyKey(idempotencyKey: string): Promise<Payment | null> {
        const result = await this.db.query<PaymentRow>(
            'SELECT * FROM payments WHERE idempotency_key = $1',
            [idempotencyKey],
        );
        return result.rows[0] ? this.mapRowToPayment(result.rows[0]) : null;
    }

    async getPaymentById(id: string): Promise<Payment | null> {
        const result = await this.db.query<PaymentRow>(
            'SELECT * FROM payments WHERE id = $1',
            [id],
        );
        return result.rows[0] ? this.mapRowToPayment(result.rows[0]) : null;
    }

    async getAllPayments(): Promise<Payment[]> {
        const result = await this.db.query<PaymentRow>(
            'SELECT * FROM payments ORDER BY created_at DESC LIMIT 100',
        );
        return result.rows.map(row => this.mapRowToPayment(row));
    }

    private mapRowToPayment(row: PaymentRow): Payment {
        return {
            id: row.id,
            idempotency_key: row.idempotency_key,
            amount: row.amount,
            currency: row.currency,
            status: row.status as Payment['status'],
            retry_count: row.retry_count,
            max_retries: row.max_retries,
            next_retry_at: row.next_retry_at,
            failure_reason: row.failure_reason,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    private isUniqueViolation(error: unknown): boolean {
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error as { code: string }).code === PG_UNIQUE_VIOLATION
        );
    }
}
