import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { EntitlementKey } from '../entitlement/entitlement-key';
import {
  CERTIFICATE_PROVIDER,
  CertBundleResult,
  CertificateProvider,
} from '../certificates/providers/certificate-provider.interface';
import {
  DATA_STORAGE_PROVIDER,
  DataStorageProvider,
  ConnectionParams,
  QueryResult,
} from './data-storage-provider.interface';
import { SecureClientFactory } from './secure-client-factory';
import { GatewayAuditService } from './gateway-audit.service';
import { QueryGuard } from './query-guard';
import { CrlCacheService } from './crl-cache.service';
import { defaultPolicy, GatewayConnectionPolicy } from './gateway-connection-policy';

// ── Public response types ─────────────────────────────────────────────────────

/** Returned by the internal getConnectionBundle() — sslKey is in-memory only, never serialised to HTTP */
export interface GatewayConnectionInfo {
  params: ConnectionParams;
  policy: GatewayConnectionPolicy;
}

/** Returned by connect() REST endpoint — NO private key material, ever */
export interface GatewayConnectResponse {
  certId: string;
  accessLevel: 'READ' | 'READ_WRITE';
  policy: GatewayConnectionPolicy;
  status: 'connected';
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class SecureGatewayService {
  private readonly logger = new Logger(SecureGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly clientFactory: SecureClientFactory,
    private readonly audit: GatewayAuditService,
    private readonly queryGuard: QueryGuard,
    private readonly crlCache: CrlCacheService,
    @Inject(CERTIFICATE_PROVIDER) private readonly certProvider: CertificateProvider,
    @Inject(DATA_STORAGE_PROVIDER) private readonly storageProvider: DataStorageProvider,
  ) {}

  // ---------------------------------------------------------------------------
  // connect() — REST API surface, returns policy WITHOUT any key material
  // ---------------------------------------------------------------------------

  async connect(
    projectId: string,
    userId: string,
    certId: string,
  ): Promise<GatewayConnectResponse> {
    try {
      await this.entitlement.assertCan(projectId, EntitlementKey.GATEWAY_CONNECT);
    } catch (err) {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'denied_entitlement' });
      throw err;
    }

    const cert = await this.prisma.projectClientCertificate.findFirst({
      where: { id: certId, projectId },
    });
    if (!cert) throw new NotFoundException('Certificate not found');

    // 5C.1 — expiry check (ACTIVE in DB but wall-clock past notAfter)
    if (cert.notAfter < new Date()) {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'cert_expired' });
      throw new ForbiddenException('Certificate has expired');
    }

    // 5C.3 — CRL cache check (DB-backed; blocks before any provider call)
    if (await this.crlCache.isRevoked(cert.id)) {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'crl_revoked' });
      throw new ForbiddenException('Certificate has been revoked');
    }

    if (cert.status !== 'ACTIVE') {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'cert_inactive' });
      throw new ForbiddenException('Certificate is not active');
    }

    // Verify OpenBao reachability — private key is fetched and immediately discarded
    try {
      await this.certProvider.getBundle(cert.openbaoKeyPath, cert.certificatePem ?? '', cert.caCertPem ?? '');
    } catch (err: any) {
      this.logger.error(`OpenBao unavailable for cert ${certId}: ${err?.message}`);
      await this.audit.logConnectionAttempt({
        projectId, userId, certId, outcome: 'openbao_unavailable', error: err?.message,
      });
      throw new ServiceUnavailableException('Certificate authority is temporarily unavailable');
    }

    const accessLevel = toAccessLevel(cert.accessLevel);
    const policy = defaultPolicy(projectId, accessLevel);

    await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'connected' });

    // ConnectionParams (including sslKey) are NEVER included in this response
    return { certId, accessLevel, policy, status: 'connected' };
  }

  // ---------------------------------------------------------------------------
  // getConnectionBundle() — INTERNAL use only (server-side mTLS connections)
  // privateKeyPem lives in params.sslKey in memory between this call and
  // storageProvider.disconnect() — never serialised, never logged, never persisted.
  // ---------------------------------------------------------------------------

  async getConnectionBundle(
    projectId: string,
    userId: string,
    certId: string,
  ): Promise<GatewayConnectionInfo> {
    try {
      await this.entitlement.assertCan(projectId, EntitlementKey.GATEWAY_CONNECT);
    } catch (err) {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'denied_entitlement' });
      throw err;
    }

    const cert = await this.prisma.projectClientCertificate.findFirst({
      where: { id: certId, projectId },
    });
    if (!cert) throw new NotFoundException('Certificate not found');

    // 5C.1 — expiry check
    if (cert.notAfter < new Date()) {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'cert_expired' });
      throw new ForbiddenException('Certificate has expired');
    }

    // 5C.3 — CRL cache check
    if (await this.crlCache.isRevoked(cert.id)) {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'crl_revoked' });
      throw new ForbiddenException('Certificate has been revoked');
    }

    if (cert.status !== 'ACTIVE') {
      await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'cert_inactive' });
      throw new ForbiddenException('Certificate is not active');
    }

    let bundle: CertBundleResult;
    try {
      bundle = await this.certProvider.getBundle(
        cert.openbaoKeyPath,
        cert.certificatePem ?? '',
        cert.caCertPem ?? '',
      );
    } catch (err: any) {
      this.logger.error(`OpenBao unavailable for cert ${certId}: ${err?.message}`);
      await this.audit.logConnectionAttempt({
        projectId, userId, certId, outcome: 'openbao_unavailable', error: err?.message,
      });
      throw new ServiceUnavailableException('Certificate authority is temporarily unavailable');
    }

    const accessLevel = toAccessLevel(cert.accessLevel);
    const policy = defaultPolicy(projectId, accessLevel);

    // sslKey (privateKeyPem) is in-memory only — cleared when params goes out of scope or disconnect() is called
    const params = this.clientFactory.buildConnectionParams(
      {
        host: process.env.GATEWAY_HOST ?? 'gateway.basefyio.internal',
        port: policy.providerType === 'secure-mongo' ? 27017 : 5432,
        database: projectId,
      },
      bundle,
    );

    await this.audit.logConnectionAttempt({ projectId, userId, certId, outcome: 'connected' });

    return { params, policy };
  }

  // ---------------------------------------------------------------------------
  // executeQuery() — enforces access level, timeout, row limit, payload size
  // ---------------------------------------------------------------------------

  async executeQuery(
    projectId: string,
    userId: string,
    certId: string,
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult> {
    await this.entitlement.assertCan(projectId, EntitlementKey.GATEWAY_QUERY);

    const cert = await this.prisma.projectClientCertificate.findFirst({
      where: { id: certId, projectId },
    });
    if (!cert) throw new NotFoundException('Certificate not found');

    const accessLevel = toAccessLevel(cert.accessLevel);
    const policy = defaultPolicy(projectId, accessLevel);

    // 5C.1 — read-write policy enforcement
    this.queryGuard.assertQueryAllowed(sql, accessLevel);

    const start = Date.now();
    let result: QueryResult;
    try {
      // 5C.2 — timeout guard
      result = await this.queryGuard.withTimeout(
        this.storageProvider.query(sql, params),
        policy.queryTimeoutMs,
      );
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      await this.audit.logQueryFailed({ projectId, userId, latencyMs, error: err?.message ?? 'unknown' });
      throw err;
    }

    // 5C.2 — payload size guard (before row capping)
    this.queryGuard.assertPayloadSize(result, policy.maxPayloadBytes);

    // 5C.2 — row limit cap
    const final = this.queryGuard.applyRowLimit(result, policy.maxRowLimit);
    const latencyMs = Date.now() - start;

    // 5C.3 — audit success
    await this.audit.logQueryExecution({
      projectId,
      userId,
      latencyMs,
      rowCount: final.rowCount,
      truncated: final.truncated,
    });

    return final;
  }

  /** Returns the per-project default connection policy (without cert context). */
  getPolicy(projectId: string): GatewayConnectionPolicy {
    return defaultPolicy(projectId);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAccessLevel(raw: unknown): 'READ' | 'READ_WRITE' {
  return String(raw) === 'READ_WRITE' ? 'READ_WRITE' : 'READ';
}
