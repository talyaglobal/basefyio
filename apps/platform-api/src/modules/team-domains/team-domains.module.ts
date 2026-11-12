import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TeamsModule } from '../teams/teams.module';
import { TeamDomainsService } from './team-domains.service';
import { TeamDomainsController, TenantController } from './team-domains.controller';
import { TenantHostMiddleware } from './tenant-host.middleware';
import { TenantBindingInterceptor } from './tenant-binding.interceptor';
import { DatabaseAccessService } from './database-access.service';
import { DatabaseAccessController } from './database-access.controller';

/**
 * Workspace addresses (`<subdomain>.<base domain>`) and external database
 * access rules. The middleware and the interceptor only ever act on requests
 * that arrive on a workspace address; every other host is left alone.
 */
@Module({
  imports: [TeamsModule],
  controllers: [TeamDomainsController, TenantController, DatabaseAccessController],
  providers: [
    TeamDomainsService,
    DatabaseAccessService,
    TenantHostMiddleware,
    { provide: APP_INTERCEPTOR, useClass: TenantBindingInterceptor },
  ],
  exports: [TeamDomainsService],
})
export class TeamDomainsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantHostMiddleware).forRoutes('*');
  }
}
