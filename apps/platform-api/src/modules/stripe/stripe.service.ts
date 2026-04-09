import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private stripe!: Stripe;
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const secretKey = this.config.get<string>('stripe.secretKey');
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2025-02-24.acacia' });
      this.enabled = true;
      this.logger.log('Stripe client initialized');
    } else {
      this.logger.warn('Stripe secret key not configured — billing features disabled');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY to enable billing.');
    }
  }

  async getOrCreateCustomer(opts: {
    teamId: string;
    teamName: string;
    email: string;
    existingCustomerId?: string | null;
  }): Promise<Stripe.Customer> {
    this.assertEnabled();

    if (opts.existingCustomerId) {
      try {
        const customer = await this.stripe.customers.retrieve(opts.existingCustomerId);
        if (!customer.deleted) return customer as Stripe.Customer;
      } catch {
        // Customer deleted or not found, create a new one
      }
    }

    const customer = await this.stripe.customers.create({
      name: opts.teamName,
      email: opts.email,
      metadata: { teamId: opts.teamId },
    });

    this.logger.log(`Stripe customer created: ${customer.id} for team ${opts.teamId}`);
    return customer;
  }

  async createProduct(name: string, description?: string): Promise<Stripe.Product> {
    this.assertEnabled();
    return this.stripe.products.create({
      name,
      description: description || undefined,
    });
  }

  async createPrice(opts: {
    productId: string;
    unitAmount: number;
    currency?: string;
    interval?: 'month' | 'year';
  }): Promise<Stripe.Price> {
    this.assertEnabled();
    return this.stripe.prices.create({
      product: opts.productId,
      unit_amount: opts.unitAmount,
      currency: opts.currency || 'usd',
      recurring: { interval: opts.interval || 'month' },
    });
  }

  async updateCustomer(customerId: string, data: {
    name?: string;
    email?: string;
    phone?: string;
    address?: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    };
    metadata?: Record<string, string>;
    tax_id?: string;
  }): Promise<Stripe.Customer> {
    this.assertEnabled();
    const updateData: Stripe.CustomerUpdateParams = {};
    if (data.name) updateData.name = data.name;
    if (data.email) updateData.email = data.email;
    if (data.phone) updateData.phone = data.phone;
    if (data.address) updateData.address = data.address;
    if (data.metadata) updateData.metadata = data.metadata;
    return this.stripe.customers.update(customerId, updateData) as Promise<Stripe.Customer>;
  }

  async addCustomerTaxId(customerId: string, type: string, value: string): Promise<Stripe.TaxId> {
    this.assertEnabled();
    return this.stripe.customers.createTaxId(customerId, {
      type: type as Stripe.TaxIdCreateParams.Type,
      value,
    });
  }

  async getDefaultPaymentMethod(customerId: string): Promise<Stripe.PaymentMethod | null> {
    this.assertEnabled();
    const customer = await this.stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    }) as Stripe.Customer;
    const pm = customer.invoice_settings?.default_payment_method;
    if (typeof pm === 'string') {
      return this.stripe.paymentMethods.retrieve(pm);
    }
    return (pm as Stripe.PaymentMethod) || null;
  }

  /** Create a SetupIntent for collecting card details */
  async createSetupIntent(customerId: string): Promise<Stripe.SetupIntent> {
    this.assertEnabled();
    return this.stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });
  }

  /** Attach a payment method to customer and set as default */
  async attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    this.assertEnabled();
    await this.stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  /** Detach a payment method */
  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    this.assertEnabled();
    await this.stripe.paymentMethods.detach(paymentMethodId);
  }

  /** List payment methods for a customer */
  async listPaymentMethods(customerId: string): Promise<Stripe.PaymentMethod[]> {
    this.assertEnabled();
    const result = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });
    return result.data;
  }

  async createCheckoutSession(opts: {
    customerId: string;
    priceId: string;
    teamId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<Stripe.Checkout.Session> {
    this.assertEnabled();

    const session = await this.stripe.checkout.sessions.create({
      customer: opts.customerId,
      mode: 'subscription',
      payment_method_collection: 'always',
      line_items: [{ price: opts.priceId, quantity: 1 }],
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      metadata: { teamId: opts.teamId },
      subscription_data: {
        metadata: { teamId: opts.teamId },
      },
    });

    this.logger.log(`Checkout session created: ${session.id} for team ${opts.teamId}`);
    return session;
  }

  async createPortalSession(opts: {
    customerId: string;
    returnUrl: string;
  }): Promise<Stripe.BillingPortal.Session> {
    this.assertEnabled();

    return this.stripe.billingPortal.sessions.create({
      customer: opts.customerId,
      return_url: opts.returnUrl,
    });
  }

  async getSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    this.assertEnabled();
    return this.stripe.subscriptions.retrieve(subscriptionId);
  }

  async cancelSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    this.assertEnabled();
    return this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async resumeSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    this.assertEnabled();
    return this.stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });
  }

  async changeSubscriptionPlan(
    subscriptionId: string,
    newPriceId: string,
  ): Promise<Stripe.Subscription> {
    this.assertEnabled();

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) throw new Error('No subscription item found');

    return this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, price: newPriceId }],
      proration_behavior: 'none',
    });
  }

  async previewPlanChangeProration(
    subscriptionId: string,
    newPriceId: string,
  ): Promise<Stripe.UpcomingInvoice> {
    this.assertEnabled();

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const itemId = subscription.items.data[0]?.id;
    if (!itemId) throw new Error('No subscription item found');

    return this.stripe.invoices.retrieveUpcoming({
      customer: subscription.customer as string,
      subscription: subscriptionId,
      subscription_items: [{ id: itemId, price: newPriceId }],
      subscription_proration_behavior: 'create_prorations',
    } as Stripe.InvoiceRetrieveUpcomingParams);
  }

  async listInvoices(customerId: string, limit = 20): Promise<Stripe.Invoice[]> {
    this.assertEnabled();
    const result = await this.stripe.invoices.list({
      customer: customerId,
      limit,
    });
    return result.data;
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    this.assertEnabled();
    const webhookSecret = this.config.get<string>('stripe.webhookSecret');
    if (!webhookSecret) {
      throw new Error('Stripe webhook secret not configured');
    }
    return this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  }

  getClient(): Stripe {
    this.assertEnabled();
    return this.stripe;
  }
}
