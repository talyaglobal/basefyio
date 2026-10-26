import { admissionConfig, admissionMode, limitsForPlan } from './admission-limits';

describe('limitsForPlan', () => {
  it('uses the plan default, falling back to free for unknown plans', () => {
    expect(limitsForPlan('pro')).toEqual({ rate: 200, burst: 400 });
    expect(limitsForPlan('Business')).toEqual({ rate: 500, burst: 1000 });
    expect(limitsForPlan('legacy')).toEqual({ rate: 50, burst: 100 });
    expect(limitsForPlan(null)).toEqual({ rate: 50, burst: 100 });
  });

  it('lets the plan editor override through features, and keeps burst at least the rate', () => {
    expect(limitsForPlan('pro', { api_rps: 1000 })).toEqual({ rate: 1000, burst: 1000 });
    expect(limitsForPlan('pro', { api_rps: '20', api_burst: '80' })).toEqual({ rate: 20, burst: 80 });
    expect(limitsForPlan('free', { api_rps: -5, api_burst: 'x' })).toEqual({ rate: 50, burst: 100 });
  });
});

describe('admission config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('ADMISSION_')) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('defaults to log mode with the documented limits', () => {
    delete process.env.ADMISSION_MODE;
    expect(admissionMode()).toBe('log');
    expect(admissionConfig()).toEqual({ mode: 'log', maxInflight: 200, maxWaiting: 400, maxWaitMs: 1500, dashboardShare: 0.3 });
  });

  it('reads the environment and clamps the dashboard share', () => {
    process.env.ADMISSION_MODE = 'ENFORCE';
    process.env.ADMISSION_MAX_INFLIGHT = '50';
    process.env.ADMISSION_DASHBOARD_SHARE = '95';
    const c = admissionConfig();
    expect(c.mode).toBe('enforce');
    expect(c.maxInflight).toBe(50);
    expect(c.dashboardShare).toBe(0.9);
    process.env.ADMISSION_MODE = 'nonsense';
    expect(admissionMode()).toBe('log');
  });
});
