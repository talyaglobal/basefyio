import { AuditEvent } from '../audit-event';

/** A place audit events are shipped to. One instance per configured destination. */
export interface AuditTarget {
  readonly name: string;
  /** Human-readable destination with secrets removed (shown in the console). */
  readonly description: string;
  send(batch: AuditEvent[]): Promise<void>;
  close(): Promise<void>;
}

/** Thrown by a target when retrying the same batch cannot help (bad URL, rejected token). */
export class NonRetryableAuditError extends Error {
  readonly nonRetryable = true;
}

export function isNonRetryable(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { nonRetryable?: boolean }).nonRetryable === true;
}
