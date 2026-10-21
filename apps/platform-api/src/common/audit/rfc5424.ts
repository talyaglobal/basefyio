import { AuditEvent } from './audit-event';

/**
 * RFC 5424 syslog formatting for audit events.
 *
 * `<PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [SD] MSG`
 *
 * The structured-data id uses enterprise number 32473, which RFC 5612 reserves
 * for examples and documentation. basefyio has no registered IANA Private
 * Enterprise Number yet; when one exists it replaces this constant and nothing
 * else changes.
 */
export const SD_ID = 'basefyio@32473';

/** Upper bound for one SD-PARAM value before escaping. */
const SD_VALUE_MAX_BYTES = 256;

export interface Rfc5424Options {
  facility: number;
  appName: string;
  procId: string;
  maxBytes: number;
}

/** RFC 5424 severity: 2 critical, 4 warning, 6 informational. */
export function syslogSeverity(event: Pick<AuditEvent, 'severity' | 'success'>): number {
  const level = String(event.severity || '').toUpperCase();
  if (level === 'CRITICAL') return 2;
  if (!event.success || level === 'HIGH') return 4;
  return 6;
}

/** SD-PARAM values escape `"`, `\` and `]` (RFC 5424 §6.3.3). */
export function escapeSdParam(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/]/g, '\\]');
}

/** PRINTUSASCII without space — HOSTNAME, APP-NAME, PROCID, MSGID fields. */
function headerField(value: string, max: number): string {
  const cleaned = value.replace(/[^\x21-\x7e]/g, '');
  return cleaned ? cleaned.slice(0, max) : '-';
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const marker = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let out = Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8');
  // A cut in the middle of a multi-byte sequence decodes to U+FFFD; drop it.
  out = out.replace(/�+$/, '');
  return out + marker;
}

export function formatRfc5424(event: AuditEvent, opts: Rfc5424Options): string {
  const pri = opts.facility * 8 + syslogSeverity(event);
  const timestamp = event.time;
  const hostname = headerField(event.host, 255);
  const appName = headerField(opts.appName, 48);
  const procId = headerField(opts.procId, 128);
  const msgId = headerField(`audit.${event.source}`, 32);

  const params: Array<[string, unknown]> = [
    ['action', event.action],
    ['actor', event.actorUserId],
    ['role', event.actorRole],
    ['resource', event.resourceType],
    ['success', event.success],
    ['severity', event.severity],
    ['trace', event.traceId],
  ];
  if (event.statusCode !== undefined && event.statusCode !== null) params.push(['status', event.statusCode]);
  if (event.resourceId) params.push(['resourceId', event.resourceId]);
  // Each value is capped before escaping so one oversized field (a long path in
  // `action`) cannot crowd the message out of the byte budget.
  const sd = `[${SD_ID} ${params
    .map(([k, v]) => `${k}="${escapeSdParam(truncateUtf8(String(v ?? ''), SD_VALUE_MAX_BYTES))}"`)
    .join(' ')}]`;

  const prefix = `<${pri}>1 ${timestamp} ${hostname} ${appName} ${procId} ${msgId} `;
  // When even the capped structured data does not fit, send the nil value; the
  // same fields are still in the JSON message.
  let header = `${prefix}${sd} `;
  if (Buffer.byteLength(header, 'utf8') > opts.maxBytes / 2) header = `${prefix}- `;
  const headerBytes = Buffer.byteLength(header, 'utf8');
  const msg = truncateUtf8(JSON.stringify(event), Math.max(0, opts.maxBytes - headerBytes));
  return truncateUtf8(header + msg, opts.maxBytes);
}
