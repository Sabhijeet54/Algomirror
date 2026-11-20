import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type Redis from 'ioredis';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.service';
import { AuthModule } from './auth/auth.module';
import { BrokersModule } from './brokers/brokers.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RealtimeModule } from './realtime/realtime.module';
import { PrismaModule } from './common/prisma/prisma.service';
import { REDIS, RedisModule } from './common/redis/redis.module';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { ConfigModule } from './config/config.module';
import { EnquiriesModule } from './enquiries/enquiries.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/mail.service';
import { UsersModule } from './users/users.module';
import { TradingModule } from './trading/trading.module';
import { MarketDataModule } from './market-data/market-data.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        // Default: 120 requests / minute / client IP. Auth endpoints override with stricter limits.
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    AuditModule,
    EnquiriesModule,
    RealtimeModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    BrokersModule,
    MarketDataModule,
    TradingModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    // Order matters: rate limit → authenticate → authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
