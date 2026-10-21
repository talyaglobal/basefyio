import { AuditEvent } from './audit-event';
import { escapeSdParam, formatRfc5424, syslogSeverity } from './rfc5424';

const base: AuditEvent = {
  id: 'a1',
  time: '2026-10-20T10:00:00.000Z',
  source: 'http',
  traceId: 'trace-1',
  actorUserId: 'user-1',
  actorRole: 'USER',
  action: 'GET /api/projects',
  resourceType: 'projects',
  resourceId: null,
  severity: 'LOW',
  success: true,
  statusCode: 200,
  host: 'api-1',
  env: 'test',
  product: 'basefyio',
};

const opts = { facility: 13, appName: 'basefyio-api', procId: '42', maxBytes: 8192 };

describe('formatRfc5424', () => {
  it('builds the header in RFC 5424 order with facility 13 and informational severity', () => {
    const line = formatRfc5424(base, opts);
    expect(line.startsWith('<110>1 2026-10-20T10:00:00.000Z api-1 basefyio-api 42 audit.http [basefyio@32473 ')).toBe(true);
  });

  it('maps outcome and severity onto syslog severities', () => {
    expect(syslogSeverity({ severity: 'LOW', success: true })).toBe(6);
    expect(syslogSeverity({ severity: 'HIGH', success: true })).toBe(4);
    expect(syslogSeverity({ severity: 'LOW', success: false })).toBe(4);
    expect(syslogSeverity({ severity: 'CRITICAL', success: true })).toBe(2);
    expect(formatRfc5424({ ...base, severity: 'CRITICAL' }, opts).startsWith('<106>')).toBe(true);
    expect(formatRfc5424({ ...base, success: false, severity: 'HIGH' }, opts).startsWith('<108>')).toBe(true);
  });

  it('escapes the three SD-PARAM characters', () => {
    expect(escapeSdParam('a"b\\c]d')).toBe('a\\"b\\\\c\\]d');
    const line = formatRfc5424({ ...base, action: 'GET /x?q="a]"' }, opts);
    expect(line).toContain('action="GET /x?q=\\"a\\]\\""');
  });

  it('carries the JSON event as the message with no byte-order mark', () => {
    const line = formatRfc5424(base, opts);
    const msg = line.slice(line.indexOf('] ') + 2);
    expect(msg.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(msg)).toEqual(base);
  });

  it('truncates to the byte limit and marks the cut', () => {
    const line = formatRfc5424({ ...base, action: 'x'.repeat(2000) }, { ...opts, maxBytes: 600 });
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(600);
    expect(line.endsWith('…')).toBe(true);
  });

  it('caps a long structured-data value so the header stays bounded', () => {
    const line = formatRfc5424({ ...base, action: 'y'.repeat(5000) }, opts);
    const sd = line.slice(line.indexOf('[basefyio@32473'), line.indexOf('] ') + 1);
    expect(Buffer.byteLength(sd, 'utf8')).toBeLessThan(1024);
    expect(sd).toContain('action="yyy');
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(8192);
  });

  it('falls back to the nil structured-data value when it cannot fit the budget', () => {
    const line = formatRfc5424({ ...base, action: 'z'.repeat(400), traceId: 't'.repeat(400) }, { ...opts, maxBytes: 600 });
    expect(line.startsWith('<110>1 2026-10-20T10:00:00.000Z api-1 basefyio-api 42 audit.http - {')).toBe(true);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(600);
  });

  it('replaces an unprintable header field with the nil value', () => {
    const line = formatRfc5424({ ...base, host: '' }, opts);
    expect(line.startsWith('<110>1 2026-10-20T10:00:00.000Z - basefyio-api 42 audit.http')).toBe(true);
  });
});
