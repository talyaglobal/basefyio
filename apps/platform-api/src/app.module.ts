import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { UsageTrackingMiddleware } from './common/middleware/usage-tracking.middleware';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { GuardsModule } from './common/guards/guards.module';
import { QueueModule } from './modules/queue/queue.module';
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
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { MarketingInsightsModule } from './modules/marketing-insights/marketing-insights.module';
import { DataImportModule } from './modules/data-import/data-import.module';
import { EmbeddingModule } from './modules/embedding/embedding.module';
import { SearchModule } from './modules/search/search.module';
import { RecommendationModule } from './modules/recommendation/recommendation.module';
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
    FeedbackModule,
    PgBouncerModule,
    IntegrationsModule,
    TeamIntegrationsModule,
    RedisModule,
    AiModule,
    StripeModule,
    BillingModule,
    InfrastructureModule,
    ObservabilityModule,
    RealtimeModule,
    MarketingInsightsModule,
    DataImportModule,
    EmbeddingModule,
    SearchModule,
    RecommendationModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceIdMiddleware, UsageTrackingMiddleware).forRoutes('*');
  }
}
