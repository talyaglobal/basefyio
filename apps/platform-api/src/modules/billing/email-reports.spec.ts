import {
  DEFAULT_REPORT_RECIPIENT,
  MAX_REPORT_RECIPIENTS,
  isLastDayOfMonthUtc,
  normalizeRecipients,
  reportPeriodStart,
  reportRecipients,
} from './email-reports';

describe('email reports calendar', () => {
  it('finds the last day of every month, February included', () => {
    expect(isLastDayOfMonthUtc(new Date('2026-02-28T08:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthUtc(new Date('2028-02-28T08:00:00Z'))).toBe(false); // leap year
    expect(isLastDayOfMonthUtc(new Date('2028-02-29T08:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthUtc(new Date('2026-04-30T08:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthUtc(new Date('2026-10-30T08:00:00Z'))).toBe(false);
    expect(isLastDayOfMonthUtc(new Date('2026-10-31T08:00:00Z'))).toBe(true);
    expect(isLastDayOfMonthUtc(new Date('2026-12-31T08:00:00Z'))).toBe(true);
  });

  it('covers the whole month and the whole year', () => {
    const now = new Date('2026-12-31T08:00:00Z');
    expect(reportPeriodStart('Monthly', now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(reportPeriodStart('Yearly', now).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(reportPeriodStart('Daily', now).toISOString()).toBe('2026-12-30T08:00:00.000Z');
    expect(reportPeriodStart('Weekly', now).toISOString()).toBe('2026-12-24T08:00:00.000Z');
  });
});

describe('email report recipients', () => {
  it('cleans and de-duplicates the list', () => {
    expect(normalizeRecipients([' Ops@Example.com ', 'ops@example.com', '', 'cfo@example.org'])).toEqual([
      'ops@example.com',
      'cfo@example.org',
    ]);
    expect(normalizeRecipients(undefined)).toEqual([]);
  });

  it('rejects a bad address with a readable message', () => {
    expect(() => normalizeRecipients(['not-an-email'])).toThrow(/not a valid email/);
    expect(() => normalizeRecipients('ops@example.com')).toThrow(/list/);
    const many = Array.from({ length: MAX_REPORT_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`);
    expect(() => normalizeRecipients(many)).toThrow(/At most/);
  });

  it('falls back to the default address', () => {
    expect(reportRecipients({ recipients: [] })).toEqual([DEFAULT_REPORT_RECIPIENT]);
    expect(reportRecipients(null)).toEqual([DEFAULT_REPORT_RECIPIENT]);
    expect(reportRecipients({ recipients: ['a@example.com'] })).toEqual(['a@example.com']);
  });
});
