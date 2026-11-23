jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { StandbyProbeService, standbyProblems } from './standby-probe.service';

/** #229: the standby is watched; two failing checks raise a critical alert. */
describe('standbyProblems', () => {
  const ok = { slot_name: 'bf_standby_1', active: true, wal_status: 'reserved', retained_bytes: '1024' };
  it('is quiet for a connected slot that keeps up', () => {
    expect(standbyProblems(['bf_standby_1'], [ok])).toEqual([]);
  });
  it('names a missing, disconnected, lost or lagging slot', () => {
    expect(standbyProblems(['bf_standby_1'], [])).toEqual(['bf_standby_1: replication slot is missing']);
    expect(standbyProblems(['bf_standby_1'], [{ ...ok, active: false }])[0]).toContain('not connected');
    expect(standbyProblems(['bf_standby_1'], [{ ...ok, wal_status: 'lost' }])[0]).toContain('rebuilt');
    expect(standbyProblems(['bf_standby_1'], [{ ...ok, retained_bytes: String(9 * 1024 ** 3) }])[0]).toContain('9.0 GB');
  });
});

describe('StandbyProbeService', () => {
  function build(rows: unknown[], slots = 'bf_standby_1') {
    const prisma = { $queryRaw: jest.fn(async () => rows) };
    const alerts = { raise: jest.fn(async () => undefined) };
    const svc = new StandbyProbeService(prisma as any, { get: () => slots } as any, alerts as any);
    return { svc, prisma, alerts };
  }
  it('checks nothing without PG_STANDBY_SLOTS', async () => {
    const { svc, prisma } = build([], '');
    expect(await svc.run()).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('alerts on the second failing run, not the first', async () => {
    const { svc, alerts } = build([{ slot_name: 'bf_standby_1', active: false, wal_status: 'reserved', retained_bytes: '0' }]);
    await svc.run();
    expect(alerts.raise).not.toHaveBeenCalled();
    await svc.run();
    expect(alerts.raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pg_standby_unhealthy', severity: 'critical' }));
  });
});
