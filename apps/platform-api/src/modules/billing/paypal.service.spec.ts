import { BadRequestException, Logger } from '@nestjs/common';
import { PayPalService } from './paypal.service';
import { BillingService } from './billing.service';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('PayPalService', () => {
  const env = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.PAYPAL_CLIENT_ID = 'id';
    process.env.PAYPAL_CLIENT_SECRET = 'secret';
    process.env.PAYPAL_MODE = 'sandbox';
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('is enabled only with both id and secret', () => {
    expect(new PayPalService().isEnabled()).toBe(true);
    process.env.PAYPAL_CLIENT_SECRET = '';
    expect(new PayPalService().isEnabled()).toBe(false);
  });

  it('caches the token and sends a User-Agent on every call', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValue(ok({ id: 'O1', status: 'CREATED' }));
    const svc = new PayPalService();
    await svc.getOrder('O1');
    await svc.getOrder('O1');
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls.filter((u: string) => u.endsWith('/v1/oauth2/token'))).toHaveLength(1);
    expect(urls[0].startsWith('https://api-m.sandbox.paypal.com')).toBe(true);
    for (const c of fetchMock.mock.calls) expect(c[1].headers['User-Agent']).toBeTruthy();
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tok');
  });

  it('creates a CAPTURE order with the outstanding amount, currency and invoice id', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://pp/approve' }] }));
    const r = await new PayPalService().createOrder({
      invoiceId: 'inv1',
      amountCents: 1999,
      currency: 'usd',
      returnUrl: 'https://app/r',
      cancelUrl: 'https://app/c',
    });
    expect(r).toEqual({ orderId: 'O1', approvalUrl: 'https://pp/approve' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(init.headers['PayPal-Request-Id']).toBeTruthy();
    const body = JSON.parse(init.body);
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units).toEqual([
      { custom_id: 'inv1', description: 'basefyio invoice', amount: { currency_code: 'USD', value: '19.99' } },
    ]);
    expect(body.payment_source.paypal.experience_context).toMatchObject({ return_url: 'https://app/r', cancel_url: 'https://app/c' });
  });

  it('uses the live host by default and captures with a stable request id', async () => {
    delete process.env.PAYPAL_MODE;
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'tok', expires_in: 3600 }))
      .mockResolvedValueOnce(ok({ id: 'O1', status: 'COMPLETED' }));
    const r = await new PayPalService().captureOrder('O1');
    expect(r.status).toBe('COMPLETED');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api-m.paypal.com/v2/checkout/orders/O1/capture');
    expect(fetchMock.mock.calls[1][1].headers['PayPal-Request-Id']).toBe('capture-O1');
  });
});

describe('BillingService.capturePayPalOrder verification', () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    id: 'inv1', teamId: 't1', status: 'unpaid', amountDue: 1999, amountPaid: 0, currency: 'usd', stripeInvoiceId: null, ...over,
  });
  const order = (over: Record<string, unknown> = {}, unit: Record<string, unknown> = {}) => ({
    id: 'O1',
    status: 'APPROVED',
    purchase_units: [{ custom_id: 'inv1', amount: { currency_code: 'USD', value: '19.99' }, ...unit }],
    ...over,
  });

  function build(inv: any, ord: any, capturedStatus = 'COMPLETED') {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const prisma: any = {
      teamMember: { findUnique: jest.fn().mockResolvedValue({ role: 'OWNER' }) },
      invoice: {
        findUnique: jest.fn().mockResolvedValue(inv),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      team: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      subscription: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const paypal: any = {
      isEnabled: () => true,
      getOrder: jest.fn().mockResolvedValue(ord),
      captureOrder: jest.fn().mockResolvedValue({ status: capturedStatus }),
    };
    const quickbooks: any = { recordSale: jest.fn().mockResolvedValue(undefined) };
    const svc = new BillingService(prisma, {} as any, {} as any, {} as any, {} as any, quickbooks, paypal);
    return { svc, prisma, paypal, quickbooks };
  }

  it('captures, marks the invoice paid, unfreezes the team and records the sale', async () => {
    const { svc, prisma, paypal, quickbooks } = build(invoice(), order());
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).resolves.toEqual({ message: 'Payment successful', success: true });
    expect(paypal.captureOrder).toHaveBeenCalledWith('O1');
    expect(prisma.invoice.updateMany.mock.calls[0][0].data).toEqual({ status: 'paid', amountPaid: 1999 });
    expect(prisma.team.updateMany.mock.calls[0][0].data).toEqual({ accountStatus: 'ACTIVE' });
    expect(quickbooks.recordSale).toHaveBeenCalledWith('inv1');
  });

  it('refuses an order whose invoice belongs to another team, without capturing', async () => {
    const { svc, paypal } = build(invoice({ teamId: 'other' }), order());
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).rejects.toBeInstanceOf(BadRequestException);
    expect(paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('refuses an amount or currency mismatch, without capturing', async () => {
    for (const unit of [{ amount: { currency_code: 'USD', value: '9.99' } }, { amount: { currency_code: 'EUR', value: '19.99' } }]) {
      const { svc, paypal } = build(invoice(), order({}, unit));
      await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).rejects.toThrow(/amount changed/);
      expect(paypal.captureOrder).not.toHaveBeenCalled();
    }
  });

  it('returns success without any work when the invoice is already paid', async () => {
    const { svc, prisma, paypal, quickbooks } = build(invoice({ status: 'paid', amountPaid: 1999 }), order());
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).resolves.toMatchObject({ success: true });
    expect(paypal.captureOrder).not.toHaveBeenCalled();
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(quickbooks.recordSale).not.toHaveBeenCalled();
  });

  it('does not settle twice when a concurrent request already did', async () => {
    const { svc, prisma, quickbooks } = build(invoice(), order());
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).resolves.toMatchObject({ success: true });
    expect(quickbooks.recordSale).not.toHaveBeenCalled();
    expect(prisma.team.updateMany).not.toHaveBeenCalled();
  });

  it('refuses when PayPal does not report COMPLETED, and leaves the invoice open', async () => {
    const { svc, prisma } = build(invoice(), order(), 'PENDING');
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).rejects.toThrow(/not completed/);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an order that is not approved yet (status CREATED)', async () => {
    const { svc, paypal } = build(invoice(), order({ status: 'CREATED' }));
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).rejects.toThrow(/not completed/);
    expect(paypal.captureOrder).not.toHaveBeenCalled();
  });

  it('refuses a Stripe-hosted invoice', async () => {
    const { svc, paypal } = build(invoice({ stripeInvoiceId: 'in_123' }), order());
    await expect(svc.capturePayPalOrder('t1', 'u1', 'O1')).rejects.toThrow(/Stripe/);
    expect(paypal.captureOrder).not.toHaveBeenCalled();
  });
});
