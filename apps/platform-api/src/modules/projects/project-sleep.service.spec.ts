import { ProjectSleepService } from './project-sleep.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-01T06:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

/** A project as findQuietProjects() returns it. */
function quiet(over: Partial<Record<string, unknown>> = {}) {
  const lastSeen = (over.lastSeenAt as Date) ?? ago(20);
  return {
    id: 'p-' + (over.slug ?? 'quiet'),
    name: String(over.slug ?? 'Quiet Project'),
    slug: String(over.slug ?? 'quiet'),
    teamId: 'team-1',
    createdBy: 'user-1',
    createdAt: ago(100),
    idleWarningSentAt: (over.idleWarningSentAt as Date | null) ?? null,
    lastSeenAt: lastSeen,
    idleDays: Math.floor((NOW.getTime() - lastSeen.getTime()) / DAY),
    ...over,
  };
}

function setup(opts: { env?: Record<string, string>; candidates?: any[]; mailThrows?: boolean; noRecipients?: boolean } = {}) {
  const updates: any[] = [];
  const activity: any[] = [];
  const warnings: any[] = [];
  const notices: any[] = [];
  const queries: any[] = [];

  const prisma = {
    project: {
      update: async (args: any) => {
        updates.push(args);
        return args;
      },
    },
    teamMember: {
      findMany: async () =>
        opts.noRecipients ? [] : [{ user: { email: 'Owner@Example.com' } }, { user: { email: 'owner@example.com' } }],
    },
    $queryRaw: async (...args: any[]) => {
      queries.push(args);
      return [];
    },
  };
  const email = {
    sendProjectSleepWarning: async (...a: any[]) => {
      if (opts.mailThrows) throw new Error('mailer down');
      warnings.push(a);
    },
    sendProjectAsleep: async (...a: any[]) => void notices.push(a),
  };
  const activitySvc = { append: async (id: string, e: any) => void activity.push({ id, ...e }) };

  const previous = { ...process.env };
  process.env.PROJECT_SLEEP_ENABLED = 'true';
  process.env.PROJECT_SLEEP_SIGNAL_SINCE = '2026-09-01T00:00:00.000Z';
  delete process.env.PROJECT_SLEEP_IDLE_DAYS;
  delete process.env.PROJECT_SLEEP_WARN_DAYS;
  delete process.env.PROJECT_SLEEP_MAX_PER_RUN;
  Object.assign(process.env, opts.env ?? {});

  const pgbouncer = { calls: 0, regenerateConfig: async () => void pgbouncer.calls++ };
  const realms = { disabled: [] as string[], disableRealm: async (r: string) => void realms.disabled.push(r) };
  const svc = new ProjectSleepService(
    prisma as any,
    { get: () => undefined } as any,
    email as any,
    activitySvc as any,
    pgbouncer as any,
    realms as any,
  );
  if (opts.candidates) {
    (svc as any).findQuietProjects = async () => opts.candidates;
  }
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in previous)) delete process.env[k];
    Object.assign(process.env, previous);
  };
  return { svc, updates, activity, warnings, notices, queries, pgbouncer, restore };
}

describe('ProjectSleepService', () => {
  beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterAll(() => jest.useRealTimers());

  it('does nothing at all while the sweep is switched off', async () => {
    const h = setup({ env: { PROJECT_SLEEP_ENABLED: 'false' }, candidates: [quiet()] });
    expect(await h.svc.sweep()).toEqual({ warned: 0, slept: 0, considered: 0 });
    expect(h.updates).toEqual([]);
    expect(h.warnings).toEqual([]);
    h.restore();
  });

  it('rewrites the pooler configuration once, only when something was slept', async () => {
    // Until it is rewritten a sleeping project keeps its pool, so the memory
    // and connections the sleep was meant to free stay held open.
    const slept = setup({ candidates: [quiet({ lastSeenAt: ago(200) })] });
    await slept.svc.sweep();
    expect(slept.pgbouncer.calls).toBe(1);
    slept.restore();

    const onlyWarned = setup({ candidates: [quiet({ lastSeenAt: ago(20) })] });
    await onlyWarned.svc.sweep();
    expect(onlyWarned.pgbouncer.calls).toBe(0);
    onlyWarned.restore();
  });

  it('sleeps a project quiet far past the threshold without a warning first', async () => {
    const h = setup({ candidates: [quiet({ slug: 'abandoned', lastSeenAt: ago(200) })] });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 0, slept: 1 });
    expect(h.updates[0].data).toMatchObject({ status: 'PAUSED' });
    expect(h.notices).toHaveLength(1);
    h.restore();
  });

  it('still warns first inside the window, and can be made to always warn', async () => {
    const h = setup({ candidates: [quiet({ lastSeenAt: ago(20) })] });
    expect(await h.svc.sweep()).toMatchObject({ warned: 1, slept: 0 });
    h.restore();

    const always = setup({
      candidates: [quiet({ lastSeenAt: ago(400) })],
      env: { PROJECT_SLEEP_STRAIGHT_TO_SLEEP_DAYS: '99999' },
    });
    expect(await always.svc.sweep()).toMatchObject({ warned: 1, slept: 0 });
    always.restore();
  });

  it('refuses to run when it has no idea when request counting started', async () => {
    // The column starts empty, so without this every project on the platform
    // looks as if it has never been called.
    const h = setup({ candidates: [quiet()] });
    delete process.env.PROJECT_SLEEP_SIGNAL_SINCE;
    expect(await h.svc.sweep()).toEqual({ warned: 0, slept: 0, considered: 0 });
    expect(h.updates).toEqual([]);
    h.restore();
  });

  it('warns a quiet project rather than sleeping it straight away', async () => {
    const h = setup({ candidates: [quiet({ slug: 'dormant', lastSeenAt: ago(20) })] });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 1, slept: 0 });
    expect(h.warnings).toHaveLength(1);
    expect(h.updates[0].data).toHaveProperty('idleWarningSentAt');
    expect(h.updates[0].data.status).toBeUndefined();
    h.restore();
  });

  it('sleeps it on a later run, once the warning has gone out', async () => {
    const h = setup({ candidates: [quiet({ slug: 'dormant', lastSeenAt: ago(20), idleWarningSentAt: ago(4) })] });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 0, slept: 1 });
    expect(h.updates[0].data).toMatchObject({ status: 'PAUSED' });
    expect(h.updates[0].data.pausedAt).toBeInstanceOf(Date);
    expect(h.notices).toHaveLength(1);
    h.restore();
  });

  it('never sleeps an unwarned project that is only just over the threshold', async () => {
    // Inside the straight-to-sleep window the warning is still mandatory: the
    // first a customer hears of it must not be their site erroring.
    const h = setup({ candidates: [quiet({ slug: 'recent', lastSeenAt: ago(16) })] });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 1, slept: 0 });
    expect(h.updates[0].data.status).toBeUndefined();
    h.restore();
  });

  it('does not record a warning that could not be sent', async () => {
    // Otherwise the clock starts on a message the customer never got, and the
    // project is slept without notice.
    const h = setup({ candidates: [quiet({ lastSeenAt: ago(20) })], mailThrows: true });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 0, slept: 0 });
    expect(h.updates).toEqual([]);
    h.restore();
  });

  it('leaves a project awake when a warning is due and there is nobody to tell', async () => {
    const h = setup({ candidates: [quiet({ lastSeenAt: ago(20) })], noRecipients: true });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 0, slept: 0 });
    expect(h.updates).toEqual([]);
    h.restore();
  });

  it('still sleeps a long-abandoned project with no reachable owner, and says so', async () => {
    const h = setup({ candidates: [quiet({ lastSeenAt: ago(300) })], noRecipients: true });
    const result = await h.svc.sweep();
    expect(result).toMatchObject({ warned: 0, slept: 1 });
    expect(h.updates[0].data).toMatchObject({ status: 'PAUSED' });
    expect(String(h.activity[0].detail)).toContain('No notice could be delivered');
    h.restore();
  });

  it('writes to each distinct address once, whatever case it is stored in', async () => {
    const h = setup({ candidates: [quiet({ lastSeenAt: ago(20) })] });
    await h.svc.sweep();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0][0]).toBe('owner@example.com');
    h.restore();
  });

  it('stops at the per-run limit so one night cannot mail the whole platform', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      quiet({ slug: 'p' + i, lastSeenAt: ago(30), idleWarningSentAt: ago(5) }),
    );
    const h = setup({ candidates: many, env: { PROJECT_SLEEP_MAX_PER_RUN: '3' } });
    const result = await h.svc.sweep();
    expect(result.slept).toBe(3);
    h.restore();
  });

  it('keeps going when one project fails', async () => {
    const h = setup({
      candidates: [
        quiet({ slug: 'broken', lastSeenAt: ago(30), idleWarningSentAt: ago(5) }),
        quiet({ slug: 'fine', lastSeenAt: ago(30), idleWarningSentAt: ago(5) }),
      ],
    });
    let first = true;
    (h.svc as any).prisma.project.update = async (args: any) => {
      if (first) {
        first = false;
        throw new Error('row is locked');
      }
      h.updates.push(args);
      return args;
    };
    const result = await h.svc.sweep();
    expect(result.slept).toBe(1);
    h.restore();
  });

  it('reads the thresholds from the environment and keeps the warning before the sleep', async () => {
    const h = setup({ env: { PROJECT_SLEEP_IDLE_DAYS: '30', PROJECT_SLEEP_WARN_DAYS: '7' } });
    expect(h.svc.settings()).toMatchObject({ idleDays: 30, warnDays: 7 });
    h.restore();

    const bad = setup({ env: { PROJECT_SLEEP_IDLE_DAYS: '10', PROJECT_SLEEP_WARN_DAYS: '40' } });
    // A warning window wider than the idle window would mean warning a project
    // before it had gone quiet at all.
    expect(bad.svc.settings().warnDays).toBe(3);
    bad.restore();
  });

  it('floors every project at the moment counting began, so none looks idle on day one', async () => {
    const h = setup();
    await h.svc.sweep();
    const [, ...params] = h.queries[0];
    const flooredAt = params.find((v: unknown) => v instanceof Date && (v as Date).getUTCMonth() === 8);
    expect(flooredAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    h.restore();
  });
});
