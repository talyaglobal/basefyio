import { isLastDayOfMonth } from './stripe-summary.scheduler';

describe('isLastDayOfMonth', () => {
  it.each([
    ['2026-02-28T08:00:00Z', true],
    ['2028-02-28T08:00:00Z', false],
    ['2028-02-29T08:00:00Z', true],
    ['2026-04-30T08:00:00Z', true],
    ['2026-04-29T08:00:00Z', false],
    ['2026-12-31T08:00:00Z', true],
    ['2026-10-30T08:00:00Z', false],
  ])('%s -> %s', (iso, expected) => {
    expect(isLastDayOfMonth(new Date(iso))).toBe(expected);
  });
});
