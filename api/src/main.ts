import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';

/**
 * Bootstrap the NestJS application.
 * 
 * This is the API service entry point. It accepts HTTP requests
 * but NEVER processes payments directly - that's the worker's job.
 */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);

    // Enable CORS for frontend
    app.enableCors();

    // Serve static files from /public
    app.useStaticAssets(join(__dirname, 'public'));

    // Enable validation pipe for DTO validation
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: {
                enableImplicitConversion: true,
            },
        }),
    );

    const port = process.env.API_PORT ?? 3000;

    await app.listen(port);

    console.log(`API service started on port ${port}`);
    console.log(`Dashboard available at http://localhost:${port}`);
}

bootstrap().catch((error: Error) => {
    console.error('Failed to start API service:', error);
    process.exit(1);
});
