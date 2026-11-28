import { projectsToClear, tlsUsersFromClients } from './db-tls-notice';
import { DbTlsNoticeService } from './db-tls-notice.service';

describe('db TLS notice', () => {
  const rows = [
    { type: 'C', user: 'kb_user_a', database: 'kb_a', state: 'active', tls: 'TLSv1.3/TLS_AES_256_GCM_SHA384/ECDH=X25519' },
    { type: 'C', user: 'kb_user_b', database: 'kb_b', state: 'idle', tls: '' },
    { type: 'C', user: 'kb_user_c', database: 'kb_c', state: 'active', tls: null },
    { type: 'C', user: 'kb_user_b', database: 'kb_b', state: 'idle', tls: '' },
    { type: 'C', user: 'pgbouncer_admin', database: 'pgbouncer', state: 'active', tls: 'TLSv1.2/ECDHE-RSA-AES256-GCM-SHA384' },
    { type: 'C', database: 'kb_x', tls: 'TLSv1.3' },
  ];

  it('collects only users with an encrypted client', () => {
    expect([...tlsUsersFromClients(rows)].sort()).toEqual(['kb_user_a', 'pgbouncer_admin']);
  });

  it('tolerates empty or malformed input', () => {
    expect(tlsUsersFromClients([]).size).toBe(0);
    expect(tlsUsersFromClients([{ user: 'u', tls: 'none' }, { user: 7 as any, tls: 'TLSv1.3' }]).size).toBe(0);
  });

  it('clears a flagged project only when its own user is on TLS', () => {
    const flagged = [
      { id: 'p1', dbUser: 'kb_user_a' },
      { id: 'p2', dbUser: 'kb_user_b' },
      { id: 'p3', dbUser: '' },
    ];
    expect(projectsToClear(flagged, tlsUsersFromClients(rows))).toEqual(['p1']);
    expect(projectsToClear(flagged, new Set())).toEqual([]);
  });

  describe('service run', () => {
    function make(opts: { flagged: Array<{ id: string; dbUser: string }>; clients?: any[]; fail?: boolean }) {
      const prisma = {
        project: {
          findMany: jest.fn().mockResolvedValue(opts.flagged),
          updateMany: jest.fn().mockImplementation(({ where }) => Promise.resolve({ count: where.id.in.length })),
        },
      };
      const pgbouncer = {
        showClients: jest.fn().mockImplementation(() =>
          opts.fail ? Promise.reject(new Error('connect ECONNREFUSED')) : Promise.resolve(opts.clients ?? []),
        ),
      };
      const leader = { isLeader: () => true };
      const svc = new DbTlsNoticeService(prisma as any, pgbouncer as any, leader as any);
      (svc as any).logger = { warn: jest.fn(), log: jest.fn() };
      return { svc, prisma, pgbouncer };
    }

    it('does not read the pooler when nothing is flagged', async () => {
      const { svc, pgbouncer, prisma } = make({ flagged: [] });
      expect(await svc.run()).toBe(0);
      expect(pgbouncer.showClients).not.toHaveBeenCalled();
      expect(prisma.project.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed and warns once when the admin console is unreachable', async () => {
      const { svc, prisma } = make({ flagged: [{ id: 'p1', dbUser: 'kb_user_a' }], fail: true });
      expect(await svc.run()).toBe(0);
      expect(prisma.project.updateMany).not.toHaveBeenCalled();
      expect((svc as any).logger.warn).toHaveBeenCalledTimes(1);
    });

    it('clears the notice of projects seen on TLS', async () => {
      const { svc, prisma } = make({
        flagged: [{ id: 'p1', dbUser: 'kb_user_a' }, { id: 'p2', dbUser: 'kb_user_b' }],
        clients: rows,
      });
      expect(await svc.run()).toBe(1);
      expect(prisma.project.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['p1'] }, dbTlsNoticeAt: { not: null } },
        data: { dbTlsNoticeAt: null },
      });
    });
  });
});
