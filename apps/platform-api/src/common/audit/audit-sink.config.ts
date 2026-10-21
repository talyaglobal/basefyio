import { ConfigService } from '@nestjs/config';

/**
 * Where audit records are forwarded, read from the environment.
 *
 * Both targets are off until their variable is set. A SIEM endpoint and its
 * bearer token are deployment secrets, so they live next to the other operator
 * secrets rather than in the database; env is also the same on every API
 * replica, and each replica forwards only the events it created.
 */
export interface WebhookTargetConfig {
  url: string;
  token?: string;
  format: 'ndjson' | 'json';
  timeoutMs: number;
}

export interface SyslogTargetConfig {
  host: string;
  port: number;
  protocol: 'udp' | 'tcp';
  facility: number;
  appName: string;
  maxBytes: number;
}

export interface AuditSinkConfig {
  webhook: WebhookTargetConfig | null;
  syslog: SyslogTargetConfig | null;
  queueMax: number;
  batchSize: number;
  flushMs: number;
  retries: number;
}

export const AUDIT_SINK_DEFAULTS = {
  queueMax: 10_000,
  batchSize: 100,
  flushMs: 2_000,
  retries: 3,
  webhookTimeoutMs: 5_000,
  syslogPort: 514,
  syslogFacility: 13, // RFC 5424: log audit
  syslogAppName: 'basefyio-api',
  syslogMaxBytes: 8_192,
} as const;

type Getter = Pick<ConfigService, 'get'>;

function str(config: Getter, key: string): string | undefined {
  const v = config.get<string>(key);
  if (v === undefined || v === null) return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
}

function int(config: Getter, key: string, fallback: number, min: number, max: number): number {
  const raw = str(config, key);
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Returns the reason a webhook URL is unusable, or null when it is fine. */
export function webhookUrlProblem(url: string, allowHttp: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'AUDIT_FORWARD_URL is not a valid URL';
  }
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && allowHttp) return null;
  return 'AUDIT_FORWARD_URL must use https (set AUDIT_FORWARD_ALLOW_HTTP=true for a local collector)';
}

export function readAuditSinkConfig(config: Getter): { config: AuditSinkConfig; problems: string[] } {
  const problems: string[] = [];

  let webhook: WebhookTargetConfig | null = null;
  const url = str(config, 'AUDIT_FORWARD_URL');
  if (url) {
    const allowHttp = str(config, 'AUDIT_FORWARD_ALLOW_HTTP') === 'true';
    const problem = webhookUrlProblem(url, allowHttp);
    if (problem) {
      problems.push(problem);
    } else {
      const format = str(config, 'AUDIT_FORWARD_FORMAT') === 'json' ? 'json' : 'ndjson';
      webhook = {
        url,
        token: str(config, 'AUDIT_FORWARD_TOKEN'),
        format,
        timeoutMs: int(config, 'AUDIT_FORWARD_TIMEOUT_MS', AUDIT_SINK_DEFAULTS.webhookTimeoutMs, 500, 60_000),
      };
    }
  }

  let syslog: SyslogTargetConfig | null = null;
  const host = str(config, 'AUDIT_SYSLOG_HOST');
  if (host) {
    const protocolRaw = (str(config, 'AUDIT_SYSLOG_PROTOCOL') || 'udp').toLowerCase();
    if (protocolRaw !== 'udp' && protocolRaw !== 'tcp') {
      problems.push('AUDIT_SYSLOG_PROTOCOL must be udp or tcp');
    } else {
      syslog = {
        host,
        port: int(config, 'AUDIT_SYSLOG_PORT', AUDIT_SINK_DEFAULTS.syslogPort, 1, 65_535),
        protocol: protocolRaw,
        facility: int(config, 'AUDIT_SYSLOG_FACILITY', AUDIT_SINK_DEFAULTS.syslogFacility, 0, 23),
        appName: str(config, 'AUDIT_SYSLOG_APP_NAME') || AUDIT_SINK_DEFAULTS.syslogAppName,
        maxBytes: int(config, 'AUDIT_SYSLOG_MAX_BYTES', AUDIT_SINK_DEFAULTS.syslogMaxBytes, 480, 65_535),
      };
    }
  }

  return {
    config: {
      webhook,
      syslog,
      queueMax: int(config, 'AUDIT_QUEUE_MAX', AUDIT_SINK_DEFAULTS.queueMax, 100, 1_000_000),
      batchSize: int(config, 'AUDIT_BATCH_SIZE', AUDIT_SINK_DEFAULTS.batchSize, 1, 5_000),
      flushMs: int(config, 'AUDIT_FLUSH_MS', AUDIT_SINK_DEFAULTS.flushMs, 100, 60_000),
      retries: int(config, 'AUDIT_RETRIES', AUDIT_SINK_DEFAULTS.retries, 0, 10),
    },
    problems,
  };
}
