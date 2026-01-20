import { Module, Global } from '@nestjs/common';
import { RabbitMQProducer } from './rabbitmq.producer';

/**
 * RabbitMQ Module - Message Publishing
 * 
 * Global module that provides RabbitMQ access for publishing payment jobs.
 * This module does NOT include message consumption - that's the worker's job.
 */
@Global()
@Module({
    providers: [RabbitMQProducer],
    exports: [RabbitMQProducer],
})
export class RabbitMQModule { }
