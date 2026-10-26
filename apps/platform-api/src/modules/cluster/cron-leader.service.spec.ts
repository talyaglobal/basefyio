import { Logger } from '@nestjs/common';
import { MetricsService } from '../health/metrics.service';
import { CRON_LEADER_KEY, CronLeaderService } from './cron-leader.service';

/**
 * A stand-in for the `cron` package's CronJob: the three members the service
 * touches, with start/stop flipping the flag the way the real one does.
 */
type FakeJob = { isActive: boolean; start: jest.Mock; stop: jest.Mock };

const fakeJob = (active: boolean): FakeJob => {
  const job: FakeJob = { isActive: active, start: jest.fn(), stop: jest.fn() };
  job.start.mockImplementation(() => {
    job.isActive = true;
  });
  job.stop.mockImplementation(() => {
    job.isActive = false;
  });
  return job;
};

const ENV_KEYS = [
  'CRON_LEADER_ELECTION',
  'CRON_LEADER_TTL_MS',
  'CRON_LEADER_RENEW_MS',
  'CRON_LEADER_WHEN_REDIS_DOWN',
  'IMAGE_TAG',
];

/** Lease taken or renewed. */
const granted = () => jest.fn().mockResolvedValue(1);
/** Another replica holds the lease. */
const refused = () => jest.fn().mockResolvedValue(0);
/** Redis is unreachable. */
const failing = () => jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

const build = (
  evalMock: jest.Mock,
  jobs: FakeJob[] = [fakeJob(true)],
  env: Record<string, string> = {},
) => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const getCronJobs = jest.fn(() => new Map(jobs.map((job, i) => [`job-${i}`, job])));
  const redis = { getClient: () => ({ eval: evalMock }), getDurableClient: () => ({ eval: evalMock }) } as any;
  const metrics = new MetricsService();
  const svc = new CronLeaderService(redis, { getCronJobs } as any, metrics);
  // The election round is private on purpose; the tests drive it directly so
  // they do not depend on timers.
  const tick = () => (svc as any).tick() as Promise<void>;
  return { svc, metrics, getCronJobs, tick };
};

describe('CronLeaderService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe('deciding who runs the schedule', () => {
    it('takes a free lease and starts the jobs Nest left paused', async () => {
      const job = fakeJob(false);
      const { svc, tick } = build(granted(), [job]);
      await tick();
      expect(job.start).toHaveBeenCalledTimes(1);
      expect(job.stop).not.toHaveBeenCalled();
      expect(svc.getRole()).toBe('leader');
      expect(svc.isLeader()).toBe(true);
    });

    it('defers to the replica holding the lease and stops its own active jobs', async () => {
      const job = fakeJob(true);
      const { svc, tick } = build(refused(), [job]);
      await tick();
      expect(job.stop).toHaveBeenCalledTimes(1);
      expect(job.start).not.toHaveBeenCalled();
      expect(svc.getRole()).toBe('follower');
      expect(svc.isLeader()).toBe(false);
    });

    it('leaves a job alone when it already matches the role', async () => {
      const job = fakeJob(true);
      const { tick } = build(granted(), [job]);
      await tick();
      await tick();
      expect(job.start).not.toHaveBeenCalled();
      expect(job.stop).not.toHaveBeenCalled();
    });

    it('hands the jobs over and back as the lease moves between replicas', async () => {
      const job = fakeJob(true);
      const evalMock = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const { svc, tick } = build(evalMock, [job]);
      await tick();
      expect(svc.getRole()).toBe('leader');
      await tick();
      expect(svc.getRole()).toBe('follower');
      expect(job.stop).toHaveBeenCalledTimes(1);
      await tick();
      expect(svc.getRole()).toBe('leader');
      expect(job.start).toHaveBeenCalledTimes(1);
    });

    /**
     * The registry is consulted on every round rather than once: a job mounted
     * after the first decision, or added by a module loaded later, must be
     * governed too.
     */
    it('governs jobs that appear in the registry after the first round', async () => {
      const early = fakeJob(true);
      const late = fakeJob(true);
      const jobs = [early];
      const { tick } = build(refused(), jobs);
      await tick();
      jobs.push(late);
      await tick();
      expect(late.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe('the lease itself', () => {
    it('is keyed under one well-known name, owned by this instance, for the configured TTL', async () => {
      const evalMock = granted();
      const { svc, tick } = build(evalMock, [fakeJob(true)], { CRON_LEADER_TTL_MS: '5000' });
      await tick();
      const [script, numKeys, key, owner, ttl] = evalMock.mock.calls[0];
      expect(script).toMatch(/PEXPIRE/);
      expect(numKeys).toBe(1);
      expect(key).toBe(CRON_LEADER_KEY);
      expect(owner).toBe(svc.getInstanceId());
      expect(ttl).toBe('5000');
    });

    it('defaults the TTL to 30 seconds and ignores a malformed override', async () => {
      const evalMock = granted();
      const { tick } = build(evalMock, [fakeJob(true)], { CRON_LEADER_TTL_MS: 'soon' });
      await tick();
      expect(evalMock.mock.calls[0][4]).toBe('30000');
    });

    it('gives two instances on the same host different identities', () => {
      const a = build(granted()).svc.getInstanceId();
      const b = build(granted()).svc.getInstanceId();
      expect(a).not.toBe(b);
    });
  });

  describe('when Redis is unreachable', () => {
    it('keeps the leader running through a blip shorter than one TTL', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') });
      const job = fakeJob(true);
      const evalMock = jest.fn().mockResolvedValueOnce(1).mockRejectedValue(new Error('ECONNREFUSED'));
      const { svc, tick } = build(evalMock, [job]);
      await tick();
      jest.setSystemTime(new Date('2026-10-20T10:00:10Z'));
      await tick();
      expect(svc.getRole()).toBe('leader');
      expect(job.stop).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps a follower paused through the same blip', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') });
      const job = fakeJob(true);
      const evalMock = jest.fn().mockResolvedValueOnce(0).mockRejectedValue(new Error('ECONNREFUSED'));
      const { svc, tick } = build(evalMock, [job]);
      await tick();
      jest.setSystemTime(new Date('2026-10-20T10:00:10Z'));
      await tick();
      expect(svc.getRole()).toBe('follower');
      expect(job.start).not.toHaveBeenCalled();
    });

    /**
     * After a full TTL without Redis the default is to run: for one replica
     * that is exactly what the API did before any election existed, and for
     * several a duplicate job is the lesser evil next to a missed backup.
     */
    it('runs the jobs after one TTL without Redis, by default, and says so once', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') });
      const job = fakeJob(true);
      const { svc, tick } = build(failing(), [job], { CRON_LEADER_TTL_MS: '1000' });
      await tick();
      expect(svc.getRole()).toBe('follower');
      jest.setSystemTime(new Date('2026-10-20T10:00:01Z'));
      await tick();
      expect(svc.getRole()).toBe('leader');
      expect(job.isActive).toBe(true);
      await tick();
      await tick();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('keeps the jobs paused instead when CRON_LEADER_WHEN_REDIS_DOWN=pause', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') });
      const job = fakeJob(true);
      const { svc, tick } = build(failing(), [job], {
        CRON_LEADER_TTL_MS: '1000',
        CRON_LEADER_WHEN_REDIS_DOWN: 'pause',
      });
      await tick();
      jest.setSystemTime(new Date('2026-10-20T10:00:05Z'));
      await tick();
      expect(svc.getRole()).toBe('follower');
      expect(job.isActive).toBe(false);
    });

    it('returns to a normal election as soon as Redis answers again', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-20T10:00:00Z') });
      const job = fakeJob(true);
      const evalMock = jest
        .fn()
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue(0);
      const { svc, tick } = build(evalMock, [job], { CRON_LEADER_TTL_MS: '1000' });
      await tick();
      jest.setSystemTime(new Date('2026-10-20T10:00:02Z'));
      await tick();
      expect(svc.getRole()).toBe('leader');
      await tick();
      expect(svc.getRole()).toBe('follower');
    });
  });

  describe('switched off', () => {
    it('never touches the registry and reports standalone, with the jobs counted as running here', async () => {
      const { svc, metrics, getCronJobs } = build(granted(), [fakeJob(true)], {
        CRON_LEADER_ELECTION: 'false',
        IMAGE_TAG: 'abc123def456',
      });
      await svc.onApplicationBootstrap();
      expect(getCronJobs).not.toHaveBeenCalled();
      expect(svc.getRole()).toBe('standalone');
      expect(svc.isLeader()).toBe(true);
      const text = metrics.render();
      expect(text).toMatch(new RegExp(`basefyio_cron_leader\\{instance_id="${svc.getInstanceId()}"\\} 1`));
      expect(text).toMatch(
        new RegExp(`basefyio_build_info\\{instance_id="${svc.getInstanceId()}",image_tag="abc123def456"\\} 1`),
      );
    });
  });

  describe('lifecycle', () => {
    it('elects at bootstrap, re-checks once, keeps renewing, and releases its lease on shutdown', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      const evalMock = granted();
      const { svc, tick } = build(evalMock, [fakeJob(false)], { CRON_LEADER_RENEW_MS: '10000' });
      void tick; // the service drives its own rounds in this test

      await svc.onApplicationBootstrap();
      expect(evalMock).toHaveBeenCalledTimes(1);
      expect(svc.getRole()).toBe('leader');

      await jest.advanceTimersByTimeAsync(1_000);
      expect(evalMock).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(10_000);
      expect(evalMock).toHaveBeenCalledTimes(3);

      await svc.onModuleDestroy();
      expect(evalMock).toHaveBeenCalledTimes(4);
      const [script, numKeys, key, owner] = evalMock.mock.calls[3];
      expect(script).toMatch(/DEL/);
      expect(numKeys).toBe(1);
      expect(key).toBe(CRON_LEADER_KEY);
      expect(owner).toBe(svc.getInstanceId());

      await jest.advanceTimersByTimeAsync(30_000);
      expect(evalMock).toHaveBeenCalledTimes(4);
    });

    it('does not release a lease it never held', async () => {
      const evalMock = refused();
      const { svc, tick } = build(evalMock);
      await tick();
      await svc.onModuleDestroy();
      expect(evalMock).toHaveBeenCalledTimes(1);
    });

    it('survives Redis refusing the release on shutdown', async () => {
      const evalMock = jest.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('closed'));
      const { svc, tick } = build(evalMock);
      await tick();
      await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('what it tells the scrape endpoint', () => {
    it('publishes the role as a gauge that follows every transition', async () => {
      const evalMock = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
      const { svc, metrics, tick } = build(evalMock);
      const series = () =>
        metrics.render().match(new RegExp(`basefyio_cron_leader\\{instance_id="${svc.getInstanceId()}"\\} (\\d)`))?.[1];
      await tick();
      expect(series()).toBe('0');
      await tick();
      expect(series()).toBe('1');
    });
  });
});
