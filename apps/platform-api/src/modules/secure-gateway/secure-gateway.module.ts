import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { CertificateModule } from '../certificates/certificate.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { DATA_STORAGE_PROVIDER } from './data-storage-provider.interface';
import { PostgresJsonbProvider } from './providers/postgres-jsonb.provider';
import { SecurePostgresProvider } from './providers/secure-postgres.provider';
import { SecureMongoProvider } from './providers/secure-mongo.provider';
import { SecureClientFactory } from './secure-client-factory';
import { GatewayAuditService } from './gateway-audit.service';
import { QueryGuard } from './query-guard';
import { CrlCacheService } from './crl-cache.service';
import { SecureGatewayService } from './secure-gateway.service';
import { SecureGatewayController } from './secure-gateway.controller';
import { GatewayHealthController } from './gateway-health.controller';

@Module({
  imports: [PrismaModule, EntitlementModule, CertificateModule, ProjectActivityModule, ConfigModule],
  controllers: [SecureGatewayController, GatewayHealthController],
  providers: [
    PostgresJsonbProvider,
    SecurePostgresProvider,
    SecureMongoProvider,
    SecureClientFactory,
    GatewayAuditService,
    QueryGuard,
    CrlCacheService,
    SecureGatewayService,
    {
      provide: DATA_STORAGE_PROVIDER,
      inject: [ConfigService, PostgresJsonbProvider, SecurePostgresProvider, SecureMongoProvider],
      useFactory: (
        config: ConfigService,
        pg: PostgresJsonbProvider,
        securePg: SecurePostgresProvider,
        mongo: SecureMongoProvider,
      ) => {
        const type = config.get<string>('GATEWAY_STORAGE_PROVIDER') ?? 'postgres-jsonb';
        if (type === 'secure-postgres') return securePg;
        if (type === 'secure-mongo') return mongo;
        return pg;
      },
    },
  ],
  exports: [SecureGatewayService],
})
export class SecureGatewayModule {}
