import { Module, Global } from '@nestjs/common';
import { DatabaseService } from './database.service';

/**
 * Database Module - PostgreSQL Connection
 * 
 * Global module that provides database access throughout the application.
 * Uses raw pg driver for explicit transaction control.
 */
@Global()
@Module({
    providers: [DatabaseService],
    exports: [DatabaseService],
})
export class DatabaseModule { }
