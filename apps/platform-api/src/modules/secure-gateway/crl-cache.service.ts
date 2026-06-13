import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CERTIFICATE_PROVIDER,
  CertificateProvider,
} from '../certificates/providers/certificate-provider.interface';

// ADR: CRL cache is DB-backed (status=REVOKED rows) + OpenBao CRL overlay.
// DB path catches app-level revocations. OpenBao CRL path catches out-of-band
// admin revocations (e.g. direct `vault write pki/revoke ...`).
// TTL auto-refresh uses DB only. OpenBao CRL sync runs on forceRefresh() or manual call.
// CRL path: fetchCrlSerials() → single bulk call; falls back to per-cert checkRevocation()
// when CRL is unavailable (fail-open — gateway is never blocked by OpenBao downtime).

export interface OpenBaoSyncResult {
  synced: number;
  checked: number;
}

@Injectable()
export class CrlCacheService {
  private readonly logger = new Logger(CrlCacheService.name);
  private readonly cache = new Map<string, Date>(); // certId → revokedAt
  private lastRefreshedAt = 0;
  readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CERTIFICATE_PROVIDER) private readonly certProvider: CertificateProvider,
    @Optional() ttlMs?: number,
  ) {
    this.ttlMs = ttlMs ?? 5 * 60 * 1000;
  }

  async isRevoked(certId: string): Promise<boolean> {
    await this.maybeRefresh();
    return this.cache.has(certId);
  }

  /**
   * Forces a full DB refresh + OpenBao out-of-band sync.
   * Called manually (e.g. post-admin revocation) or from health checks.
   */
  async forceRefresh(): Promise<void> {
    await this.refresh();
    await this.syncFromOpenBao().catch((err) =>
      this.logger.warn(`forceRefresh: OpenBao sync error: ${err?.message}`),
    );
  }

  /**
   * Syncs out-of-band OpenBao revocations into the local cache and Prisma.
   *
   * Strategy (CRL-first, per-cert fallback):
   *   1. Fetch the full CRL from OpenBao — one API call regardless of cert count.
   *   2. If CRL is available: cross-reference revoked serials with ACTIVE DB certs.
   *   3. If CRL unavailable (null): fall back to per-cert checkRevocation() calls.
   *
   * Both paths are fail-open: gateway is never blocked by OpenBao downtime.
   *
   * @param projectId - If provided, only checks certs for that project.
   */
  async syncFromOpenBao(projectId?: string): Promise<OpenBaoSyncResult> {
    const crlSerials = await this.certProvider.fetchCrlSerials();

    if (crlSerials !== null) {
      return this.syncViaCrl(crlSerials, projectId);
    }

    this.logger.warn('syncFromOpenBao: CRL unavailable, falling back to per-cert revocation check');
    return this.syncPerCert(projectId);
  }

  /**
   * CRL path: cross-reference a pre-fetched revoked serial set with ACTIVE DB certs.
   * O(1) OpenBao calls (CRL already fetched by caller).
   */
  private async syncViaCrl(crlSerials: string[], projectId?: string): Promise<OpenBaoSyncResult> {
    if (crlSerials.length === 0) {
      return { synced: 0, checked: 0 };
    }

    const revokedSet = new Set(crlSerials);
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (projectId) where.projectId = projectId;

    const activeCerts = await this.prisma.projectClientCertificate.findMany({
      where,
      select: { id: true, serialNumber: true },
    });

    let synced = 0;
    for (const cert of activeCerts) {
      if (!revokedSet.has(cert.serialNumber)) continue;

      const at = new Date();
      this.cache.set(cert.id, at);

      await this.prisma.projectClientCertificate
        .update({ where: { id: cert.id }, data: { status: 'REVOKED', revokedAt: at } })
        .catch((err) =>
          this.logger.warn(`syncFromOpenBao: Prisma update failed for cert ${cert.id}: ${err?.message}`),
        );

      synced++;
      this.logger.log(`syncFromOpenBao: cert ${cert.id} found revoked in CRL, cache+DB updated`);
    }

    return { synced, checked: activeCerts.length };
  }

  /**
   * Per-cert fallback path: checks each ACTIVE cert individually against OpenBao.
   * Used when the CRL endpoint is unavailable.
   */
  private async syncPerCert(projectId?: string): Promise<OpenBaoSyncResult> {
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (projectId) where.projectId = projectId;

    const activeCerts = await this.prisma.projectClientCertificate.findMany({
      where,
      select: { id: true, serialNumber: true },
    });

    const BATCH_SIZE = 10;
    let synced = 0;

    for (let i = 0; i < activeCerts.length; i += BATCH_SIZE) {
      const batch = activeCerts.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (cert) => {
          const status = await this.certProvider.checkRevocation(cert.serialNumber);
          return { cert, ...status };
        }),
      );

      for (const { cert, revoked, revokedAt } of results) {
        if (!revoked) continue;

        const at = revokedAt ?? new Date();
        this.cache.set(cert.id, at);

        await this.prisma.projectClientCertificate
          .update({ where: { id: cert.id }, data: { status: 'REVOKED', revokedAt: at } })
          .catch((err) =>
            this.logger.warn(`syncFromOpenBao: Prisma update failed for cert ${cert.id}: ${err?.message}`),
          );

        synced++;
        this.logger.log(`syncFromOpenBao: cert ${cert.id} found revoked in OpenBao, cache+DB updated`);
      }
    }

    return { synced, checked: activeCerts.length };
  }

  private async maybeRefresh(): Promise<void> {
    if (Date.now() - this.lastRefreshedAt < this.ttlMs) return;
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const rows = await this.prisma.projectClientCertificate.findMany({
      where: { status: 'REVOKED' },
      select: { id: true, revokedAt: true },
    });
    this.cache.clear();
    for (const row of rows) {
      this.cache.set(row.id, row.revokedAt ?? new Date());
    }
    this.lastRefreshedAt = Date.now();
  }
}
