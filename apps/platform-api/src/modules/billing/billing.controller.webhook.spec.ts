import { BillingController } from './billing.controller';

/**
 * Stripe delivers at least once. The webhook must handle an event exactly
 * once when it succeeds, acknowledge a repeat without re-running it, and
 * fail the delivery (so Stripe retries) when the handler throws.
 */
function build(opts: { seen?: boolean; handlerThrows?: boolean } = {}) {
  const store = new Map<string, string>();
  if (opts.seen) store.set('stripe:evt:evt_1', '1');
  const client = {
    set: jest.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
  };
  const redis = { getClient: () => client, del: jest.fn(async (key: string) => void store.delete(key)) };
  const billing = {
    handleInvoicePaid: jest.fn().mockImplementation(() =>
      opts.handlerThrows ? Promise.reject(new Error('db down')) : Promise.resolve(),
    ),
  };
  const stripe = {
    constructWebhookEvent: jest.fn().mockReturnValue({
      id: 'evt_1',
      type: 'invoice.paid',
      data: { object: { id: 'in_1' } },
    }),
  };
  const unused = {} as any;
  const controller = new BillingController(
    billing as any,
    unused,
    unused,
    stripe as any,
    unused,
    unused,
    redis as any,
  );
  const res = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.status = (code: number) => ((r.statusCode = code), r);
    r.json = (body: unknown) => ((r.body = body), r);
    return r;
  };
  const req = { rawBody: Buffer.from('{}') } as any;
  return { controller, billing, redis, store, res, req };
}

describe('BillingController.handleWebhook', () => {
  it('handles a fresh event once and remembers it', async () => {
    const { controller, billing, store, res, req } = build();
    const r = res();

    await controller.handleWebhook(req, 'sig', r);

    expect(billing.handleInvoicePaid).toHaveBeenCalledTimes(1);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ received: true });
    expect(store.has('stripe:evt:evt_1')).toBe(true);
  });

  it('acknowledges a repeat delivery without running the handler again', async () => {
    const { controller, billing, res, req } = build({ seen: true });
    const r = res();

    await controller.handleWebhook(req, 'sig', r);

    expect(billing.handleInvoicePaid).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ received: true, duplicate: true });
  });

  it('fails the delivery and forgets the event when the handler throws, so the retry is handled', async () => {
    const { controller, redis, store, res, req } = build({ handlerThrows: true });
    const r = res();

    await controller.handleWebhook(req, 'sig', r);

    expect(r.statusCode).toBe(500);
    expect(redis.del).toHaveBeenCalledWith('stripe:evt:evt_1');
    expect(store.has('stripe:evt:evt_1')).toBe(false);
  });

  it('still handles the event when Redis is unavailable', async () => {
    const { controller, billing, redis, res, req } = build();
    (redis.getClient().set as jest.Mock).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const r = res();

    await controller.handleWebhook(req, 'sig', r);

    expect(billing.handleInvoicePaid).toHaveBeenCalledTimes(1);
    expect(r.statusCode).toBe(200);
  });
});
