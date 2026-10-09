import { UnauthorizedException } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController, MetricsInterceptor } from './metrics.controller';

const config = (token?: string) => ({ get: (k: string) => (k === 'METRICS_TOKEN' ? token : undefined) }) as any;
const request = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} }) as any;

describe('MetricsService', () => {
  it('renders the exposition format with a help and type line per series', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 12);
    const text = m.render();
    expect(text).toMatch(/# HELP basefyio_http_requests_total /);
    expect(text).toMatch(/# TYPE basefyio_http_requests_total counter/);
    expect(text).toMatch(/basefyio_http_requests_total\{method="GET",status="200"\} 1/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('counts each method and status separately', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 1);
    m.observeRequest('GET', 200, 1);
    m.observeRequest('POST', 403, 1);
    const text = m.render();
    expect(text).toMatch(/\{method="GET",status="200"\} 2/);
    expect(text).toMatch(/\{method="POST",status="403"\} 1/);
  });

  it('sums durations so a mean can be derived from the pair', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 10);
    m.observeRequest('GET', 200, 30);
    expect(m.render()).toMatch(/duration_milliseconds_sum\{method="GET",status="200"\} 40/);
  });

  /**
   * A project's tables and buckets appear in its paths, so a route label
   * would mean one series per customer table — unbounded cardinality, and a
   * map of every tenant's schema sitting in the monitoring system.
   */
  it('never labels a series by route', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 1);
    expect(m.render()).not.toMatch(/route=|path=|url=/);
  });

  it('reports process gauges', () => {
    const text = new MetricsService().render();
    expect(text).toMatch(/basefyio_process_resident_memory_bytes \d+/);
    expect(text).toMatch(/basefyio_uptime_seconds \d+/);
  });

  it('omits a series with no samples rather than emitting a bare header', () => {
    const text = new MetricsService().render();
    expect(text).not.toMatch(/# TYPE basefyio_http_requests_total/);
  });

  it('accumulates named events', () => {
    const m = new MetricsService();
    m.increment('anon_key_refused');
    m.increment('anon_key_refused', 2);
    expect(m.render()).toMatch(/basefyio_events_total\{event="anon_key_refused"\} 3/);
  });
});

describe('MetricsController', () => {
  /**
   * An install that never configured a token must not publish metrics. A
   * scrape endpoint accumulates detail over time, and one that started out
   * open does not get closed later.
   */
  it('refuses to publish anything when no token is configured', () => {
    const c = new MetricsController(new MetricsService(), config(undefined));
    expect(() => c.scrape(request('Bearer anything'))).toThrow(UnauthorizedException);
  });

  it('refuses a request with no token', () => {
    const c = new MetricsController(new MetricsService(), config('secret'));
    expect(() => c.scrape(request())).toThrow(UnauthorizedException);
  });

  it('refuses the wrong token', () => {
    const c = new MetricsController(new MetricsService(), config('secret'));
    expect(() => c.scrape(request('Bearer nope'))).toThrow(UnauthorizedException);
  });

  it('refuses a token of the right length but the wrong value', () => {
    const c = new MetricsController(new MetricsService(), config('secret'));
    expect(() => c.scrape(request('Bearer secrot'))).toThrow(UnauthorizedException);
  });

  it('serves the metrics for the configured token', () => {
    const m = new MetricsService();
    m.observeRequest('GET', 200, 5);
    const c = new MetricsController(m, config('secret'));
    expect(c.scrape(request('Bearer secret'))).toMatch(/basefyio_http_requests_total/);
  });

  it('accepts the scheme case-insensitively, as the header is', () => {
    const c = new MetricsController(new MetricsService(), config('secret'));
    expect(c.scrape(request('bearer secret'))).toMatch(/basefyio_uptime_seconds/);
  });
});

describe('MetricsInterceptor', () => {
  const context = (method: string, statusCode: number) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ method }),
        getResponse: () => ({ statusCode }),
      }),
    }) as any;

  const run = (interceptor: MetricsInterceptor, ctx: any, handler: any) =>
    new Promise<void>((resolve) =>
      interceptor.intercept(ctx, handler).subscribe({ next: () => resolve(), error: () => resolve() }),
    );

  it('records a successful request', async () => {
    const m = new MetricsService();
    const { of } = await import('rxjs');
    await run(new MetricsInterceptor(m), context('GET', 200), { handle: () => of('ok') });
    expect(m.render()).toMatch(/\{method="GET",status="200"\}/);
  });

  /**
   * A deployment where only successes are counted looks healthiest exactly
   * when it is failing.
   */
  it('records a failing request under the status it failed with', async () => {
    const m = new MetricsService();
    const { throwError } = await import('rxjs');
    await run(new MetricsInterceptor(m), context('POST', 200), {
      handle: () => throwError(() => ({ status: 403 })),
    });
    expect(m.render()).toMatch(/\{method="POST",status="403"\}/);
  });
});
