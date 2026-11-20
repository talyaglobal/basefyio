import { planBucketOwnerBackfill, rowsToWrite } from './bucket-owner-backfill';

const day = (d: string) => new Date(`2026-${d}T00:00:00Z`);
const P = (id: string, slug: string, createdAt: string, status = 'ACTIVE', storagePrefix: string | null = null) => ({
  id,
  slug,
  storagePrefix,
  status,
  createdAt: day(createdAt),
});

describe('planBucketOwnerBackfill', () => {
  const projects = [P('a', 'a', '01-01'), P('ab', 'a-b', '05-01'), P('pl', 'platform_data', '01-01')];
  const plan = (buckets: Array<[string, string]>, owners: Record<string, string> = {}, assign: Record<string, string> = {}) =>
    planBucketOwnerBackfill({
      bucketPrefix: 'bf-',
      buckets: buckets.map(([name, d]) => ({ name, creationDate: day(d) })),
      projects,
      owners: new Map(Object.entries(owners)),
      assignments: new Map(Object.entries(assign)),
    });

  it('sorts buckets into recorded, unambiguous, dated, ambiguous, platform and orphan', () => {
    const out = plan(
      [
        ['bf-a-docs', '02-01'],
        ['bf-a-b-old', '02-01'], // only a existed then
        ['bf-a-b-new', '06-01'], // both existed: ambiguous
        ['bf-a-b-kept', '06-01'],
        ['bf-platform-data-imports', '01-02'],
        ['bf-gone-x', '01-02'],
      ],
      { 'bf-a-b-kept': 'ab' },
    );
    const kinds = Object.fromEntries(out.decisions.map((d) => [d.physical, d.kind]));
    expect(kinds).toEqual({
      'bf-a-docs': 'unambiguous',
      'bf-a-b-old': 'dated',
      'bf-a-b-new': 'ambiguous',
      'bf-a-b-kept': 'recorded',
      'bf-platform-data-imports': 'platform',
      'bf-gone-x': 'orphan',
    });
    const amb = out.decisions.find((d) => d.physical === 'bf-a-b-new') as any;
    expect(amb.listedUnder).toBe('ab');
    expect(out.overlappingPairs).toEqual([['a', 'ab']]);
  });

  it('writes unambiguous rows by default, dated ones only when asked', () => {
    const out = plan([
      ['bf-a-docs', '02-01'],
      ['bf-a-b-old', '02-01'],
      ['bf-a-b-new', '06-01'],
    ]);
    expect(rowsToWrite(out, { dated: false })).toEqual([{ physicalName: 'bf-a-docs', projectId: 'a' }]);
    expect(rowsToWrite(out, { dated: true })).toEqual([
      { physicalName: 'bf-a-docs', projectId: 'a' },
      { physicalName: 'bf-a-b-old', projectId: 'a' },
    ]);
  });

  it('--assign resolves an ambiguous bucket only to a project whose prefix matches', () => {
    const ok = plan([['bf-a-b-new', '06-01']], {}, { 'bf-a-b-new': 'ab' });
    expect(rowsToWrite(ok, { dated: false })).toEqual([{ physicalName: 'bf-a-b-new', projectId: 'ab' }]);
    const bad = plan([['bf-a-b-new', '06-01']], {}, { 'bf-a-b-new': 'pl' });
    expect(rowsToWrite(bad, { dated: false })).toEqual([]);
    expect(bad.rejectedAssignments).toEqual([
      { physical: 'bf-a-b-new', projectId: 'pl', reason: 'project prefix does not match this bucket' },
    ]);
  });

  it('a deleted project counts as a candidate', () => {
    const out = planBucketOwnerBackfill({
      bucketPrefix: 'bf-',
      buckets: [{ name: 'bf-a-b-x', creationDate: day('06-01') }],
      projects: [P('a', 'a', '01-01'), P('ab', 'a-b', '05-01', 'DELETED')],
      owners: new Map(),
    });
    expect(out.decisions[0].kind).toBe('ambiguous');
  });
});
