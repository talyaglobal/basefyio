import { Injectable, Logger } from '@nestjs/common';

export interface PayPalOrder {
  id: string;
  status: string;
  purchase_units?: Array<{ custom_id?: string; amount?: { currency_code?: string; value?: string } }>;
  links?: Array<{ rel: string; href: string }>;
}

/** PayPal Orders v2 over plain fetch: token, create, get, capture. Secrets and tokens are never logged. */
@Injectable()
export class PayPalService {
  private readonly logger = new Logger(PayPalService.name);
  private token: { value: string; expiresAt: number } | null = null;

  private get clientId() {
    return (process.env.PAYPAL_CLIENT_ID || '').trim();
  }
  private get clientSecret() {
    return (process.env.PAYPAL_CLIENT_SECRET || '').trim();
  }
  private get baseUrl() {
    return (process.env.PAYPAL_MODE || '').trim().toLowerCase() === 'sandbox'
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';
  }

  isEnabled(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  /** Cents to PayPal's decimal string, e.g. 1999 -> "19.99" (two-decimal currencies only). */
  static formatAmount(cents: number): string {
    return (cents / 100).toFixed(2);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'basefyio-platform-api',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal token request failed (${res.status})`);
    const json: any = await res.json();
    // Renew a minute early so a token never expires mid-request.
    this.token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) - 60) * 1000 };
    return json.access_token;
  }

  private async call(path: string, method: 'GET' | 'POST', requestId?: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'basefyio-platform-api',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`PayPal ${method} ${path} failed (${res.status}): ${detail.slice(0, 300)}`);
      throw new Error(`PayPal request failed (${res.status})`);
    }
    return res.json();
  }

  async createOrder(p: {
    invoiceId: string;
    amountCents: number;
    currency: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ orderId: string; approvalUrl: string }> {
    const order: PayPalOrder = await this.call('/v2/checkout/orders', 'POST', `${p.invoiceId}-${Date.now()}`, {
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: p.invoiceId,
          description: 'basefyio invoice',
          amount: { currency_code: p.currency.toUpperCase(), value: PayPalService.formatAmount(p.amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: p.returnUrl,
            cancel_url: p.cancelUrl,
            user_action: 'PAY_NOW',
          },
        },
      },
    });
    const link = order.links?.find((l) => l.rel === 'payer-action') ?? order.links?.find((l) => l.rel === 'approve');
    if (!link) throw new Error('PayPal returned no approval link');
    return { orderId: order.id, approvalUrl: link.href };
  }

  getOrder(orderId: string): Promise<PayPalOrder> {
    return this.call(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, 'GET');
  }

  /** The order id doubles as the request id, so a repeated capture cannot charge twice. */
  captureOrder(orderId: string): Promise<PayPalOrder> {
    return this.call(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, 'POST', `capture-${orderId}`, {});
  }
}
