import { AuditEvent } from '../audit-event';
import { WebhookTargetConfig } from '../audit-sink.config';
import { AuditTarget, NonRetryableAuditError } from './audit-target';

/**
 * Ships batches to an HTTPS endpoint.
 *
 * NDJSON (one JSON object per line) is what generic log collectors read —
 * Vector, Fluent Bit, Logstash's http input, Datadog's intake; `json` sends a
 * plain array for receivers that cannot parse NDJSON. Authentication is a
 * bearer token. Uses the Node 22 global fetch; no HTTP dependency.
 */
export class WebhookAuditTarget implements AuditTarget {
  readonly name = 'webhook';
  readonly description: string;

  constructor(
    private readonly cfg: WebhookTargetConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.description = WebhookAuditTarget.redact(cfg.url);
  }

  /** Scheme + host + path only: never the query string, where a token might sit. */
  static redact(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return 'invalid-url';
    }
  }

  async send(batch: AuditEvent[]): Promise<void> {
    if (batch.length === 0) return;
    const body =
      this.cfg.format === 'json'
        ? JSON.stringify(batch)
        : batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const headers: Record<string, string> = {
      'content-type': this.cfg.format === 'json' ? 'application/json' : 'application/x-ndjson',
      'user-agent': 'basefyio-audit-forwarder/1',
      'x-basefyio-audit-count': String(batch.length),
    };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;

    const res = await this.fetchImpl(this.cfg.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (res.ok) return;
    // 408 and 429 are the receiver asking for a retry; any other 4xx is our
    // configuration (bad path, rejected token) and retrying cannot fix it.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new NonRetryableAuditError(`webhook responded ${res.status}`);
    }
    throw new Error(`webhook responded ${res.status}`);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
