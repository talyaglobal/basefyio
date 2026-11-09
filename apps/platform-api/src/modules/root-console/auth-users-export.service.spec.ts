import { AuthUsersExportService, csvCell, hasRealEmail, toCsv } from './auth-users-export.service';

describe('auth users export', () => {
  it('quotes cells and doubles embedded quotes', () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(true)).toBe('"true"');
  });

  it('neutralises spreadsheet formulas', () => {
    for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(v)).toBe(`"'${v}"`);
    expect(csvCell('a=b')).toBe('"a=b"');
  });

  it('writes a header and one line per row', () => {
    const row = { projectId: 'p', projectName: '=evil', teamName: 't', email: 'a@b.co', firstName: '', lastName: '', emailVerified: true, enabled: false, createdAt: '2026-01-01T00:00:00.000Z' };
    const lines = toCsv([row]).trim().split('\r\n');
    expect(lines[0]).toBe('projectId,projectName,teamName,email,firstName,lastName,emailVerified,enabled,createdAt');
    expect(lines[1]).toContain(`"'=evil"`);
  });

  it('skips anonymous and synthetic addresses', () => {
    expect(hasRealEmail({ email: 'a@b.co' })).toBe(true);
    expect(hasRealEmail({ email: 'x@anonymous.invalid' })).toBe(false);
    expect(hasRealEmail({ email: 'a@b.co', isAnonymous: true })).toBe(false);
    expect(hasRealEmail({ email: '' })).toBe(false);
    expect(hasRealEmail({ email: null })).toBe(false);
  });

  it('reports a failing project in errors and keeps the others', async () => {
    const prisma = {
      project: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'p1', name: 'One', keycloakRealm: 'r1', team: { name: 'T' } },
          { id: 'p2', name: 'Two', keycloakRealm: 'r2', team: { name: 'T' } },
        ]),
      },
    };
    const keycloak = {
      listAllUsers: jest.fn(async (realm: string) => {
        if (realm === 'r2') throw new Error('realm gone');
        return [
          { email: 'a@b.co', firstName: 'A', lastName: 'B', enabled: true, emailVerified: false, createdTimestamp: 0 },
          { email: 'anon@anonymous.invalid', isAnonymous: true },
        ];
      }),
    };
    const svc = new AuthUsersExportService(prisma as any, keycloak as any);
    const out = await svc.collect();
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ projectId: 'p1', email: 'a@b.co', teamName: 'T' });
    expect(out.errors).toEqual([{ projectId: 'p2', projectName: 'Two', error: 'realm gone' }]);
    expect(prisma.project.findMany.mock.calls[0][0].where.status).toEqual({ not: 'DELETED' });
  });
});
