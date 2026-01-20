import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * Payments Module
 * 
 * Encapsulates payment-related functionality.
 * Depends on DatabaseModule and RabbitMQModule (global modules).
 */
@Module({
    controllers: [PaymentsController],
    providers: [PaymentsService],
    exports: [PaymentsService],
})
export class PaymentsModule { }
