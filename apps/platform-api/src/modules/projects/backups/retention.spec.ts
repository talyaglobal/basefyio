import {
  autoBackupRetentionDays,
  backupTrigger,
  countClusterBases,
  pitrClusterBaseRetain,
  pitrRetentionDays,
  snapshotTooRecent,
} from './retention';

describe('backup retention settings', () => {
  it('keeps today\'s defaults when nothing is configured', () => {
    expect(pitrRetentionDays({})).toBe(7);
    expect(pitrClusterBaseRetain({})).toBe(3);
    expect(autoBackupRetentionDays({})).toBe(7);
  });

  it('reads the environment and caps typos', () => {
    expect(pitrRetentionDays({ PITR_RETENTION_DAYS: '30' })).toBe(30);
    expect(pitrRetentionDays({ PITR_RETENTION_DAYS: '300' })).toBe(35);
    expect(pitrRetentionDays({ PITR_RETENTION_DAYS: 'abc' })).toBe(7);
    expect(pitrClusterBaseRetain({ PITR_CLUSTER_BASE_RETAIN: '5' })).toBe(5);
    expect(autoBackupRetentionDays({ AUTO_BACKUP_RETENTION_DAYS: '1000' })).toBe(90);
  });

  it('tells nightly archives from on-demand ones', () => {
    expect(backupTrigger('p1/42-auto-backup-shop-2026-10-22T03-00-00-000Z.zip')).toBe('scheduled');
    expect(backupTrigger('p1/42-auto-backup-shop-2026.zip.enc')).toBe('scheduled');
    expect(backupTrigger('p1/43-backup-shop-2026-10-22T10-00-00-000Z.zip')).toBe('on-demand');
  });
});

describe('point-in-time snapshot helpers', () => {
  it('counts physical bases by their folder, not by file', () => {
    expect(
      countClusterBases(
        ['_cluster/base/2026-10-20/base.tar.gz', '_cluster/base/2026-10-20/pg_wal.tar.gz', '_cluster/base/2026-10-21/base.tar.gz'],
        '_cluster/base/',
      ),
    ).toBe(2);
    expect(countClusterBases([], '_cluster/base/')).toBe(0);
  });

  it('refuses a snapshot within ten minutes of the last one and says how long ago it was', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    expect(snapshotTooRecent(now - 2 * 60_000, now)).toBe(2);
    expect(snapshotTooRecent(now - 10_000, now)).toBe(1);
    expect(snapshotTooRecent(now - 11 * 60_000, now)).toBeNull();
    expect(snapshotTooRecent(0, now)).toBeNull();
  });
});
