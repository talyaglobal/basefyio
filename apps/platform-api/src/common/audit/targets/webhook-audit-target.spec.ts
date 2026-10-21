import { AuditEvent } from '../audit-event';
import { isNonRetryable } from './audit-target';
import { WebhookAuditTarget } from './webhook-audit-target';

const ev = (n: number): AuditEvent => ({
  time: '2026-10-20T10:00:00.000Z',
  source: 'http',
  traceId: `t${n}`,
  actorUserId: 'u',
  actorRole: 'USER',
  action: 'GET /x',
  resourceType: 'x',
  resourceId: null,
  severity: 'LOW',
  success: true,
  host: 'h',
  env: 'test',
  product: 'basefyio',
});

const cfg = { url: 'https://siem.example/ingest?token=secret', token: 'tok', format: 'ndjson' as const, timeoutMs: 1000 };
type FetchCall = [string, RequestInit];
/** A fetch double that records (url, init) and answers with the given response. */
const mockFetch = (res: { ok: boolean; status: number }) =>
  jest.fn((_url: string, _init: RequestInit) => Promise.resolve(res as Response));
const ok = { ok: true, status: 200 };
const status = (code: number) => ({ ok: false, status: code });

describe('WebhookAuditTarget', () => {
  it('posts NDJSON, one event per line, with the bearer token', async () => {
    const fetchMock = mockFetch(ok);
    const target = new WebhookAuditTarget(cfg, fetchMock as unknown as typeof fetch);
    await target.send([ev(1), ev(2)]);
    const [url, init] = fetchMock.mock.calls[0] as FetchCall;
    expect(url).toBe(cfg.url);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-ndjson');
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['x-basefyio-audit-count']).toBe('2');
    const lines = String(init.body).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toEqual(ev(1));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the authorization header when no token is configured', async () => {
    const fetchMock = mockFetch(ok);
    const target = new WebhookAuditTarget({ ...cfg, token: undefined }, fetchMock as unknown as typeof fetch);
    await target.send([ev(1)]);
    const [, init] = fetchMock.mock.calls[0] as FetchCall;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends a JSON array when the format is json', async () => {
    const fetchMock = mockFetch(ok);
    const target = new WebhookAuditTarget({ ...cfg, format: 'json' }, fetchMock as unknown as typeof fetch);
    await target.send([ev(1), ev(2)]);
    const [, init] = fetchMock.mock.calls[0] as FetchCall;
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual([ev(1), ev(2)]);
  });

  it('treats a 5xx as retryable and a 4xx as not', async () => {
    const failWith = async (code: number) => {
      const target = new WebhookAuditTarget(cfg, mockFetch(status(code)) as unknown as typeof fetch);
      return target.send([ev(1)]).then(
        () => null,
        (e: unknown) => e,
      );
    };
    const e500 = await failWith(500);
    expect(e500).toBeInstanceOf(Error);
    expect(isNonRetryable(e500)).toBe(false);
    const e403 = await failWith(403);
    expect(isNonRetryable(e403)).toBe(true);
    const e429 = await failWith(429);
    expect(e429).toBeInstanceOf(Error);
    expect(isNonRetryable(e429)).toBe(false);
  });

  it('sends nothing for an empty batch', async () => {
    const fetchMock = mockFetch(ok);
    await new WebhookAuditTarget(cfg, fetchMock as unknown as typeof fetch).send([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('describes the destination without the query string', () => {
    expect(new WebhookAuditTarget(cfg).description).toBe('https://siem.example/ingest');
  });
});
