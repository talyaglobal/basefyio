import { ProjectPoliciesService } from './project-policies.service';

/** #249: the opt-in switch of auth.uid() from text to uuid. */
function harness(opts: { returns?: string | null; users?: string[]; failOn?: RegExp }) {
  const client = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (opts.failOn && opts.failOn.test(sql)) throw Object.assign(new Error('cannot drop'), { code: '2BP01' });
      if (/pg_get_function_result/.test(sql)) {
        return opts.returns === null ? { rows: [], rowCount: 0 } : { rows: [{ returns: opts.returns ?? 'text' }], rowCount: 1 };
      }
      if (/WITH uid AS/.test(sql)) {
        const rows = (opts.users ?? []).map((what) => ({ what }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = { withProjectDb: jest.fn((_p: string, _u: string, fn: (c: any) => Promise<unknown>, _asAdmin?: boolean) => fn(client)) };
  return { svc: new ProjectPoliciesService(db as any), client, db };
}
const sent = (c: { query: jest.Mock }) => c.query.mock.calls.map(([s]: [string]) => s.replace(/\s+/g, ' ').trim());

describe('ProjectPoliciesService.convertUidToUuid', () => {
  it('runs as the admin connection', async () => {
    const { svc, db } = harness({});
    await svc.convertUidToUuid('p1', 'u1');
    expect((db.withProjectDb.mock.calls[0] as unknown[])[3]).toBe(true);
  });

  it('switches a text helper nothing uses, in one transaction', async () => {
    const { svc, client } = harness({});
    const r = await svc.convertUidToUuid('p1', 'u1');
    expect(r).toMatchObject({ changed: true, uid: 'uuid', blockers: [] });
    const s = sent(client);
    const begin = s.indexOf('BEGIN');
    expect(s.slice(begin)).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '5s'",
      'DROP FUNCTION auth.uid()',
      expect.stringMatching(/^CREATE FUNCTION auth\.uid\(\) RETURNS uuid/),
      'GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role',
      'COMMIT',
    ]);
  });

  it('refuses, changing nothing, while policies or defaults still use auth.uid()', async () => {
    const { svc, client } = harness({ users: ['policy own on public.notes', 'default of public.notes.owner'] });
    const r = await svc.convertUidToUuid('p1', 'u1');
    expect(r.changed).toBe(false);
    expect(r.blockers).toEqual(['policy own on public.notes', 'default of public.notes.owner']);
    expect(sent(client)).not.toContain('BEGIN');
  });

  it('does nothing when the helper already returns uuid, or is missing', async () => {
    const a = harness({ returns: 'uuid' });
    expect((await a.svc.convertUidToUuid('p1', 'u1')).changed).toBe(false);
    expect(sent(a.client)).not.toContain('BEGIN');
    const b = harness({ returns: null });
    expect((await b.svc.convertUidToUuid('p1', 'u1')).uid).toBeNull();
  });

  it('a dry run only reports', async () => {
    const { svc, client } = harness({});
    const r = await svc.convertUidToUuid('p1', 'u1', { dryRun: true });
    expect(r.changed).toBe(false);
    expect(sent(client)).not.toContain('BEGIN');
  });

  it('rolls back when Postgres refuses the drop', async () => {
    const { svc, client } = harness({ failOn: /^DROP FUNCTION/ });
    await expect(svc.convertUidToUuid('p1', 'u1')).rejects.toBeDefined();
    expect(sent(client)).toContain('ROLLBACK');
    expect(sent(client)).not.toContain('COMMIT');
  });
});
