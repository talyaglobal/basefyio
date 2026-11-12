import { cronError, cronMatches, isValidTimeZone, nextCronTimes, parseCron } from './flow-cron';

const at = (iso: string) => new Date(iso);

describe('flow cron', () => {
  describe('parseCron', () => {
    it('accepts the standard forms', () => {
      for (const ok of [
        '* * * * *',
        '*/1 * * * *',
        '*/15 * * * *',
        '0 9 * * 1-5',
        '0,30 8-18/2 1,15 * *',
        '5/15 * * * *',
        '0 0 1 JAN,jul *',
        '0 12 * * MON-FRI',
        '0 0 * * 7',
        '@hourly',
        '@daily',
        '  0   9  *  *  *  ',
      ]) {
        expect(cronError(ok)).toBeNull();
      }
    });

    it.each([
      ['', 'empty'],
      ['not a cron', '5 fields'],
      ['* * * *', '5 fields'],
      ['0 * * * * *', 'seconds are not supported'],
      ['60 * * * *', 'out of range'],
      ['* 24 * * *', 'out of range'],
      ['* * 0 * *', 'out of range'],
      ['* * * 13 *', 'out of range'],
      ['5-1 * * * *', 'backwards'],
      ['*/0 * * * *', 'positive number'],
      ['0 0 L * *', 'Quartz'],
      ['0 0 ? * MON', 'Quartz'],
      ['0 0 * * MON#2', 'Quartz'],
      ['@reboot', 'unknown shorthand'],
      ['1,,2 * * * *', 'empty list item'],
    ])('refuses %p (%s)', (expr, why) => {
      expect(cronError(expr)).toEqual(expect.stringContaining(why));
    });

    it('folds 7 into Sunday', () => {
      expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    });
  });

  describe('cronMatches', () => {
    it('matches every minute for */1', () => {
      const c = parseCron('*/1 * * * *');
      expect(cronMatches(c, at('2026-10-22T10:07:00Z'))).toBe(true);
      expect(cronMatches(c, at('2026-10-22T10:07:59Z'))).toBe(true);
    });

    it('matches steps and ranges', () => {
      const c = parseCron('*/15 9-17 * * *');
      expect(cronMatches(c, at('2026-10-22T09:15:00Z'))).toBe(true);
      expect(cronMatches(c, at('2026-10-22T09:16:00Z'))).toBe(false);
      expect(cronMatches(c, at('2026-10-22T18:00:00Z'))).toBe(false);
    });

    it('ORs day-of-month and day-of-week when both are restricted', () => {
      const c = parseCron('0 0 1 * MON');
      expect(cronMatches(c, at('2026-10-01T00:00:00Z'))).toBe(true); // a Thursday, the 1st
      expect(cronMatches(c, at('2026-10-05T00:00:00Z'))).toBe(true); // a Monday
      expect(cronMatches(c, at('2026-10-06T00:00:00Z'))).toBe(false);
    });

    it('ANDs them when one starts with *', () => {
      const c = parseCron('0 0 */2 * MON');
      // 2026-10-05 is Monday the 5th (odd day → matches */2 from 1) → yes; Monday the 12th → no
      expect(cronMatches(c, at('2026-10-05T00:00:00Z'))).toBe(true);
      expect(cronMatches(c, at('2026-10-12T00:00:00Z'))).toBe(false);
    });

    it('reads the expression in the given time zone', () => {
      const c = parseCron('0 9 * * *');
      // 09:00 in Istanbul (UTC+3) is 06:00 UTC
      expect(cronMatches(c, at('2026-10-22T06:00:00Z'), 'Europe/Istanbul')).toBe(true);
      expect(cronMatches(c, at('2026-10-22T09:00:00Z'), 'Europe/Istanbul')).toBe(false);
      expect(cronMatches(c, at('2026-10-22T09:00:00Z'))).toBe(true);
    });
  });

  describe('nextCronTimes', () => {
    it('lists the next ticks strictly after the given time', () => {
      const next = nextCronTimes(parseCron('*/15 * * * *'), at('2026-10-22T10:07:30Z'), 3);
      expect(next.map((d) => d.toISOString())).toEqual([
        '2026-10-22T10:15:00.000Z',
        '2026-10-22T10:30:00.000Z',
        '2026-10-22T10:45:00.000Z',
      ]);
    });

    it('finds rare dates quickly', () => {
      const next = nextCronTimes(parseCron('0 0 29 2 *'), at('2026-10-22T00:00:00Z'), 1);
      expect(next[0].toISOString()).toBe('2028-02-29T00:00:00.000Z');
    });

    it('returns nothing for a date that never exists', () => {
      expect(nextCronTimes(parseCron('0 0 31 2 *'), at('2026-10-22T00:00:00Z'), 1)).toEqual([]);
    });

    it('respects the time zone', () => {
      const next = nextCronTimes(parseCron('30 8 * * *'), at('2026-10-22T00:00:00Z'), 1, 'Europe/Istanbul');
      expect(next[0].toISOString()).toBe('2026-10-22T05:30:00.000Z');
    });
  });

  it('validates time zones', () => {
    expect(isValidTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
