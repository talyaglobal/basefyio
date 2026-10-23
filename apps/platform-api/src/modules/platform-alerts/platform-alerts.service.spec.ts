import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PlatformAlertsService } from './platform-alerts.service';

/** An in-memory stand-in for the platform_alerts table. */
function fakePrisma() {
  const rows = new Map<string, any>();
  return {
    rows,
    platformAlert: {
      createMany: async ({ data }: { data: any[] }) => {
        let count = 0;
        for (const d of data) {
          if (rows.has(d.id)) continue;
          rows.set(d.id, { acknowledgedAt: null, acknowledgedBy: null, metadata: null, ...d });
          count++;
        }
        return { count };
      },
      create: async ({ data }: { data: any }) => {
        rows.set(data.id, { acknowledgedAt: null, acknowledgedBy: null, ...data });
        return data;
      },
      findMany: async () =>
        [...rows.values()]
          .filter((r) => r.acknowledgedAt === null)
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()),
      findFirst: async ({ where }: any) =>
        [...rows.values()].find(
          (r) => r.kind === where.kind && r.acknowledgedAt === null && r.occurredAt >= where.occurredAt.gte,
        ) ?? null,
      findUnique: async ({ where }: any) => rows.get(where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows.values()) {
          if (r.acknowledgedAt !== null || (where.id && r.id !== where.id)) continue;
          Object.assign(r, data);
          count++;
        }
        return { count };
      },
    },
  };
}

function setup(required = true) {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-'));
  const prisma = fakePrisma();
  const config = {
    get: (key: string) =>
      ({ 'disk.autopilotDir': dir, 'disk.autopilotRequired': required } as Record<string, unknown>)[key],
  };
  const svc = new PlatformAlertsService(prisma as any, config as any);
  return { dir, prisma, svc };
}

const event = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    at: '2026-10-23T10:00:00.000Z',
    source: 'storage-autopilot',
    kind: 'volume_grown',
    severity: 'critical',
    title: 'Data volume grew automatically from 608 GB to 710 GB',
    detail: 'It grew because usage reached 81%.',
    metadata: { fromGb: 608, toGb: 710 },
    ...extra,
  });

const freshStatus = (growth: Record<string, unknown>) =>
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    thresholds: { growAtPercent: 80, maxSizeGb: 2048 },
    errors: [],
    data: { blockBytes: 608 * 1024 ** 3, usedPercent: 42, growth },
  });

const disk = (usedPercent: number) => ({
  key: 'data',
  label: 'Data volume',
  available: true,
  usedPercent,
  availableBytes: 10 * 1024 ** 3,
  criticalPercent: 90,
});

describe('PlatformAlertsService', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('imports the host event log once, skipping malformed lines', async () => {
    const { dir, prisma, svc } = setup();
    dirs.push(dir);
    writeFileSync(join(dir, 'status.json'), freshStatus({ configured: true, tokenOk: true }));
    writeFileSync(
      join(dir, 'events.jsonl'),
      [event('a1'), 'not json', JSON.stringify({ id: 'x' }), event('a2', { severity: 'loud' })].join('\n') + '\n',
    );

    const feed = await svc.getFeed([disk(42)]);
    expect(feed.alerts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    // An unknown severity is shown, but never louder than a warning.
    expect(feed.alerts.find((a) => a.id === 'a2')?.severity).toBe('warning');
    expect(feed.conditions).toEqual([]);

    // A second read of the same log adds nothing.
    await svc.getFeed([disk(42)]);
    expect(prisma.rows.size).toBe(2);
  });

  it('keeps an acknowledged event acknowledged when the log is re-read', async () => {
    const { dir, svc } = setup();
    dirs.push(dir);
    writeFileSync(join(dir, 'status.json'), freshStatus({ configured: true, tokenOk: true }));
    writeFileSync(join(dir, 'events.jsonl'), event('b1') + '\n');
    await svc.getFeed([]);
    await svc.acknowledge('b1', 'root-user');

    writeFileSync(join(dir, 'events.jsonl'), event('b1') + '\n' + event('b2') + '\n');
    const feed = await svc.getFeed([]);
    expect(feed.alerts.map((a) => a.id)).toEqual(['b2']);
  });

  it('raises live conditions for a full disk and an autopilot that cannot grow', async () => {
    const { dir, svc } = setup();
    dirs.push(dir);
    writeFileSync(join(dir, 'status.json'), freshStatus({ configured: false, tokenOk: null }));

    const feed = await svc.getFeed([disk(93)]);
    expect(feed.conditions.map((c) => c.key).sort()).toEqual(['autopilot_no_token', 'disk_data']);
    expect(feed.autopilot.growthConfigured).toBe(false);
  });

  it('reports a missing or silent autopilot only when it is required', async () => {
    const missing = setup(true);
    dirs.push(missing.dir);
    expect((await missing.svc.getFeed([])).conditions.map((c) => c.key)).toEqual(['autopilot_missing']);

    const optional = setup(false);
    dirs.push(optional.dir);
    expect((await optional.svc.getFeed([])).conditions).toEqual([]);

    const silent = setup(true);
    dirs.push(silent.dir);
    writeFileSync(
      join(silent.dir, 'status.json'),
      JSON.stringify({ checkedAt: new Date(Date.now() - 20 * 60_000).toISOString(), data: { growth: { configured: true } } }),
    );
    expect((await silent.svc.getFeed([])).conditions.map((c) => c.key)).toEqual(['autopilot_stale']);
  });

  it('absorbs repeats of an API-raised alert until it is acknowledged', async () => {
    const { dir, prisma, svc } = setup(false);
    dirs.push(dir);
    const alert = { kind: 'restore_refused_space', severity: 'critical' as const, title: 'Refused' };
    await svc.raise(alert);
    await svc.raise(alert);
    expect(prisma.rows.size).toBe(1);

    await svc.acknowledgeAll('root-user');
    await svc.raise(alert);
    expect(prisma.rows.size).toBe(2);
  });
});
