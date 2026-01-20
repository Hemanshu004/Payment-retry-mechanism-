/**
 * RabbitMQ Producer Service
 * 
 * PUBLISH ONLY - This service does NOT consume messages.
 * Workers consume messages in a separate service.
 * 
 * CRITICAL: Publishing happens AFTER database commit.
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as amqplib from 'amqplib';

export const PAYMENT_QUEUE = 'payment_jobs';

export interface PaymentJobMessage {
    payment_id: string;
}

@Injectable()
export class RabbitMQProducer implements OnModuleInit, OnModuleDestroy {
    private connection: amqplib.ChannelModel | null = null;
    private channel: amqplib.Channel | null = null;

    async onModuleInit(): Promise<void> {
        const url = process.env.RABBITMQ_URL;

        if (!url) {
            throw new Error('RABBITMQ_URL environment variable is required');
        }

        this.connection = await amqplib.connect(url);
        this.channel = await this.connection.createChannel();

        await this.channel.assertQueue(PAYMENT_QUEUE, {
            durable: true,
        });

        console.log(`RabbitMQ connected, queue "${PAYMENT_QUEUE}" ready`);
    }

    async onModuleDestroy(): Promise<void> {
        if (this.channel) {
            await this.channel.close();
        }
        if (this.connection) {
            await this.connection.close();
        }
        console.log('RabbitMQ connection closed');
    }

    async publishPaymentJob(paymentId: string): Promise<void> {
        if (!this.channel) {
            throw new Error('RabbitMQ channel not initialized');
        }

        const message: PaymentJobMessage = { payment_id: paymentId };
        const buffer = Buffer.from(JSON.stringify(message));

        this.channel.sendToQueue(PAYMENT_QUEUE, buffer, {
            persistent: true,
        });

        console.log(`Published payment job: ${paymentId}`);
    }
}
