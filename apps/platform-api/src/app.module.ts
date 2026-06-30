import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsageTrackingMiddleware } from './common/middleware/usage-tracking.middleware';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { GuardsModule } from './common/guards/guards.module';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { QueueModule } from './modules/queue/queue.module';
import { EntitlementModule } from './modules/entitlement/entitlement.module';
import { FlowsModule } from './modules/flows/flows.module';
import { EmailModule } from './modules/email/email.module';
import { AuthModule } from './modules/auth/auth.module';
import { TeamsModule } from './modules/teams/teams.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SqlModule } from './modules/sql/sql.module';
import { StorageModule } from './modules/storage/storage.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { PgBouncerModule } from './modules/pgbouncer/pgbouncer.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { TeamIntegrationsModule } from './modules/team-integrations/team-integrations.module';
import { RedisModule } from './modules/redis/redis.module';
import { AiModule } from './modules/ai/ai.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { BillingModule } from './modules/billing/billing.module';
import { QuickbooksModule } from './modules/quickbooks/quickbooks.module';
import { ManagementModule } from './modules/management/management.module';
import { HealthController } from './modules/health/health.controller';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RealtimeDataModule } from './modules/realtime-data/realtime-data.module';
import { MarketingInsightsModule } from './modules/marketing-insights/marketing-insights.module';
import { DataImportModule } from './modules/data-import/data-import.module';
import { EmbeddingModule } from './modules/embedding/embedding.module';
import { SearchModule } from './modules/search/search.module';
import { RecommendationModule } from './modules/recommendation/recommendation.module';
import { TenantEmbeddingModule } from './modules/tenant-embedding/tenant-embedding.module';
import { DataEngineModule } from './modules/data-engine/data-engine.module';
import { DataQueryModule } from './modules/data-query/data-query.module';
import { DataStructuresModule } from './modules/data-structures/data-structures.module';
import { ProvisioningModule } from './modules/provisioning/provisioning.module';
import { DrizzleModule } from './db/drizzle/drizzle.module';
import { RagModule } from './modules/rag/rag.module';
import { AgentModule } from './modules/agent/agent.module';
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
    EntitlementModule,
    FlowsModule,
    EmailModule,
    AuthModule,
    TeamsModule,
    ProjectsModule,
    SqlModule,
    StorageModule,
    FeedbackModule,
    PgBouncerModule,
    IntegrationsModule,
    TeamIntegrationsModule,
    RedisModule,
    AiModule,
    StripeModule,
    BillingModule,
    QuickbooksModule,
    ManagementModule,
    InfrastructureModule,
    ObservabilityModule,
    RealtimeModule,
    RealtimeDataModule,
    MarketingInsightsModule,
    DataImportModule,
    EmbeddingModule,
    SearchModule,
    RecommendationModule,
    TenantEmbeddingModule,
    DataEngineModule,
    DataQueryModule,
    DataStructuresModule,
    ProvisioningModule,
    DrizzleModule,
    RagModule,
    AgentModule,
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
