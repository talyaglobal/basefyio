import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { BillingScheduler } from './billing.scheduler';

describe('BillingScheduler', () => {
  const build = (add: jest.Mock) => new BillingScheduler({ add } as any);

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * A raw timer cannot be paused by the cron leader election, so the daily run
   * must be a registered cron job, at the same hour the old timer used.
   */
  it('declares the daily run as a cron job at 10:00 UTC', () => {
    const method = BillingScheduler.prototype.triggerRecurringCharges;
    expect(Reflect.getMetadata('SCHEDULER_TYPE', method)).toBe(1);
    expect(Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', method)).toEqual(
      expect.objectContaining({ cronTime: '0 10 * * *', timeZone: 'UTC' }),
    );
  });

  /**
   * BullMQ drops an add whose id already exists, so naming the job after the
   * day means a second enqueue — a second replica, a restart at 10:00 — cannot
   * produce a second charge run.
   */
  it('names the job after the day so a duplicate enqueue is dropped by the queue', async () => {
    const add = jest.fn().mockResolvedValue({});
    await build(add).triggerRecurringCharges();
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, options] = add.mock.calls[0];
    expect(name).toBe('recurring-charges');
    expect(data).toEqual({});
    expect(options).toEqual(
      expect.objectContaining({
        jobId: expect.stringMatching(/^recurring-charges-\d{4}-\d{2}-\d{2}$/),
        attempts: 1,
      }),
    );
    expect(options.jobId).toBe(`recurring-charges-${new Date().toISOString().slice(0, 10)}`);
  });

  it('logs a queue failure instead of throwing out of the scheduler', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis down'));
    await expect(build(add).triggerRecurringCharges()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('redis down'));
  });
});
