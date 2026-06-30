import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsageTrackingMiddleware } from './common/middleware/usage-tracking.middleware';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { GuardsModule } from './common/guards/guards.module';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { QueueModule } from './modules/queue/queue.module';
import { EmailModule } from './modules/email/email.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeamsModule } from './modules/teams/teams.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SqlModule } from './modules/sql/sql.module';
import { StorageModule } from './modules/storage/storage.module';
import { PgBouncerModule } from './modules/pgbouncer/pgbouncer.module';
import { RedisModule } from './modules/redis/redis.module';
import { HealthController } from './modules/health/health.controller';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RealtimeDataModule } from './modules/realtime-data/realtime-data.module';
import { DataEngineModule } from './modules/data-engine/data-engine.module';
import { DataQueryModule } from './modules/data-query/data-query.module';
import { DataStructuresModule } from './modules/data-structures/data-structures.module';
import { ProvisioningModule } from './modules/provisioning/provisioning.module';
import { DrizzleModule } from './db/drizzle/drizzle.module';
import configuration from './config/configuration';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    GuardsModule,
    QueueModule,
    EmailModule,
    AuthModule,
    TeamsModule,
    ProjectsModule,
    SqlModule,
    StorageModule,
    PgBouncerModule,
    RedisModule,
    InfrastructureModule,
    ObservabilityModule,
    RealtimeModule,
    RealtimeDataModule,
    DataEngineModule,
    DataQueryModule,
    DataStructuresModule,
    ProvisioningModule,
    DrizzleModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware, UsageTrackingMiddleware).forRoutes('*');
  }
}
