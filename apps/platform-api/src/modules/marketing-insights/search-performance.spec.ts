import { weightedAveragePosition } from './search-performance';

describe('weightedAveragePosition', () => {
  it('weights each day by its impressions', () => {
    // Two quiet days near the top, one busy day at 7.1.
    const rows = [
      { impressions: 1, position: 1 },
      { impressions: 1, position: 1.5 },
      { impressions: 1000, position: 7.1 },
    ];
    // The plain mean of the days would be 3.2.
    expect(weightedAveragePosition(rows)).toBe(7.1);
  });

  it('ignores rows without impressions and returns 0 when there is no data', () => {
    expect(weightedAveragePosition([{ impressions: 0, position: 1 }])).toBe(0);
    expect(weightedAveragePosition([])).toBe(0);
    expect(weightedAveragePosition([{ impressions: 10, position: 4 }, { impressions: 30, position: 8 }])).toBe(7);
  });
});
