import { PlanUsageAlertsService, alertKey } from './plan-usage-alerts.service';

function metric(o: Partial<any>) {
  return {
    metric: 'api_requests',
    label: 'API requests this month',
    unit: 'count',
    current: '45000',
    limit: '50000',
    percent: 90,
    level: 'warning',
    mode: 'enforce',
    blocking: false,
    wouldBlock: false,
    ...o,
  };
}

function make(opts: { modes?: any; metrics?: any[]; exempt?: boolean; owners?: string[]; sendFails?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis = {
    durable: () => ({
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    }),
  };
  const prisma = {
    subscription: { findMany: jest.fn().mockResolvedValue([{ teamId: 't1', team: { name: 'Acme' } }]) },
    teamMember: {
      findMany: jest.fn().mockResolvedValue((opts.owners ?? ['owner@acme.test']).map((email) => ({ user: { email } }))),
    },
  };
  const email = {
    sendPlanUsageNotice: opts.sendFails ? jest.fn().mockRejectedValue(new Error('smtp')) : jest.fn().mockResolvedValue({}),
  };
  const enforcement = {
    modes: jest.fn().mockResolvedValue(opts.modes ?? { api_requests: 'enforce', egress: 'warn', mau: 'warn', db_size: 'warn' }),
    teamState: jest.fn().mockResolvedValue({
      planName: 'free',
      planDisplayName: 'Free',
      exempt: opts.exempt ?? false,
      exemptReason: null,
      metrics: opts.metrics ?? [metric({})],
    }),
  };
  const service = new PlanUsageAlertsService(prisma as any, redis as any, email as any, enforcement as any);
  return { service, email, store, enforcement };
}

const NOW = new Date('2026-11-23T12:00:00Z');

describe('PlanUsageAlertsService', () => {
  it('mails the owners once at 80% of an enforced limit, not again the same month', async () => {
    const { service, email, store } = make();
    await expect(service.run(NOW)).resolves.toBe(1);
    await expect(service.run(NOW)).resolves.toBe(0);
    expect(email.sendPlanUsageNotice).toHaveBeenCalledTimes(1);
    expect(email.sendPlanUsageNotice).toHaveBeenCalledWith(
      'owner@acme.test',
      expect.objectContaining({ threshold: 80, teamName: 'Acme', limit: '50,000', current: '45,000' }),
    );
    expect(store.has(alertKey('t1', '2026-11', 'api_requests', 80))).toBe(true);
  });

  it('sends the 100% notice once and marks 80% as covered', async () => {
    const { service, email, store } = make({ metrics: [metric({ level: 'limit', current: '51000', percent: 102 })] });
    await service.run(NOW);
    expect(email.sendPlanUsageNotice).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ threshold: 100 }));
    expect(store.has(alertKey('t1', '2026-11', 'api_requests', 80))).toBe(true);
    expect(store.has(alertKey('t1', '2026-11', 'api_requests', 100))).toBe(true);
  });

  it('never mails when no metric is enforced (warn is the default)', async () => {
    const { service, email, enforcement } = make({ modes: { api_requests: 'warn', egress: 'warn', mau: 'warn', db_size: 'warn' } });
    await expect(service.run(NOW)).resolves.toBe(0);
    expect(enforcement.teamState).not.toHaveBeenCalled();
    expect(email.sendPlanUsageNotice).not.toHaveBeenCalled();
  });

  it('skips metrics in warn mode, uncapped metrics, exempt plans and teams below 80%', async () => {
    const a = make({ metrics: [metric({ mode: 'warn' }), metric({ metric: 'mau', limit: null, level: 'ok' }), metric({ level: 'ok', percent: 10 })] });
    await expect(a.service.run(NOW)).resolves.toBe(0);
    const b = make({ exempt: true });
    await expect(b.service.run(NOW)).resolves.toBe(0);
    expect(a.email.sendPlanUsageNotice).not.toHaveBeenCalled();
    expect(b.email.sendPlanUsageNotice).not.toHaveBeenCalled();
  });

  it('does not mark a notice that reached nobody, so it is tried again', async () => {
    const { service, store } = make({ sendFails: true });
    await expect(service.run(NOW)).resolves.toBe(0);
    expect(store.size).toBe(0);
  });
});
