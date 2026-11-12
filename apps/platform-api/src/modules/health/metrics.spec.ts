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
  const build = async (
    mail: { state: string; detail?: string; checkedAt?: string } | string,
    role = 'leader',
    env: Record<string, string> = { METRICS_TOKEN: 'ops-secret' },
  ) => {
    const { HealthController } = await import('./health.controller');
    const deliverability = typeof mail === 'string' ? { state: mail } : mail;
    const email = { getDeliverability: () => deliverability } as any;
    const leader = { getInstanceId: () => 'api-1-c0ffee', getRole: () => role } as any;
    const cfg = { get: (k: string) => env[k] } as any;
    return new HealthController(email, leader, cfg);
  };
  const operator = request('Bearer ops-secret');

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
    const body = (await build('ok')).check(operator) as any;
    expect(body.status).toBe('ok');
    expect(body.instance).toEqual({ id: 'api-1-c0ffee', role: 'leader', imageTag: 'abc123def456' });
  });

  it('reports an unknown build when no tag was passed to the container', async () => {
    expect(((await build('ok', 'follower')).check(operator) as any).instance).toMatchObject({
      role: 'follower',
      imageTag: 'unknown',
    });
  });

  /** The proxy routes on the status code, so a dead mail key must stay a 200 with status "degraded". */
  it('keeps the degraded verdict for a failing mail key alongside the instance block', async () => {
    const body = (await build('failing')).check(operator) as any;
    expect(body.status).toBe('degraded');
    expect(body.checks.email).toEqual({ state: 'failing' });
    expect(body.instance).toBeDefined();
  });

  /**
   * The route is public. A stranger gets the verdict a monitor needs and not
   * the provider's account state or the exact build to look up exploits for.
   */
  it('gives an anonymous caller the verdict without the provider detail or the build', async () => {
    process.env.IMAGE_TAG = 'abc123def456';
    const mail = { state: 'failing', detail: 'invalid_from_address — x', checkedAt: '2026-10-22T00:00:00.000Z' };
    const body = (await build(mail)).check(request()) as any;
    expect(body).toEqual({
      status: 'degraded',
      checks: { email: { state: 'failing', checkedAt: '2026-10-22T00:00:00.000Z' } },
    });
  });

  it('treats a wrong token like no token', async () => {
    const body = (await build('ok')).check(request('Bearer guess')) as any;
    expect(body.instance).toBeUndefined();
  });

  it('shows no detail to anyone when no operator token is configured', async () => {
    const body = (await build('ok', 'leader', {})).check(request('Bearer ')) as any;
    expect(body.instance).toBeUndefined();
  });

  it('serves the full body to everyone when the install opts in', async () => {
    const mail = { state: 'failing', detail: 'invalid_api_key — x' };
    const body = (await build(mail, 'leader', { HEALTH_PUBLIC_DETAIL: 'true' })).check(request()) as any;
    expect(body.checks.email.detail).toBe('invalid_api_key — x');
    expect(body.instance).toMatchObject({ id: 'api-1-c0ffee' });
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

/**
 * A key the provider accepts is half the answer: the from address has to be on
 * a domain the provider will send for. Checking only the key made a restart
 * report 'ok' while every mail bounced with invalid_from_address, and a fixed
 * domain stayed 'failing' until someone happened to trigger a mail.
 */
describe('EmailService — sender domain and re-probe', () => {
  const FROM = 'basefyio <noreply@basefyio.com>';
  type Listing = { data?: unknown; error?: { name: string; message?: string } | null };

  const makeService = async (listing: () => Listing | Promise<Listing>) => {
    const { EmailService } = await import('../email/email.service');
    const svc = new EmailService(
      {
        get: (k: string) => (k === 'resend.apiKey' ? 'ts_key' : k === 'resend.fromEmail' ? FROM : 'x'),
      } as any,
      undefined,
    );
    const sendResult: { value: any } = { value: { data: { id: 'm1' }, error: null } };
    (svc as any).resend = {
      domains: { list: async () => listing() },
      emails: { send: async () => sendResult.value },
    };
    return { svc, sendResult };
  };
  const domains = (rows: unknown[], hasMore = false): Listing => ({
    data: { object: 'list', has_more: hasMore, data: rows },
    error: null,
  });

  it('marks mail failing when the sender domain is missing from a complete listing', async () => {
    const { svc } = await makeService(() => domains([{ name: 'other.com', status: 'verified' }]));
    await svc.probe();
    expect(svc.getDeliverability()).toMatchObject({
      state: 'failing',
      detail: expect.stringContaining('basefyio.com is not registered'),
    });
  });

  it.each([['pending'], ['not_started'], ['failed']])('marks a %s sender domain as failing', async (status) => {
    const { svc } = await makeService(() => domains([{ name: 'basefyio.com', status }]));
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('failing');
  });

  it('accepts a verified sender domain', async () => {
    const { svc } = await makeService(() => domains([{ name: 'basefyio.com', status: 'verified' }]));
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('ok');
  });

  it('accepts a listing it cannot judge: more pages, or rows of an unknown shape', async () => {
    const paged = await makeService(() => domains([{ name: 'other.com', status: 'verified' }], true));
    await paged.svc.probe();
    expect(paged.svc.getDeliverability().state).toBe('ok');

    const odd = await makeService(() => ({ data: { domains: ['basefyio.com'] }, error: null }));
    await odd.svc.probe();
    expect(odd.svc.getDeliverability().state).toBe('ok');
  });

  it('clears a probe-found problem once the domain is registered', async () => {
    let rows: unknown[] = [];
    const { svc } = await makeService(() => domains(rows));
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('failing');
    rows = [{ name: 'basefyio.com', status: 'verified' }];
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('ok');
  });

  it('clears a rejected from address when the probe confirms the domain can send', async () => {
    const { svc, sendResult } = await makeService(() => domains([{ name: 'basefyio.com', status: 'verified' }]));
    sendResult.value = { data: null, error: { name: 'invalid_from_address', message: 'domain not registered' } };
    await svc.sendRawHtml('a@b.co', 's', '<p>x</p>');
    expect(svc.getDeliverability().state).toBe('failing');
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('ok');
  });

  it('keeps a rejection the probe cannot see, such as an exhausted quota, until a send succeeds', async () => {
    const { svc, sendResult } = await makeService(() => domains([{ name: 'basefyio.com', status: 'verified' }]));
    sendResult.value = { data: null, error: { name: 'daily_quota_exceeded', message: 'quota' } };
    await svc.sendRawHtml('a@b.co', 's', '<p>x</p>');
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('failing');
    sendResult.value = { data: { id: 'm2' }, error: null };
    await svc.sendRawHtml('a@b.co', 's', '<p>x</p>');
    expect(svc.getDeliverability().state).toBe('ok');
  });

  it('does not let an unreachable provider overwrite a verdict it already had', async () => {
    let reachable = true;
    const { svc } = await makeService(() => {
      if (!reachable) throw new Error('ECONNRESET');
      return domains([{ name: 'basefyio.com', status: 'verified' }]);
    });
    await svc.probe();
    reachable = false;
    await svc.probe();
    expect(svc.getDeliverability().state).toBe('ok');
  });

  it('probes again on a timer after startup and stops on shutdown', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const { svc } = await makeService(() => {
        calls += 1;
        return domains([{ name: 'basefyio.com', status: 'verified' }]);
      });
      await svc.onModuleInit();
      expect(calls).toBe(1);
      await jest.advanceTimersByTimeAsync((svc.constructor as any).REPROBE_INTERVAL_MS);
      expect(calls).toBe(2);
      svc.onModuleDestroy();
      await jest.advanceTimersByTimeAsync((svc.constructor as any).REPROBE_INTERVAL_MS * 2);
      expect(calls).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('senderDomain / senderDomainVerdict', () => {
  it('reads the domain from a display-name address and a bare one', async () => {
    const { senderDomain } = await import('../email/email.service');
    expect(senderDomain('basefyio <noreply@basefyio.com>')).toBe('basefyio.com');
    expect(senderDomain('noreply@Mail.Basefyio.com')).toBe('mail.basefyio.com');
    expect(senderDomain('not an address')).toBeUndefined();
  });

  it('accepts a subdomain sender when the provider verified the parent domain', async () => {
    const { senderDomainVerdict } = await import('../email/email.service');
    expect(
      senderDomainVerdict('x <a@mail.basefyio.com>', { data: [{ name: 'basefyio.com', status: 'verified' }] }),
    ).toEqual({ confirmed: true });
  });
});
