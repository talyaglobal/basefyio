import { DEFAULT_INFRA_COST_CONFIG, type CostLine, type ProjectCostReport } from './project-cost.pricing';
import {
  aggregateUsageRecords,
  cents,
  parseUsagePeriod,
  priceOtherUsage,
  reconcileTeamUsage,
  sumCustomerRows,
  toCustomerProjectView,
} from './team-cost-report';

const GiB = 1024 ** 3;
const october = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
const november = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') };

function line(key: CostLine['key'], pricedUsd: number, projectedPricedUsd = pricedUsd): CostLine {
  return {
    key,
    label: key,
    quantity: 0,
    unit: 'GB',
    detail: '',
    rawUsd: pricedUsd / 2.5,
    pricedUsd,
    projectedRawUsd: projectedPricedUsd / 2.5,
    projectedPricedUsd,
  };
}

function report(id: string, lines: CostLine[]): ProjectCostReport {
  const sum = (pick: (l: CostLine) => number) => lines.reduce((s, l) => s + pick(l), 0);
  return {
    projectId: id,
    name: id,
    slug: id,
    status: 'ACTIVE',
    computeTier: 'Micro',
    activeHours: 500,
    dbSizeBytes: 0,
    storageBytes: 0,
    apiRequests: 0,
    bandwidthBytes: 0,
    lines,
    rawUsd: sum((l) => l.rawUsd),
    pricedUsd: sum((l) => l.pricedUsd),
    projectedRawUsd: sum((l) => l.projectedRawUsd),
    projectedPricedUsd: sum((l) => l.projectedPricedUsd),
  };
}

describe('cents', () => {
  it('rounds half a cent up, including values binary floating point stores just below it', () => {
    expect(cents(1.005)).toBe(1.01);
    expect(cents(1.8254)).toBe(1.83);
    expect(cents(1.8249)).toBe(1.82);
    expect(cents(0)).toBe(0);
  });
});

describe('customer totals add up to the rows shown (#69)', () => {
  // Three projects whose exact totals are $1.8254, $1.8249 and $1.8249. Shown
  // rounded they read $1.83 + $1.82 + $1.82 = $5.47, but the old total was the
  // exact sum $5.4752 rounded on its own: "$5.48".
  const projects = [
    report('a', [line('compute', 1.2), line('database', 0.6254)]),
    report('b', [line('compute', 1.2), line('database', 0.6249)]),
    report('c', [line('compute', 1.2), line('database', 0.6249)]),
  ].map(toCustomerProjectView);

  it('rounds every line to the cent and sums the rounded lines per project', () => {
    expect(projects.map((p) => p.amountUsd)).toEqual([1.83, 1.82, 1.82]);
    expect(projects[0].lines.map((l) => l.amountUsd)).toEqual([1.2, 0.63]);
  });

  it('makes the total the sum of the project rows: $5.47, not $5.48', () => {
    expect(sumCustomerRows(projects, []).amountUsd).toBe(5.47);
  });

  it('adds the other-usage rows into the same total', () => {
    const totals = sumCustomerRows(projects, [{ amountUsd: 0.05, projectedUsd: 0.05 }]);
    expect(totals.amountUsd).toBe(5.52);
  });
});

describe('reconcileTeamUsage (#180)', () => {
  it('splits the QA team’s constant gap into trashed/deactivated projects and the remainder', () => {
    // Idea team: the usage card showed 1,301,837 requests, the project rows
    // 1,031,096; deleted projects accounted for 2,190 of the 270,741 gap.
    const split = reconcileTeamUsage({
      team: { apiRequests: 1_301_837, bandwidthBytes: 73_640_000_000 },
      projects: { apiRequests: 1_031_096, bandwidthBytes: 56_640_000_000 },
      inactive: { apiRequests: 2_190, bandwidthBytes: 16_900_000 },
    });
    expect(split.inactive).toEqual({ apiRequests: 2_190, bandwidthBytes: 16_900_000 });
    expect(split.unattributed).toEqual({ apiRequests: 268_551, bandwidthBytes: 16_983_100_000 });
    // Rows + other usage = the team counter, exactly.
    expect(1_031_096 + split.inactive.apiRequests + split.unattributed.apiRequests).toBe(1_301_837);
    expect(56_640_000_000 + split.inactive.bandwidthBytes + split.unattributed.bandwidthBytes).toBe(73_640_000_000);
  });

  it('never produces a negative row when the team counter is short', () => {
    const split = reconcileTeamUsage({
      team: { apiRequests: 900, bandwidthBytes: 1_000 },
      projects: { apiRequests: 1_000, bandwidthBytes: 2_000 },
      inactive: { apiRequests: 50, bandwidthBytes: 10 },
    });
    expect(split.inactive).toEqual({ apiRequests: 0, bandwidthBytes: 0 });
    expect(split.unattributed).toEqual({ apiRequests: 0, bandwidthBytes: 0 });
  });

  it('caps the trashed/deactivated share at what the gap actually holds', () => {
    const split = reconcileTeamUsage({
      team: { apiRequests: 1_100, bandwidthBytes: 0 },
      projects: { apiRequests: 1_000, bandwidthBytes: 0 },
      inactive: { apiRequests: 250, bandwidthBytes: 0 },
    });
    expect(split.inactive.apiRequests).toBe(100);
    expect(split.unattributed.apiRequests).toBe(0);
  });
});

describe('priceOtherUsage', () => {
  it('prices only traffic, at the customer egress rate, and does not project it forward', () => {
    // 17 GiB × $0.0011/GiB × 2.5 markup = $0.04675 → $0.05
    const row = priceOtherUsage(DEFAULT_INFRA_COST_CONFIG, october, 'unattributed', {
      apiRequests: 268_551,
      bandwidthBytes: 17 * GiB,
    })!;
    expect(row.lines.map((l) => l.key)).toEqual(['egress', 'api_requests']);
    expect(row.lines[0].amountUsd).toBe(0.05);
    expect(row.lines[1].detail).toBe('268,551 requests');
    expect(row.amountUsd).toBe(0.05);
    expect(row.projectedUsd).toBe(row.amountUsd);
    expect(row.label).toBe('Earlier and removed projects');
  });

  it('drops the pre-metering wording once a period starts after metering began', () => {
    const row = priceOtherUsage(DEFAULT_INFRA_COST_CONFIG, november, 'unattributed', {
      apiRequests: 10,
      bandwidthBytes: 0,
    })!;
    expect(row.label).toBe('Removed projects');
    expect(row.description).not.toMatch(/October 8/);
  });

  it('returns nothing for an empty row', () => {
    expect(priceOtherUsage(DEFAULT_INFRA_COST_CONFIG, october, 'inactive_projects', { apiRequests: 0, bandwidthBytes: 0 })).toBeNull();
  });
});

describe('parseUsagePeriod', () => {
  it('maps YYYY-MM to that UTC calendar month', () => {
    expect(parseUsagePeriod('2026-10')).toEqual(october);
    expect(parseUsagePeriod('2026-12')!.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects anything else', () => {
    for (const bad of ['2026-13', '2026-1', '26-10', '', null, undefined, '2026-10-01']) {
      expect(parseUsagePeriod(bad as any)).toBeNull();
    }
  });
});

describe('aggregateUsageRecords', () => {
  it('folds month-end rows into team totals and per-project metrics', () => {
    const out = aggregateUsageRecords([
      { projectId: null, metric: 'api_requests', value: BigInt(1500) },
      { projectId: null, metric: 'bandwidth', value: BigInt(4096) },
      { projectId: null, metric: 'mau', value: BigInt(7) },
      { projectId: 'p1', metric: 'api_requests', value: BigInt(1000) },
      { projectId: 'p1', metric: 'db_size_bytes', value: BigInt(8 * 1024 * 1024) },
      { projectId: 'p2', metric: 'bandwidth', value: BigInt(1024) },
    ]);
    expect(out.team).toEqual({ apiRequests: 1500, bandwidthBytes: 4096, storageBytes: 0, dbSizeBytes: 0 });
    expect(out.projects.get('p1')).toEqual({ apiRequests: 1000, bandwidthBytes: 0, storageBytes: 0, dbSizeBytes: 8 * 1024 * 1024 });
    expect(out.projects.get('p2')!.bandwidthBytes).toBe(1024);
  });
});
