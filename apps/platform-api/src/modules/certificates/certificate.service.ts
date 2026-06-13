import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import {
  CERTIFICATE_PROVIDER,
  CertificateProvider,
} from './providers/certificate-provider.interface';
import type { IssueCertificateDto } from './dto/issue-certificate.dto';

// ── View types ────────────────────────────────────────────────────────────────
// privateKeyPem is never included in list/get views — only in issue/bundle responses.

export interface CertificateView {
  id: string;
  projectId: string;
  subject: string;
  serialNumber: string;
  fingerprint: string;
  accessLevel: string;
  status: string;
  notBefore: Date;
  notAfter: Date;
  issuedAt: Date;
  revokedAt: Date | null;
}

export interface IssuedCertificateResponse extends CertificateView {
  /** PEM — return to client once, never persisted outside OpenBao */
  privateKeyPem: string;
  certificatePem: string;
  caCertPem: string;
}

export interface CertBundleResponse {
  certificateId: string;
  certificatePem: string;
  /** PEM — streamed from OpenBao, never persisted to app DB */
  privateKeyPem: string;
  caCertPem: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly activity: ProjectActivityService,
    @Inject(CERTIFICATE_PROVIDER) private readonly provider: CertificateProvider,
  ) {}

  // ---------------------------------------------------------------------------
  // list — no private key in response
  // ---------------------------------------------------------------------------

  async list(projectId: string, userId: string): Promise<CertificateView[]> {
    await this.assertMember(projectId, userId);

    const rows = await this.prisma.projectClientCertificate.findMany({
      where: { projectId },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        projectId: true,
        subject: true,
        serialNumber: true,
        fingerprint: true,
        accessLevel: true,
        status: true,
        notBefore: true,
        notAfter: true,
        issuedAt: true,
        revokedAt: true,
        // openbaoKeyPath and caCertPem intentionally excluded from list view
      },
    });

    // Explicitly return only the view fields — openbaoKeyPath never leaves the service
    return rows.map(({ id, projectId, subject, serialNumber, fingerprint, accessLevel, status, notBefore, notAfter, issuedAt, revokedAt }) => ({
      id, projectId, subject, serialNumber, fingerprint,
      accessLevel: String(accessLevel), status: String(status),
      notBefore, notAfter, issuedAt, revokedAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // issue — returns private key once
  // ---------------------------------------------------------------------------

  async issue(
    projectId: string,
    userId: string,
    dto: IssueCertificateDto,
  ): Promise<IssuedCertificateResponse> {
    await this.assertMember(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.EXTERNAL_DB_ACCESS);

    const accessLevel = dto.accessLevel ?? 'READ_WRITE';

    const issued = await this.provider.issue({
      projectId,
      accessLevel,
      ttlDays: dto.ttlDays ?? 365,
    });

    // Persist reference — NO private key bytes stored here
    const cert = await this.prisma.projectClientCertificate.create({
      data: {
        projectId,
        subject: issued.subject,
        serialNumber: issued.serialNumber,
        fingerprint: issued.fingerprint,
        openbaoKeyPath: issued.openbaoKeyPath,
        certificatePem: issued.certificatePem,
        caCertPem: issued.caCertPem,
        accessLevel: accessLevel as any,
        notBefore: issued.notBefore,
        notAfter: issued.notAfter,
      },
    });

    await this.recordEvent(projectId, userId, 'issue', cert.serialNumber, cert.id);
    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.CERT_ISSUED,
      title: `Certificate issued (${accessLevel})`,
      metadata: { certId: cert.id, serialNumber: cert.serialNumber },
    });

    return {
      id: cert.id,
      projectId: cert.projectId,
      subject: cert.subject,
      serialNumber: cert.serialNumber,
      fingerprint: cert.fingerprint,
      accessLevel: cert.accessLevel,
      status: cert.status,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
      issuedAt: cert.issuedAt,
      revokedAt: cert.revokedAt,
      // Private key returned here only — never stored in DB
      privateKeyPem: issued.privateKeyPem,
      certificatePem: issued.certificatePem,
      caCertPem: issued.caCertPem,
    };
  }

  // ---------------------------------------------------------------------------
  // renew — issues new cert, revokes old
  // ---------------------------------------------------------------------------

  async renew(
    projectId: string,
    userId: string,
    certId: string,
    dto: IssueCertificateDto,
  ): Promise<IssuedCertificateResponse> {
    await this.assertMember(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.EXTERNAL_DB_ACCESS);

    const old = await this.getCertOrThrow(projectId, certId);

    // Issue new first so we don't lose access on provider failure
    const newResponse = await this.issue(projectId, userId, {
      accessLevel: (dto.accessLevel ?? old.accessLevel) as 'READ' | 'READ_WRITE',
      ttlDays: dto.ttlDays,
    });

    // Revoke old
    await this.revokeInternal(projectId, userId, old.id, old.serialNumber, old.openbaoKeyPath);

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.CERT_RENEWED,
      title: 'Certificate renewed',
      metadata: { oldCertId: certId, newCertId: newResponse.id },
    });

    return newResponse;
  }

  // ---------------------------------------------------------------------------
  // revoke
  // ---------------------------------------------------------------------------

  async revoke(projectId: string, userId: string, certId: string): Promise<void> {
    await this.assertMember(projectId, userId);

    const cert = await this.getCertOrThrow(projectId, certId);
    // Idempotent: already revoked → return 204, no provider call
    if (cert.status === 'REVOKED') return;

    await this.revokeInternal(projectId, userId, cert.id, cert.serialNumber, cert.openbaoKeyPath);

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.CERT_REVOKED,
      title: 'Certificate revoked',
      metadata: { certId: cert.id, serialNumber: cert.serialNumber },
    });
  }

  // ---------------------------------------------------------------------------
  // getBundle — streams private key from OpenBao, never from DB
  // ---------------------------------------------------------------------------

  async getBundle(
    projectId: string,
    userId: string,
    certId: string,
  ): Promise<CertBundleResponse> {
    await this.assertMember(projectId, userId);
    await this.entitlement.assertCan(projectId, EntitlementKey.CERT_DOWNLOAD);

    const cert = await this.getCertOrThrow(projectId, certId);
    if (cert.status !== 'ACTIVE') {
      throw new ForbiddenException('Certificate is not active');
    }

    const bundle = await this.provider.getBundle(
      cert.openbaoKeyPath,
      cert.certificatePem ?? '',
      cert.caCertPem ?? '',
    );

    await this.recordEvent(projectId, userId, 'download', cert.serialNumber, cert.id);

    return {
      certificateId: cert.id,
      certificatePem: bundle.certificatePem,
      privateKeyPem: bundle.privateKeyPem,
      caCertPem: bundle.caCertPem,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async revokeInternal(
    projectId: string,
    userId: string,
    certId: string,
    serialNumber: string,
    openbaoKeyPath: string,
  ): Promise<void> {
    try {
      await this.provider.revoke(serialNumber);
    } catch (err: any) {
      this.logger.error(`revoke: OpenBao revocation failed for ${serialNumber}: ${err?.message}`);
      throw err;
    }

    await this.prisma.projectClientCertificate.update({
      where: { id: certId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });

    // Delete KV entry after revocation (best-effort)
    this.provider.deleteKey(openbaoKeyPath).catch((err) =>
      this.logger.warn(`deleteKey failed for ${certId}: ${err?.message}`),
    );

    await this.recordEvent(projectId, userId, 'revoke', serialNumber, certId);
  }

  private async getCertOrThrow(projectId: string, certId: string) {
    const cert = await this.prisma.projectClientCertificate.findFirst({
      where: { id: certId, projectId },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    return cert;
  }

  private async assertMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException("Not a member of this project's team");
  }

  private async recordEvent(
    projectId: string,
    userId: string,
    action: string,
    serialNumber: string,
    certId: string,
  ): Promise<void> {
    await this.prisma.certificateEvent.create({
      data: { projectId, actorUserId: userId, action, serialNumber, certificateId: certId },
    }).catch((err) =>
      this.logger.warn(`certificateEvent create failed (${action}): ${err?.message}`),
    );
  }
}
