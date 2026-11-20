import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillingService } from './billing.service';

/**
 * Saved cards, the card rule for paid plans and the move to Free, against
 * in-memory fakes. No call reaches the payment processor.
 */

const GB = 1024 ** 3;
const PLANS: Record<string, any> = {
  legacy: { id: 'pl-legacy', name: 'legacy', displayName: 'Legacy', priceMonthly: 0, features: { grandfathered: true }, stripePriceId: null },
  free: {
    id: 'pl-free', name: 'free', displayName: 'Free', priceMonthly: 0, features: null, stripePriceId: null,
    maxProjects: 5, maxTeamMembers: 3, maxStorageBytes: BigInt(2 * GB), maxDbSizeBytes: BigInt(1 * GB),
    maxApiRequests: 500_000, maxBandwidthBytes: BigInt(2 * GB), maxMau: 50_000,
  },
  pro: { id: 'pl-pro', name: 'pro', displayName: 'Pro', priceMonthly: 2000, features: { dailyBackups: true }, stripePriceId: 'price_pro' },
  business: { id: 'pl-biz', name: 'business', displayName: 'Business', priceMonthly: 10000, features: null, stripePriceId: 'price_biz' },
  oldpaid: { id: 'pl-old', name: 'oldpaid', displayName: 'Old paid', priceMonthly: 1500, features: { grandfathered: true }, stripePriceId: 'price_old' },
};

const card = (id: string, customer = 'cus_1') => ({ id, customer, card: { brand: 'visa', last4: id.slice(-4), exp_month: 1, exp_year: 2030, funding: 'credit' } });

interface Opts {
  plan?: string;
  cards?: string[];
  defaultCard?: string | null;
  invoices?: any[];
  sub?: Record<string, any>;
  usage?: Record<string, any>;
  projects?: number;
  members?: number;
  marker?: boolean;
  chargeFails?: boolean;
}

function setup(o: Opts = {}) {
  const calls: string[] = [];
  const future = new Date(Date.now() + 10 * 24 * 3600 * 1000);
  const sub: any = {
    id: 'sub-1', teamId: 't1', planId: PLANS[o.plan ?? 'pro'].id, plan: PLANS[o.plan ?? 'pro'], status: 'ACTIVE',
    stripeCustomerId: 'cus_1', stripeSubscriptionId: null, cancelAtPeriodEnd: false,
    currentPeriodStart: new Date(), currentPeriodEnd: future, nextBillingDate: future, billingDayOfMonth: 5,
    pendingPlanId: null, pendingAmountDue: null, studentDiscountPercent: 0, retryCount: 0, firstFailureAt: null,
    ...o.sub,
  };
  let cards = (o.cards ?? ['pm_a']).map((id) => card(id));
  let def: string | null = o.defaultCard === undefined ? cards[0]?.id ?? null : o.defaultCard;
  const invoices = (o.invoices ?? []).map((i) => ({ ...i }));
  const settings = new Map<string, any>(o.marker ? [['billing_scheduled_free:t1', { at: future.toISOString() }]] : []);

  const prisma: any = {
    subscription: {
      findUnique: jest.fn(async (args: any) => (args.include?.plan ? { ...sub, plan: PLANS[Object.keys(PLANS).find((k) => PLANS[k].id === sub.planId)!] } : { ...sub })),
      update: jest.fn(async ({ data }: any) => {
        calls.push(`sub.update:${Object.keys(data).join(',')}`);
        Object.assign(sub, data);
        return sub;
      }),
    },
    plan: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.name ? PLANS[where.name] ?? null : Object.values(PLANS).find((p: any) => p.id === where.id) ?? null,
      ),
    },
    invoice: {
      findMany: jest.fn(async () => invoices.filter((i) => ['open', 'unpaid', 'payment_failed'].includes(i.status))),
      findFirst: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      findUnique: jest.fn(async ({ where }: any) => invoices.find((i) => i.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        calls.push(`invoice.paid:${where.id}`);
        Object.assign(invoices.find((i) => i.id === where.id), data);
      }),
      create: jest.fn(async ({ data }: any) => {
        calls.push('invoice.create');
        const row = { id: `inv-${invoices.length + 1}`, ...data };
        invoices.push(row);
        return row;
      }),
    },
    project: { count: jest.fn(async () => o.projects ?? 2) },
    teamMember: { count: jest.fn(async () => o.members ?? 1) },
    teamUsage: { findUnique: jest.fn(async () => null) },
    team: { updateMany: jest.fn(async () => ({ count: 0 })), update: jest.fn(async () => ({})) },
    systemSetting: {
      upsert: jest.fn(async ({ where, create }: any) => { calls.push('marker.set'); settings.set(where.key, create.value); }),
      deleteMany: jest.fn(async ({ where }: any) => { settings.delete(where.key); }),
      findUnique: jest.fn(async ({ where }: any) => (settings.has(where.key) ? { key: where.key } : null)),
    },
  };

  const processor: any = {
    isEnabled: () => true,
    listPaymentMethods: jest.fn(async () => cards),
    getDefaultPaymentMethod: jest.fn(async () => cards.find((c) => c.id === def) ?? null),
    retrievePaymentMethod: jest.fn(async (id: string) => {
      const found = cards.find((c) => c.id === id);
      if (found) return found;
      if (id === "pm_foreign") return card("pm_foreign", "cus_other");
      if (id === "pm_new") return card("pm_new");
      throw new Error('No such payment method');
    }),
    setDefaultPaymentMethod: jest.fn(async (_c: string, id: string) => { def = id; }),
    attachPaymentMethod: jest.fn(async (_c: string, id: string) => { cards = [card(id), ...cards]; }),
    detachPaymentMethod: jest.fn(async (id: string) => { calls.push(`detach:${id}`); cards = cards.filter((c) => c.id !== id); }),
    createPaymentIntent: jest.fn(async (args: any) => {
      calls.push(`charge:${args.amount}:${args.metadata?.type}`);
      return { id: `pi_${args.amount}`, status: o.chargeFails ? 'requires_payment_method' : 'succeeded' };
    }),
    payInvoice: jest.fn(async (id: string) => { calls.push(`payInvoice:${id}`); return { id, status: o.chargeFails ? 'open' : 'paid' }; }),
    cancelSubscription: jest.fn(async () => { calls.push('cancel'); }),
    getOrCreateCustomer: jest.fn(async () => ({ id: 'cus_1' })),
    createCheckoutSession: jest.fn(async () => ({ id: 'cs_1', url: 'https://checkout' })),
  };

  const redis: any = { getClient: () => ({ set: jest.fn(async () => 'OK') }), del: jest.fn(async () => undefined) };
  const usage: any = {
    getTeamUsage: jest.fn(async () => ({
      storageBytes: BigInt(0), dbSizeBytes: BigInt(0), apiRequestsMonth: 0, bandwidthMonth: BigInt(0), mauCount: 0, ...o.usage,
    })),
  };
  const quickbooks: any = { recordSale: jest.fn(async () => undefined) };
  const realtime: any = { publish: jest.fn(async () => undefined) };

  const service = new BillingService(prisma, processor, realtime, redis, {} as any, quickbooks, {} as any, usage) as any;
  jest.spyOn(service, 'assertTeamOwner').mockResolvedValue(undefined);
  jest.spyOn(service, 'assertCanViewBilling').mockResolvedValue(undefined);
  return { service, prisma, processor, sub, calls, invoices, settings, getCards: () => cards, getDefault: () => def };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return { status: e.getStatus?.(), ...(e.getResponse?.() ?? {}) };
  }
  throw new Error('expected a rejection');
};

describe('saved cards', () => {
  it('lists every card with the default marked and the last-card rule', async () => {
    const { service } = setup({ cards: ['pm_a', 'pm_b'], defaultCard: 'pm_b' });
    const res = await service.listPaymentMethods('t1', 'u1');
    expect(res.methods.map((m: any) => [m.id, m.isDefault])).toEqual([['pm_a', false], ['pm_b', true]]);
    expect(res).toMatchObject({ cardRequired: true, lastCardRemovable: false });
  });

  it('adds a second card without moving the default when asked', async () => {
    const { service, getDefault, getCards } = setup({ cards: ['pm_a'] });
    await service.attachPaymentMethod('t1', 'u1', 'pm_new', false);
    expect(getCards().map((c: any) => c.id)).toEqual(['pm_new', 'pm_a']);
    expect(getDefault()).toBe('pm_a');
  });

  it('makes a newly added card the default by default (existing behaviour)', async () => {
    const { service, getDefault } = setup({ cards: ['pm_a'] });
    await service.attachPaymentMethod('t1', 'u1', 'pm_new');
    expect(getDefault()).toBe('pm_new');
  });

  it('sets another saved card as the default', async () => {
    const { service, getDefault } = setup({ cards: ['pm_a', 'pm_b'] });
    await service.setDefaultPaymentMethod('t1', 'u1', 'pm_b');
    expect(getDefault()).toBe('pm_b');
  });

  it('never touches a card saved on another customer', async () => {
    const { service, processor } = setup({ cards: ['pm_a'] });
    await expect(service.setDefaultPaymentMethod('t1', 'u1', 'pm_foreign')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.removePaymentMethod('t1', 'u1', 'pm_foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(processor.setDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(processor.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it.each(['pro', 'business'])('refuses to remove the last card on %s', async (plan) => {
    const { service, processor } = setup({ plan, cards: ['pm_a'] });
    const err = await codeOf(service.removePaymentMethod('t1', 'u1', 'pm_a'));
    expect(err).toMatchObject({ status: 400, code: 'last_card_required' });
    expect(err.message).toMatch(/needs a card on file/);
    expect(processor.detachPaymentMethod).not.toHaveBeenCalled();
  });

  it('removes a card on a paid plan when another stays, promoting it to default', async () => {
    const { service, getCards, getDefault } = setup({ plan: 'pro', cards: ['pm_a', 'pm_b'], defaultCard: 'pm_a' });
    await service.removePaymentMethod('t1', 'u1', 'pm_a');
    expect(getCards().map((c: any) => c.id)).toEqual(['pm_b']);
    expect(getDefault()).toBe('pm_b');
  });

  it.each(['legacy', 'oldpaid'])('lets a %s (grandfathered) account remove every card', async (plan) => {
    const { service, getCards } = setup({ plan, cards: ['pm_a'] });
    expect((await service.listPaymentMethods('t1', 'u1')).lastCardRemovable).toBe(true);
    await service.removePaymentMethod('t1', 'u1', 'pm_a');
    expect(getCards()).toEqual([]);
  });

  it('lets a Free team remove its last card when nothing is owed', async () => {
    const { service, getCards } = setup({ plan: 'free', cards: ['pm_a'] });
    await service.removePaymentMethod('t1', 'u1', 'pm_a');
    expect(getCards()).toEqual([]);
  });

  it('keeps the last card of a Free team that has an open invoice', async () => {
    const { service, processor } = setup({
      plan: 'free', cards: ['pm_a'],
      invoices: [{ id: 'inv-1', status: 'open', amountDue: 2000, amountPaid: 0, currency: 'usd' }],
    });
    const err = await codeOf(service.removePaymentMethod('t1', 'u1', 'pm_a'));
    expect(err).toMatchObject({ code: 'last_card_required' });
    expect(err.message).toMatch(/outstanding balance/);
    expect(processor.detachPaymentMethod).not.toHaveBeenCalled();
  });
});

describe('choosing a paid plan needs a default card', () => {
  it('refuses the upgrade without a card and charges nothing', async () => {
    const { service, processor } = setup({ plan: 'free', cards: [], defaultCard: null });
    expect(await codeOf(service.changePlan('t1', 'u1', 'pro'))).toMatchObject({ code: 'card_required' });
    expect(processor.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('refuses the upgrade preview without a card', async () => {
    const { service } = setup({ plan: 'free', cards: [], defaultCard: null });
    expect(await codeOf(service.previewPlanChange('t1', 'u1', 'pro'))).toMatchObject({ code: 'card_required' });
  });

  it('refuses checkout without a card', async () => {
    const { service, processor, prisma } = setup({ plan: 'free', cards: [], defaultCard: null });
    prisma.team = { ...prisma.team, findUnique: jest.fn(async () => ({ id: 't1', name: 'T' })) };
    prisma.user = { findUnique: jest.fn(async () => ({ id: 'u1', email: 'a@b.c' })) };
    jest.spyOn(service, 'getTeamSubscription').mockResolvedValue({ id: 'sub-1', stripeCustomerId: 'cus_1' });
    expect(await codeOf(service.createCheckoutSession('t1', 'u1', 'pro', 's', 'c'))).toMatchObject({ code: 'card_required' });
    expect(processor.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('cards with no default still count as no card', async () => {
    const { service } = setup({ plan: 'free', cards: ['pm_a'], defaultCard: null });
    expect(await codeOf(service.previewPlanChange('t1', 'u1', 'pro'))).toMatchObject({ code: 'card_required' });
  });
});

describe('moving to the Free plan', () => {
  const openInvoice = { id: 'inv-1', stripeInvoiceId: null, status: 'open', amountDue: 2000, amountPaid: 0, currency: 'usd' };

  it('blocks when the outstanding invoice cannot be paid, and the plan does not change', async () => {
    const { service, sub, prisma } = setup({ invoices: [openInvoice], chargeFails: true });
    expect(await codeOf(service.downgradeToFree('t1', 'u1'))).toMatchObject({ code: 'payment_failed' });
    expect(sub.planId).toBe('pl-pro');
    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('blocks over the Free limits and lists exactly what to reduce, deleting nothing', async () => {
    const { service, sub, processor } = setup({ projects: 8, members: 5, usage: { storageBytes: BigInt(3 * GB) } });
    const err = await codeOf(service.downgradeToFree('t1', 'u1'));
    expect(err.code).toBe('over_free_limits');
    expect(err.blockers.map((b: any) => b.resource)).toEqual(['projects', 'members', 'storage']);
    expect(err.message).toMatch(/Projects: 8 of 5/);
    expect(sub.planId).toBe('pl-pro');
    expect(processor.cancelSubscription).not.toHaveBeenCalled();
  });

  it('only warns about this month\'s counters', async () => {
    const { service } = setup({ usage: { apiRequestsMonth: 900_000, bandwidthMonth: BigInt(9 * GB), mauCount: 70_000 } });
    const preview = await service.previewDowngrade('t1', 'u1');
    expect(preview.limits.blockers).toEqual([]);
    expect(preview.limits.warnings.map((w: any) => w.resource)).toEqual(['api_requests', 'bandwidth', 'mau']);
    expect(preview.canProceed).toBe(true);
    await expect(service.downgradeToFree('t1', 'u1')).resolves.toMatchObject({ scheduled: true });
  });

  it('pays first, then checks limits, then schedules the switch for the end of the paid period', async () => {
    const { service, sub, calls } = setup({ invoices: [openInvoice] });
    const res = await service.downgradeToFree('t1', 'u1');
    expect(res.scheduled).toBe(true);
    expect(sub.planId).toBe('pl-pro'); // still Pro until the period ends
    expect(sub.cancelAtPeriodEnd).toBe(true);
    const charge = calls.indexOf('charge:2000:downgrade_settlement');
    const paid = calls.indexOf('invoice.paid:inv-1');
    const marker = calls.indexOf('marker.set');
    expect(charge).toBeGreaterThanOrEqual(0);
    expect(paid).toBeGreaterThan(charge);
    expect(marker).toBeGreaterThan(paid);
  });

  it('pays an open processor-hosted invoice through the processor', async () => {
    const { service, calls } = setup({ invoices: [{ ...openInvoice, stripeInvoiceId: 'in_123' }] });
    await service.downgradeToFree('t1', 'u1');
    expect(calls).toContain('payInvoice:in_123');
  });

  it('charges a failed renewal in full before moving', async () => {
    const { service, calls, invoices } = setup({ sub: { status: 'PAST_DUE', firstFailureAt: new Date() } });
    await service.downgradeToFree('t1', 'u1');
    expect(calls).toContain('charge:2000:downgrade_renewal');
    expect(invoices.some((i) => i.status === 'paid' && i.amountPaid === 2000)).toBe(true);
  });

  it('drops a failed upgrade still being retried instead of charging it', async () => {
    const { service, sub, processor } = setup({
      sub: { status: 'PAST_DUE', pendingPlanId: 'pl-biz', pendingAmountDue: 8000, firstFailureAt: new Date() },
    });
    await service.downgradeToFree('t1', 'u1');
    expect(processor.createPaymentIntent).not.toHaveBeenCalled();
    expect(sub).toMatchObject({ pendingPlanId: null, pendingAmountDue: null, status: 'ACTIVE' });
  });

  it('switches right away when no paid period is running', async () => {
    const { service, sub } = setup({ plan: 'legacy', cards: [] });
    const res = await service.downgradeToFree('t1', 'u1');
    expect(res.scheduled).toBe(false);
    expect(sub.planId).toBe('pl-free');
  });

  it('uses the processor\'s own cancel for a processor subscription', async () => {
    const { service, processor, prisma } = setup({ sub: { stripeSubscriptionId: 'sub_x', currentPeriodEnd: new Date(Date.now() + 86400000) } });
    await service.downgradeToFree('t1', 'u1');
    expect(processor.cancelSubscription).toHaveBeenCalledWith('sub_x');
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('the preview lists the three steps and their blockers', async () => {
    const { service } = setup({ projects: 9, invoices: [openInvoice] });
    const p = await service.previewDowngrade('t1', 'u1');
    expect(p.steps.map((s: any) => [s.key, s.status])).toEqual([['pay', 'pending'], ['limits', 'blocked'], ['switch', 'pending']]);
    expect(p.outstanding.total).toBe(2000);
    expect(p.canProceed).toBe(false);
  });

  it('the cancel route goes through the same checks', async () => {
    const { service } = setup({ projects: 9 });
    expect(await codeOf(service.cancelSubscription('t1', 'u1'))).toMatchObject({ code: 'over_free_limits' });
  });

  it('undoing a scheduled move clears it', async () => {
    const { service, sub, settings } = setup({ sub: { cancelAtPeriodEnd: true }, marker: true });
    await service.resumeSubscription('t1', 'u1');
    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(settings.size).toBe(0);
  });
});

describe('the renewal job and scheduled moves', () => {
  it('switches a team that scheduled the move instead of charging it', async () => {
    const { service, sub, processor, settings } = setup({ sub: { cancelAtPeriodEnd: true }, marker: true, projects: 12 });
    const res = await service.chargeSubscription('t1', 'sub-1');
    expect(res.status).toBe('success');
    expect(sub.planId).toBe('pl-free'); // over the Free limits does not stop it; nothing is deleted
    expect(processor.createPaymentIntent).not.toHaveBeenCalled();
    expect(settings.size).toBe(0);
  });

  it('keeps billing an existing team whose flag was set some other way (no change on deploy)', async () => {
    const { service, sub, processor } = setup({ sub: { cancelAtPeriodEnd: true }, marker: false });
    await service.chargeSubscription('t1', 'sub-1');
    expect(sub.planId).toBe('pl-pro');
    expect(processor.createPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000 }));
  });

  it('an existing team that never touches billing keeps its plan, subscription and cards', async () => {
    const { service, sub, getCards } = setup({ cards: ['pm_a'] });
    await service.listPaymentMethods('t1', 'u1');
    await service.previewDowngrade('t1', 'u1');
    expect(sub.planId).toBe('pl-pro');
    expect(sub.cancelAtPeriodEnd).toBe(false);
    expect(getCards().map((c: any) => c.id)).toEqual(['pm_a']);
  });
});

it('refuses a move to Free for a team already on Free', async () => {
  const { service } = setup({ plan: 'free' });
  await expect(service.downgradeToFree('t1', 'u1')).rejects.toBeInstanceOf(BadRequestException);
});
