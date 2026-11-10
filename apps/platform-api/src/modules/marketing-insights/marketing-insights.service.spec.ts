import { weightedPosition } from './marketing-insights.service';

describe('weightedPosition', () => {
  it('weighs each day by its impressions', () => {
    // 1 impression at position 10 must not pull a 100-impression day at position 2 to 6
    const p = weightedPosition([
      { impressions: 100, position: 2 },
      { impressions: 1, position: 10 },
    ]);
    expect(p).toBeCloseTo(2.08, 2);
  });
  it('is 0 without impressions', () => {
    expect(weightedPosition([])).toBe(0);
  });
});
