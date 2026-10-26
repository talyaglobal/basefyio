import { shouldOpen, shouldResolve } from './incident-rules';
import type { MinuteVerdict } from './slo';

const base = Date.UTC(2026, 9, 26, 10, 0, 0);
const now = new Date(base + 5 * 60_000 + 20_000); // 10:05:20

function verdicts(pattern: string, startMinute = 0): MinuteVerdict[] {
  // "d" = down, "u" = up, one char per minute from startMinute
  return pattern.split('').map((c, i) => ({
    minute: base + (startMinute + i) * 60_000,
    down: c === 'd',
    reporters: 1,
    failing: c === 'd' ? 1 : 0,
  }));
}

describe('shouldOpen', () => {
  it('opens after three consecutive down minutes that end now', () => {
    expect(shouldOpen(verdicts('uuddd', 1), now)).toBe(true); // minutes 1..5, last is 10:05
  });
  it('does not open on two down minutes or on a gap', () => {
    expect(shouldOpen(verdicts('uuudd', 1), now)).toBe(false);
    const gappy = verdicts('ddd', 0).map((v, i) => (i === 2 ? { ...v, minute: v.minute + 60_000 * 3 } : v));
    expect(shouldOpen(gappy, now)).toBe(false);
  });
  it('does not open on stale verdicts', () => {
    expect(shouldOpen(verdicts('ddd', 0), new Date(base + 30 * 60_000))).toBe(false);
  });
});

describe('shouldResolve', () => {
  it('resolves after five clean consecutive minutes', () => {
    expect(shouldResolve(verdicts('duuuuu', 0), now)).toBe(true);
  });
  it('keeps the incident open while a down minute is among the last five', () => {
    expect(shouldResolve(verdicts('uuduuu', 0), now)).toBe(false);
    expect(shouldResolve(verdicts('uuuu', 2), now)).toBe(false);
  });
});
