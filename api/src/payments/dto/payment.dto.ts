/**
 * Payment DTOs - Request and Response Objects
 * 
 * Using class-validator for runtime validation.
 * All validation happens at the controller level.
 */

import { IsNotEmpty, IsNumber, IsString, Length, Min } from 'class-validator';

/**
 * Request body for POST /payments
 */
export class CreatePaymentDto {
    /**
     * Payment amount in smallest currency unit (e.g., cents for USD).
     * Must be a positive integer.
     */
    @IsNumber()
    @Min(1, { message: 'Amount must be at least 1 (smallest currency unit)' })
    amount!: number;

    /**
     * ISO 4217 currency code (e.g., 'USD', 'EUR', 'INR').
     * Must be exactly 3 characters.
     */
    @IsString()
    @IsNotEmpty({ message: 'Currency is required' })
    @Length(3, 3, { message: 'Currency must be a 3-letter ISO 4217 code' })
    currency!: string;
}

/**
 * Payment entity as stored in the database
 */
export interface Payment {
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
 * Valid payment statuses (matches DB CHECK constraint)
 */
export type PaymentStatus =
    | 'CREATED'
    | 'PROCESSING'
    | 'SUCCESS'
    | 'FAILED'
    | 'RETRY_SCHEDULED'
    | 'DEAD_LETTERED';

/**
 * Response for POST /payments
 * Includes whether this was a new payment or an existing one
 */
export interface CreatePaymentResponse {
    payment: Payment;
    created: boolean; // true = new payment, false = idempotent return
}
