import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database';
import { RabbitMQModule } from './rabbitmq';
import { PaymentsModule } from './payments';

/**
 * Root application module.
 * 
 * Imports:
 * - DatabaseModule: PostgreSQL connection (global)
 * - RabbitMQModule: Message queue producer (global)
 * - PaymentsModule: Payment API endpoints
 */
@Module({
    imports: [
        DatabaseModule,
        RabbitMQModule,
        PaymentsModule,
    ],
    controllers: [HealthController],
    providers: [],
})
export class AppModule { }

