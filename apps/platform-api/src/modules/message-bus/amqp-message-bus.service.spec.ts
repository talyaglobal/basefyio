/**
 * amqplib is mocked: the tests assert what the bus declares, publishes and
 * does with a delivery (ack, retry, dead-letter, dedupe), not the wire.
 */
const published: Array<{ exchange: string; key: string; body: any; options: any }> = [];
const asserted: { exchanges: string[]; queues: Array<{ name: string; args: any }>; bindings: string[] } = { exchanges: [], queues: [], bindings: [] };
let consumerCallback: ((msg: any) => void) | null = null;
const channelActions: string[] = [];

function makeChannel() {
  return {
    assertExchange: jest.fn(async (name: string) => { asserted.exchanges.push(name); }),
    assertQueue: jest.fn(async (name: string, opts: any) => { asserted.queues.push({ name, args: opts?.arguments }); }),
    bindQueue: jest.fn(async (q: string, ex: string, key: string) => { asserted.bindings.push(`${q}<-${ex}:${key}`); }),
    prefetch: jest.fn(async () => {}),
    consume: jest.fn(async (_q: string, cb: (m: any) => void) => { consumerCallback = cb; }),
    publish: jest.fn((exchange: string, key: string, body: Buffer, options: any, cb: (e?: Error) => void) => {
      published.push({ exchange, key, body: JSON.parse(body.toString()), options });
      cb();
      return true;
    }),
    ack: jest.fn(() => channelActions.push('ack')),
    nack: jest.fn((_m: any, _multi: boolean, requeue: boolean) => channelActions.push(requeue ? 'nack-requeue' : 'nack-dead')),
    close: jest.fn(async () => {}),
  };
}

const handlers: Record<string, (...a: any[]) => void> = {};
jest.mock('amqplib', () => ({
  connect: jest.fn(async () => ({
    on: (event: string, h: (...a: any[]) => void) => { handlers[event] = h; },
    createChannel: jest.fn(async () => makeChannel()),
    createConfirmChannel: jest.fn(async () => makeChannel()),
    close: jest.fn(async () => {}),
  })),
}));

import { AmqpMessageBus } from './amqp-message-bus.service';

function makeBus(url = 'amqp://x', redisFirst: string | null = 'OK') {
  const config = { get: (k: string) => (k === 'messageBus.url' ? url : undefined) };
  const durable = { set: jest.fn().mockResolvedValue(redisFirst), del: jest.fn().mockResolvedValue(1) };
  const redis = { getDurableClient: () => durable };
  const metrics = { increment: jest.fn(), setGauge: jest.fn(), observeRequest: jest.fn() };
  const bus = new AmqpMessageBus(config as any, redis as any, metrics as any);
  return { bus, durable, metrics };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  published.length = 0;
  asserted.exchanges.length = 0;
  asserted.queues.length = 0;
  asserted.bindings.length = 0;
  channelActions.length = 0;
  consumerCallback = null;
});

describe('AmqpMessageBus', () => {
  it('is inert without a URL', async () => {
    const { bus } = makeBus('');
    await bus.onModuleInit();
    expect(bus.isEnabled()).toBe(false);
    expect(bus.isConnected()).toBe(false);
    await expect(bus.publishJob('jobs.webhooks', {})).rejects.toThrow('not configured');
  });

  it('declares the exchanges, quorum work queues with dead-lettering, DLQs and retry queues', async () => {
    const { bus } = makeBus();
    await bus.onModuleInit();
    await flush();
    expect(bus.isConnected()).toBe(true);
    expect(asserted.exchanges).toEqual(expect.arrayContaining(['basefyio.jobs', 'basefyio.events', 'basefyio.dlx', 'basefyio.retry']));
    const webhooks = asserted.queues.find((q) => q.name === 'jobs.webhooks')!;
    expect(webhooks.args).toMatchObject({ 'x-queue-type': 'quorum', 'x-delivery-limit': 5, 'x-dead-letter-exchange': 'basefyio.dlx', 'x-dead-letter-routing-key': 'dlq.jobs.webhooks' });
    expect(asserted.queues.some((q) => q.name === 'dlq.jobs.webhooks')).toBe(true);
    const retry = asserted.queues.find((q) => q.name === 'retry.60000')!;
    expect(retry.args).toMatchObject({ 'x-message-ttl': 60000, 'x-dead-letter-exchange': 'basefyio.jobs' });
    expect(asserted.bindings).toContain('jobs.webhooks<-basefyio.jobs:jobs.webhooks');
  });

  it('publishes a persistent JSON envelope with the message id and attempt header', async () => {
    const { bus } = makeBus();
    await bus.onModuleInit();
    await flush();
    const id = await bus.publishJob('jobs.webhooks', { url: 'https://example.test' }, { projectId: 'p1', kind: 'webhook.deliver' });
    expect(published).toHaveLength(1);
    const m = published[0];
    expect(m.exchange).toBe('basefyio.jobs');
    expect(m.key).toBe('jobs.webhooks');
    expect(m.body).toMatchObject({ id, kind: 'webhook.deliver', projectId: 'p1', attempt: 1, payload: { url: 'https://example.test' } });
    expect(m.options).toMatchObject({ persistent: true, messageId: id, headers: { 'x-attempt': 1 } });

    await bus.publishEvent('project.created', { type: 'project.created', projectId: 'p1', data: { name: 'x' } });
    expect(published[1].exchange).toBe('basefyio.events');
    expect(published[1].key).toBe('project.created');
  });

  it('acks a handled delivery, retries a failed one through the retry exchange, dead-letters after the last attempt', async () => {
    const { bus, durable } = makeBus();
    await bus.onModuleInit();
    await flush();
    const seen: number[] = [];
    await bus.consumeJob('jobs.webhooks', async (env) => {
      seen.push(env.attempt);
      if (env.attempt < 3) throw new Error('boom');
    });
    expect(consumerCallback).not.toBeNull();
    const deliver = (attempt: number) => {
      const body = Buffer.from(JSON.stringify({ id: 'm1', kind: 'k', attempt, createdAt: 'now', payload: {} }));
      consumerCallback!({ content: body, properties: { headers: { 'x-attempt': attempt } } });
    };

    deliver(1);
    await flush();
    expect(channelActions).toEqual(['ack']); // acked after scheduling the retry
    expect(published[published.length - 1]).toMatchObject({ exchange: 'basefyio.retry', key: 'retry.10000', body: { attempt: 2 } });
    expect(durable.del).toHaveBeenCalledWith('bus:done:m1');

    deliver(3);
    await flush();
    expect(seen).toEqual([1, 3]);
    expect(channelActions).toEqual(['ack', 'ack']);

    // fifth attempt fails for good → dead-letter (nack without requeue)
    await bus.consumeJob('jobs.migration', async () => { throw new Error('always'); });
    const body = Buffer.from(JSON.stringify({ id: 'm2', kind: 'k', attempt: 5, createdAt: 'now', payload: {} }));
    consumerCallback!({ content: body, properties: { headers: { 'x-attempt': 5 } } });
    await flush();
    expect(channelActions[channelActions.length - 1]).toBe('nack-dead');
  });

  it('runs a duplicate delivery once', async () => {
    const { bus, metrics } = makeBus('amqp://x', null); // SET NX says "already done"
    await bus.onModuleInit();
    await flush();
    const handler = jest.fn(async () => {});
    await bus.consumeJob('jobs.usage', handler);
    consumerCallback!({ content: Buffer.from(JSON.stringify({ id: 'dup', kind: 'k', attempt: 1, createdAt: 'now', payload: {} })), properties: { headers: {} } });
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(channelActions).toEqual(['ack']);
    expect(metrics.increment).toHaveBeenCalledWith('bus_duplicate_jobs.usage');
  });
});
