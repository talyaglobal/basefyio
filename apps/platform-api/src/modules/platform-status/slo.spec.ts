import {
  availabilityPct,
  burnRate,
  errorBudgetMinutes,
  errorRatePct,
  minuteVerdicts,
  minutesInMonth,
  percentile,
  summarise,
} from './slo';

const t = (iso: string) => new Date(iso);

describe('minuteVerdicts', () => {
  it('marks a minute down only when a majority of vantage points failed', () => {
    const verdicts = minuteVerdicts([
      { ts: t('2026-10-26T10:00:05Z'), probe: 'api', vantage: 'internal', ok: false },
      { ts: t('2026-10-26T10:00:07Z'), probe: 'api', vantage: 'kuma', ok: true },
      { ts: t('2026-10-26T10:00:09Z'), probe: 'api', vantage: 'saas', ok: true },
      { ts: t('2026-10-26T10:01:05Z'), probe: 'api', vantage: 'internal', ok: false },
      { ts: t('2026-10-26T10:01:07Z'), probe: 'api', vantage: 'kuma', ok: false },
      { ts: t('2026-10-26T10:01:09Z'), probe: 'api', vantage: 'saas', ok: true },
    ]);
    expect(verdicts.map((v) => v.down)).toEqual([false, true]);
    expect(verdicts[1]).toMatchObject({ reporters: 3, failing: 2 });
  });

  it('a single vantage point decides alone, and a tie is up', () => {
    const verdicts = minuteVerdicts([
      { ts: t('2026-10-26T10:00:05Z'), probe: 'api', vantage: 'internal', ok: false },
      { ts: t('2026-10-26T10:01:05Z'), probe: 'api', vantage: 'internal', ok: false },
      { ts: t('2026-10-26T10:01:35Z'), probe: 'api', vantage: 'kuma', ok: true },
    ]);
    expect(verdicts.map((v) => v.down)).toEqual([true, false]);
  });

  it('two samples from one vantage point in a minute fail only if both failed', () => {
    const verdicts = minuteVerdicts([
      { ts: t('2026-10-26T10:00:05Z'), probe: 'api', vantage: 'internal', ok: false },
      { ts: t('2026-10-26T10:00:35Z'), probe: 'api', vantage: 'internal', ok: true },
    ]);
    expect(verdicts[0].down).toBe(false);
  });
});

describe('summarise and the figures', () => {
  it('counts observed and down minutes and the p95 of successful latencies', () => {
    const samples = [];
    for (let m = 0; m < 10; m++) {
      samples.push({ ts: t(`2026-10-26T10:0${m}:00Z`), probe: 'api', vantage: 'internal', ok: m !== 3, latencyMs: 100 + m * 10 });
    }
    const s = summarise(samples);
    expect(s.totalMinutes).toBe(10);
    expect(s.downMinutes).toBe(1);
    expect(s.p95LatencyMs).toBe(190);
    expect(availabilityPct(s.totalMinutes, s.downMinutes)).toBe(90);
  });

  it('matches the SLA arithmetic: 99.97 % of a 30-day month is 12.96 minutes', () => {
    expect(errorBudgetMinutes(99.97, 30 * 24 * 60)).toBe(12.96);
    expect(errorBudgetMinutes(99.9, 30 * 24 * 60)).toBe(43.2);
    expect(minutesInMonth(2026, 1)).toBe(28 * 24 * 60);
    expect(minutesInMonth(2026, 9)).toBe(31 * 24 * 60);
  });

  it('availability is null without observations and rounds to three decimals', () => {
    expect(availabilityPct(0, 0)).toBeNull();
    expect(availabilityPct(43_200, 13)).toBe(99.97);
  });

  it('burn rate: one down minute per hour against a 99.97 % target burns ~55× the budget', () => {
    // budget per hour = 12.96 / 720 = 0.018 min
    expect(burnRate(1, 1, 99.97)).toBe(55.56);
    expect(burnRate(0, 6, 99.97)).toBe(0);
  });

  it('percentile and error rate edge cases', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(errorRatePct(0, 0)).toBeNull();
    expect(errorRatePct(2000, 3)).toBe(0.15);
  });
});
