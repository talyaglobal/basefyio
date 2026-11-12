import { BadRequestException } from '@nestjs/common';
import {
  maskActions,
  MASKED_VALUE,
  normalizeDefinition,
  normalizeTrigger,
  readStoredAction,
  readStoredActions,
  stepLimits,
} from './flow-definition';
import { FlowAction } from './flow.types';

const base = (over: Record<string, unknown> = {}) => ({
  name: 'demo',
  trigger: { type: 'manual' },
  actions: [{ type: 'log', message: 'hi' }],
  ...over,
});

const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as Error).message;
  }
  throw new Error('expected a BadRequestException');
};

describe('flow definition', () => {
  describe('schedule trigger', () => {
    it('requires a cron', () => {
      expect(message(() => normalizeTrigger({ type: 'schedule' }))).toContain('trigger.cron is required');
    });

    it('refuses an invalid cron with the reason', () => {
      expect(message(() => normalizeTrigger({ type: 'schedule', cron: 'not a cron' }))).toContain(
        'not a valid cron expression',
      );
    });

    it('keeps a valid cron and a known time zone', () => {
      expect(normalizeTrigger({ type: 'schedule', cron: ' */5  * * * * ', timezone: 'Europe/Istanbul' })).toEqual({
        type: 'schedule',
        cron: '*/5 * * * *',
        timezone: 'Europe/Istanbul',
      });
      expect(message(() => normalizeTrigger({ type: 'schedule', cron: '* * * * *', timezone: 'Nowhere/City' }))).toContain(
        'IANA time zone',
      );
    });

    it('drops fields that do not belong to the trigger type', () => {
      expect(normalizeTrigger({ type: 'manual', cron: '* * * * *' })).toEqual({ type: 'manual' });
    });
  });

  describe('actions', () => {
    it('drops a stale log message when the action became an http.request, and keeps the method', () => {
      const def = normalizeDefinition(
        base({ actions: [{ type: 'http.request', url: 'https://example.com', method: 'post', message: 'Hello from flow' }] }),
      );
      expect(def.actions[0]).toEqual({ id: expect.any(String), type: 'http.request', url: 'https://example.com', method: 'POST' });
    });

    it('refuses an empty log message', () => {
      expect(message(() => normalizeDefinition(base({ actions: [{ type: 'log', message: '   ' }] })))).toContain(
        'actions[0].message is required',
      );
    });

    it('refuses an unsupported method such as TRACE', () => {
      expect(
        message(() => normalizeDefinition(base({ actions: [{ type: 'http.request', url: 'https://x.io', method: 'TRACE' }] }))),
      ).toContain('actions[0].method must be one of');
    });

    it('does not store unknown fields', () => {
      const def = normalizeDefinition(
        base({ actions: [{ type: 'http.request', url: 'https://x.io', method: 'GET', foo: 1, retries: 2 }] }),
      );
      expect(def.actions[0]).not.toHaveProperty('foo');
      expect(def.actions[0].retries).toBe(2);
    });

    it('bounds limits', () => {
      expect(message(() => normalizeDefinition(base({ actions: [{ type: 'http.request', url: 'https://x.io', timeoutMs: 120000 }] })))).toContain(
        'timeoutMs must be between',
      );
      expect(message(() => normalizeDefinition(base({ actions: [{ type: 'log', message: 'x', retries: 9 }] })))).toContain(
        'retries must be between',
      );
      expect(message(() => normalizeDefinition(base({ options: { maxConcurrentRuns: 0 } })))).toContain(
        'options.maxConcurrentRuns',
      );
    });

    it('validates placeholders at save time', () => {
      expect(
        message(() => normalizeDefinition(base({ actions: [{ type: 'log', message: 'x {{env.SECRET}}' }] }))),
      ).toContain('must start with');
    });

    it('requires filters on db.update so it cannot touch every row', () => {
      expect(
        message(() => normalizeDefinition(base({ actions: [{ type: 'db.update', table: 'orders', values: { paid: true } }] }))),
      ).toContain('filters is required');
      const def = normalizeDefinition(
        base({ actions: [{ type: 'db.update', table: 'orders', values: { paid: true }, filters: { id: 'eq.{{input.id}}' } }] }),
      );
      expect(def.actions[0]).toMatchObject({ table: 'orders', filters: { id: 'eq.{{input.id}}' } });
    });

    it('requires unique step names', () => {
      expect(
        message(() =>
          normalizeDefinition(base({ actions: [{ type: 'log', message: 'a', name: 'x' }, { type: 'log', message: 'b', name: 'x' }] })),
        ),
      ).toContain('unique');
    });
  });

  describe('masked headers', () => {
    const stored: FlowAction[] = [
      { id: 'a1', type: 'http.request', url: 'https://api.example.com/x', method: 'POST', headers: { Authorization: 'Bearer real', Accept: 'application/json' } },
    ];

    it('masks sensitive header values on read only', () => {
      const masked = maskActions(stored);
      expect(masked[0].headers).toEqual({ Authorization: MASKED_VALUE, Accept: 'application/json' });
      expect(stored[0].headers?.Authorization).toBe('Bearer real');
    });

    it('keeps the saved value when an edit sends the mask back', () => {
      const def = normalizeDefinition(
        base({ actions: [{ ...maskActions(stored)[0], url: 'https://api.example.com/y' }] }),
        stored,
      );
      expect(def.actions[0].headers?.Authorization).toBe('Bearer real');
    });

    it('does not carry a masked value to another host', () => {
      expect(
        message(() => normalizeDefinition(base({ actions: [{ ...maskActions(stored)[0], url: 'https://evil.example.net/' }] }), stored)),
      ).toContain("URL's host changed");
    });

    it('refuses a mask with nothing saved behind it', () => {
      expect(
        message(() =>
          normalizeDefinition(base({ actions: [{ type: 'http.request', url: 'https://x.io', headers: { Authorization: MASKED_VALUE } }] })),
        ),
      ).toContain('enter the real value');
    });
  });

  describe('reading stored rows', () => {
    it('reads the legacy http.request shape without breaking it', () => {
      const a = readStoredAction({ url: 'https://x.io', type: 'http.request', message: 'Hello from flow' }, 0);
      expect(a).toEqual({ id: 'legacy_0', type: 'http.request', url: 'https://x.io', method: 'POST' });
    });

    it('never throws on junk', () => {
      expect(readStoredActions(null)).toEqual([]);
      expect(readStoredActions([null, 3])).toHaveLength(2);
    });

    it('lets an old flow be saved again with its legacy ids', () => {
      const legacy = readStoredActions([{ type: 'http.request', url: 'https://x.io', headers: { 'X-Api-Key': 'k' } }]);
      const def = normalizeDefinition(base({ actions: maskActions(legacy) }), legacy);
      expect(def.actions[0].headers?.['X-Api-Key']).toBe('k');
    });
  });

  it('computes step limits from action, flow options and defaults', () => {
    expect(stepLimits({ type: 'log' }, {})).toEqual({ timeoutMs: 10000, retries: 0, retryDelayMs: 1000 });
    expect(stepLimits({ type: 'log', retries: 2 }, { retries: 1, timeoutMs: 5000 })).toEqual({
      timeoutMs: 5000,
      retries: 2,
      retryDelayMs: 1000,
    });
  });
});
