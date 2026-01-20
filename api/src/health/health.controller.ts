import { Controller, Get } from '@nestjs/common';

/**
 * Health check response interface.
 */
interface HealthResponse {
    status: 'ok';
    timestamp: string;
    service: string;
}

/**
 * Health check controller.
 * 
 * Provides a simple endpoint for Docker health checks
 * and load balancer probes.
 */
@Controller('health')
export class HealthController {
    @Get()
    check(): HealthResponse {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            service: 'payment-api',
        };
    }
}
