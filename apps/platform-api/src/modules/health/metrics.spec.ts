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

  /**
   * A gauge is a fact about this process, not a count: setting it again for the
   * same labels replaces the value rather than adding a second sample.
   */
  it('publishes a registered gauge once per label set, latest value wins', () => {
    const m = new MetricsService();
    m.setGauge('basefyio_cron_leader', 'Runs the schedule.', 'instance_id="a"', 1);
    m.setGauge('basefyio_cron_leader', 'Runs the schedule.', 'instance_id="a"', 0);
    const text = m.render();
    expect(text).toMatch(/# HELP basefyio_cron_leader Runs the schedule\./);
    expect(text).toMatch(/# TYPE basefyio_cron_leader gauge/);
    expect(text).toMatch(/basefyio_cron_leader\{instance_id="a"\} 0\n/);
    expect(text).not.toMatch(/basefyio_cron_leader\{instance_id="a"\} 1/);
  });

  it('keeps separate samples for separate label sets of one gauge', () => {
    const m = new MetricsService();
    m.setGauge('basefyio_build_info', 'Build.', 'instance_id="a",image_tag="x"', 1);
    m.setGauge('basefyio_build_info', 'Build.', 'instance_id="b",image_tag="x"', 1);
    const text = m.render();
    expect(text).toMatch(/basefyio_build_info\{instance_id="a",image_tag="x"\} 1/);
    expect(text).toMatch(/basefyio_build_info\{instance_id="b",image_tag="x"\} 1/);
    expect(text.match(/# TYPE basefyio_build_info gauge/g)).toHaveLength(1);
  });
});

describe('HealthController', () => {
  const build = async (mailState: string, role = 'leader') => {
    const { HealthController } = await import('./health.controller');
    const email = { getDeliverability: () => ({ state: mailState }) } as any;
    const leader = { getInstanceId: () => 'api-1-c0ffee', getRole: () => role } as any;
    return new HealthController(email, leader);
  };

  afterEach(() => {
    delete process.env.IMAGE_TAG;
  });

  /**
   * Behind the proxy every replica shares one hostname. The body is the only
   * place an operator can read which one answered and whether it is the one
   * running the scheduled jobs.
   */
  it('names the replica that answered, its role and the build it runs', async () => {
    process.env.IMAGE_TAG = 'abc123def456';
    const body = (await build('ok')).check();
    expect(body.status).toBe('ok');
    expect(body.instance).toEqual({ id: 'api-1-c0ffee', role: 'leader', imageTag: 'abc123def456' });
  });

  it('reports an unknown build when no tag was passed to the container', async () => {
    expect((await build('ok', 'follower')).check().instance).toMatchObject({ role: 'follower', imageTag: 'unknown' });
  });

  /** The proxy routes on the status code, so a dead mail key must stay a 200 with status "degraded". */
  it('keeps the degraded verdict for a failing mail key alongside the instance block', async () => {
    const body = (await build('failing')).check();
    expect(body.status).toBe('degraded');
    expect(body.checks.email).toEqual({ state: 'failing' });
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

/**
 * The startup probe reads the provider's domains endpoint, which a perfectly
 * good key can be refused on — it may be scoped to sending only, or its
 * creator may lack a console right the provider started checking. Treating
 * every refusal as "mail is down" would raise a false alarm each time the
 * provider adds a reason, so only a refusal naming the key itself counts.
 */
describe('EmailService — what counts as a dead key', () => {
  const makeService = async (probeError: { name: string } | null) => {
    const { EmailService } = await import('../email/email.service');
    const svc = new EmailService(
      { get: (k: string) => (k === 'resend.apiKey' ? 'ts_key' : 'x') } as any,
      undefined,
    );
    (svc as any).resend = {
      domains: { list: async () => (probeError ? { error: probeError } : { data: [] }) },
    };
    await svc.onModuleInit();
    return svc.getDeliverability();
  };

  it.each([['restricted_api_key'], ['invalid_permission'], ['something_new_next_year']])(
    'treats %s as a valid but limited key',
    async (name) => {
      expect((await makeService({ name })).state).toBe('ok');
    },
  );

  it.each([['invalid_api_key'], ['missing_api_key']])('treats %s as mail being down', async (name) => {
    expect((await makeService({ name })).state).toBe('failing');
  });

  it('treats a clean probe as working', async () => {
    expect((await makeService(null)).state).toBe('ok');
  });
});
