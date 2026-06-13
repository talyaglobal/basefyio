import { Injectable } from '@nestjs/common';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';

export type GatewayConnectOutcome =
  | 'connected'
  | 'denied_entitlement'
  | 'cert_inactive'
  | 'cert_expired'         // 5C.1: ACTIVE cert past notAfter
  | 'crl_revoked'          // 5C.3: blocked by in-memory CRL cache before provider call
  | 'openbao_unavailable'; // kept as 503 safe failure

@Injectable()
export class GatewayAuditService {
  constructor(private readonly activity: ProjectActivityService) {}

  async logConnectionAttempt(params: {
    projectId: string;
    userId: string;
    certId: string;
    outcome: GatewayConnectOutcome;
    error?: string;
  }): Promise<void> {
    const kind =
      params.outcome === 'connected'
        ? ProjectActivityKind.GATEWAY_CONNECTED
        : ProjectActivityKind.GATEWAY_CONNECT_DENIED;

    await this.activity
      .append(params.projectId, {
        userId: params.userId,
        kind,
        title:
          params.outcome === 'connected'
            ? 'Gateway connection established'
            : `Gateway connection denied (${params.outcome})`,
        metadata: {
          certId: params.certId,
          outcome: params.outcome,
          // error message only — never log private key bytes
          ...(params.error ? { error: params.error } : {}),
        },
      })
      .catch(() => {});
  }

  async logQueryExecution(params: {
    projectId: string;
    userId: string;
    latencyMs: number;
    rowCount?: number;
    truncated?: boolean;
  }): Promise<void> {
    await this.activity
      .append(params.projectId, {
        userId: params.userId,
        kind: ProjectActivityKind.GATEWAY_QUERY_EXECUTED,
        title: 'Gateway query executed',
        metadata: {
          latencyMs: params.latencyMs,
          ...(params.rowCount !== undefined ? { rowCount: params.rowCount } : {}),
          ...(params.truncated ? { truncated: true } : {}),
        },
      })
      .catch(() => {});
  }

  async logQueryFailed(params: {
    projectId: string;
    userId: string;
    latencyMs: number;
    error: string;
  }): Promise<void> {
    await this.activity
      .append(params.projectId, {
        userId: params.userId,
        kind: ProjectActivityKind.GATEWAY_CONNECT_DENIED,
        title: 'Gateway query failed',
        // error message only — never include SQL params or row data
        metadata: { latencyMs: params.latencyMs, error: params.error },
      })
      .catch(() => {});
  }
}
