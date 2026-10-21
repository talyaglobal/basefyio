import { hostname } from 'os';

/**
 * One audit record as it leaves the platform.
 *
 * It carries exactly what the `audit_logs` row carries — actor, action,
 * resource, outcome, timing — and nothing the row does not: no request body,
 * no headers, no token. The DB row stays the durable record; this is the copy
 * that goes to the operator's log pipeline.
 */
export interface AuditEvent {
  /** `audit_logs.id` when the row was written; absent when the write failed. */
  id?: string;
  /** ISO 8601. */
  time: string;
  source: 'http' | 'root_action' | 'test';
  traceId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  severity: string;
  success: boolean;
  latencyMs?: number;
  method?: string;
  path?: string;
  statusCode?: number | null;
  /** Container hostname — tells replicas apart. */
  host: string;
  env: string;
  product: 'basefyio';
}

export interface AuditEventInput {
  id?: string;
  createdAt?: Date | string;
  source: AuditEvent['source'];
  traceId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  severity: string;
  success: boolean;
  latencyMs?: number;
  method?: string;
  path?: string;
  statusCode?: number | null;
}

const HOST = hostname();

export function toAuditEvent(input: AuditEventInput): AuditEvent {
  const time =
    input.createdAt instanceof Date
      ? input.createdAt.toISOString()
      : typeof input.createdAt === 'string'
        ? input.createdAt
        : new Date().toISOString();
  const event: AuditEvent = {
    time,
    source: input.source,
    traceId: input.traceId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    severity: input.severity,
    success: input.success,
    host: HOST,
    env: process.env.NODE_ENV || 'development',
    product: 'basefyio',
  };
  if (input.id) event.id = input.id;
  if (typeof input.latencyMs === 'number') event.latencyMs = input.latencyMs;
  if (input.method) event.method = input.method;
  if (input.path) event.path = input.path;
  if (input.statusCode !== undefined) event.statusCode = input.statusCode;
  return event;
}
