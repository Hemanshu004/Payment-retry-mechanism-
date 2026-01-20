/**
 * Payments Controller
 * 
 * HTTP interface for payment operations.
 * 
 * This controller:
 * - Validates requests (body + headers)
 * - Enforces idempotency key requirement
 * - Returns appropriate status codes (201 for new, 200 for existing)
 * - NEVER calls payment gateway or sets status beyond CREATED
 */

import {
    Controller,
    Post,
    Get,
    Body,
    Headers,
    HttpCode,
    HttpStatus,
    BadRequestException,
    Res,
} from '@nestjs/common';
import { Response } from 'express';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto';

@Controller('payments')
export class PaymentsController {
    constructor(private readonly paymentsService: PaymentsService) { }

    /**
     * GET /payments
     * 
     * List all payments (for dashboard).
     */
    @Get()
    async listPayments() {
        const payments = await this.paymentsService.getAllPayments();
        return { payments };
    }

    /**
     * POST /payments
     * 
     * Create a new payment request.
     * 
     * Headers:
     *   Idempotency-Key: (required) Unique key provided by client
     * 
     * Body:
     *   { amount: number, currency: string }
     * 
     * Returns:
     *   201 Created     - New payment created
     *   200 OK          - Existing payment returned (idempotent)
     *   400 Bad Request - Missing header or invalid body
     *   500 Internal    - Database or other errors
     */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    async createPayment(
        @Headers('idempotency-key') idempotencyKey: string | undefined,
        @Body() dto: CreatePaymentDto,
        @Res({ passthrough: true }) res: Response,
    ) {
        if (!idempotencyKey || idempotencyKey.trim() === '') {
            throw new BadRequestException(
                'Idempotency-Key header is required'
            );
        }

        const normalizedKey = idempotencyKey.trim();

        if (!Number.isInteger(dto.amount)) {
            throw new BadRequestException(
                'Amount must be an integer (smallest currency unit)'
            );
        }

        const result = await this.paymentsService.createPayment(
            normalizedKey,
            dto,
        );

        if (result.created) {
            res.status(HttpStatus.CREATED);
        } else {
            res.status(HttpStatus.OK);
        }

        return {
            payment: result.payment,
            created: result.created,
        };
    }
}

