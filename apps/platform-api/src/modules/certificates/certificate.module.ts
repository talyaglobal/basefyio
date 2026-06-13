import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { CertificateService } from './certificate.service';
import { OpenBaoPkiProvider, OPENBAO_PKI_CONFIG } from './providers/openbao-pki.provider';
import { CERTIFICATE_PROVIDER } from './providers/certificate-provider.interface';
import { OpenBaoHealthService } from './openbao-health.service';

@Module({
  imports: [PrismaModule, EntitlementModule, ProjectActivityModule],
  providers: [
    CertificateService,
    OpenBaoPkiProvider,
    OpenBaoHealthService,
    {
      provide: OPENBAO_PKI_CONFIG,
      useFactory: () => ({
        baseUrl: process.env.OPENBAO_BASE_URL ?? 'http://localhost:8200',
        vaultToken: process.env.OPENBAO_VAULT_TOKEN ?? '',
        pkiMount: process.env.OPENBAO_PKI_MOUNT ?? 'pki',
        pkiRole: process.env.OPENBAO_PKI_ROLE ?? 'basefyio-client',
        kvMount: process.env.OPENBAO_KV_MOUNT ?? 'secret',
      }),
    },
    {
      provide: CERTIFICATE_PROVIDER,
      useExisting: OpenBaoPkiProvider,
    },
  ],
  exports: [CertificateService, CERTIFICATE_PROVIDER, OpenBaoHealthService],
})
export class CertificateModule {}
