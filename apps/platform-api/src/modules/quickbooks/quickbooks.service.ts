import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const SCOPE = 'com.intuit.quickbooks.accounting';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const MINOR_VERSION = '70';
const STATE_PREFIX = 'qb_oauth_state';
const ROW_ID = 'singleton';

@Injectable()
export class QuickbooksService {
  private readonly logger = new Logger(QuickbooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  // ── config ────────────────────────────────────────────────
  private clientId() { return this.config.get<string>('quickbooks.clientId') || process.env.QUICKBOOKS_CLIENT_ID || ''; }
  private clientSecret() { return this.config.get<string>('quickbooks.clientSecret') || process.env.QUICKBOOKS_CLIENT_SECRET || ''; }
  private redirectUri() { return this.config.get<string>('quickbooks.redirectUri') || process.env.QUICKBOOKS_REDIRECT_URI || ''; }
  private environment() { return (process.env.QUICKBOOKS_ENVIRONMENT || 'production').toLowerCase(); }
  private apiBase() {
    return this.environment() === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';
  }
  isConfigured(): boolean {
    return !!(this.clientId() && this.clientSecret() && this.redirectUri());
  }

  // ── token encryption (AES-256-GCM) ────────────────────────
  private key(): Buffer {
    const secret =
      process.env.QB_ENCRYPTION_KEY ||
      this.config.get<string>('keycloak.adminPassword') ||
      process.env.KEYCLOAK_ADMIN_PASSWORD ||
      'basefyio-quickbooks-default-key';
    return crypto.scryptSync(secret, 'basefyio.quickbooks.v1', 32);
  }
  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }
  private decrypt(blob: string): string {
    const [ivB, tagB, dataB] = blob.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  }

  // ── OAuth ─────────────────────────────────────────────────
  async getAuthorizeUrl(userId?: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'QuickBooks is not configured. Set QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET and QUICKBOOKS_REDIRECT_URI.',
      );
    }
    const state = crypto.randomBytes(24).toString('hex');
    await this.redis.set(`${STATE_PREFIX}:${state}`, userId || '1', 600);
    const params = new URLSearchParams({
      client_id: this.clientId(),
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: this.redirectUri(),
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async handleCallback(code: string, realmId: string, state: string): Promise<void> {
    const stored = await this.redis.get(`${STATE_PREFIX}:${state}`);
    if (!stored) throw new BadRequestException('Invalid or expired OAuth state');
    await this.redis.del(`${STATE_PREFIX}:${state}`);
    const connectedByUserId = stored !== '1' ? stored : null;

    const basic = Buffer.from(`${this.clientId()}:${this.clientSecret()}`).toString('base64');
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(),
      }).toString(),
      { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
    );

    const now = Date.now();
    const companyName = await this.fetchCompanyName(realmId, data.access_token).catch(() => null);

    await this.prisma.quickbooksConnection.upsert({
      where: { id: ROW_ID },
      create: {
        id: ROW_ID,
        realmId,
        accessToken: this.encrypt(data.access_token),
        refreshToken: this.encrypt(data.refresh_token),
        expiresAt: new Date(now + (data.expires_in ?? 3600) * 1000),
        refreshExpiresAt: data.x_refresh_token_expires_in ? new Date(now + data.x_refresh_token_expires_in * 1000) : null,
        companyName,
        environment: this.environment(),
        connectedByUserId,
      },
      update: {
        realmId,
        accessToken: this.encrypt(data.access_token),
        refreshToken: this.encrypt(data.refresh_token),
        expiresAt: new Date(now + (data.expires_in ?? 3600) * 1000),
        refreshExpiresAt: data.x_refresh_token_expires_in ? new Date(now + data.x_refresh_token_expires_in * 1000) : null,
        companyName,
        environment: this.environment(),
        connectedByUserId,
      },
    });
    this.logger.log(`QuickBooks connected: realm ${realmId} (${companyName || 'company'})`);
  }

  /** Return a valid access token + realmId, refreshing if needed. */
  private async getValidToken(): Promise<{ accessToken: string; realmId: string } | null> {
    const conn = await this.prisma.quickbooksConnection.findUnique({ where: { id: ROW_ID } });
    if (!conn) return null;

    if (conn.expiresAt.getTime() > Date.now() + 60_000) {
      return { accessToken: this.decrypt(conn.accessToken), realmId: conn.realmId };
    }

    // Refresh
    const basic = Buffer.from(`${this.clientId()}:${this.clientSecret()}`).toString('base64');
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.decrypt(conn.refreshToken) }).toString(),
      { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } },
    );
    const now = Date.now();
    await this.prisma.quickbooksConnection.update({
      where: { id: ROW_ID },
      data: {
        accessToken: this.encrypt(data.access_token),
        refreshToken: this.encrypt(data.refresh_token),
        expiresAt: new Date(now + (data.expires_in ?? 3600) * 1000),
        refreshExpiresAt: data.x_refresh_token_expires_in ? new Date(now + data.x_refresh_token_expires_in * 1000) : conn.refreshExpiresAt,
      },
    });
    return { accessToken: data.access_token, realmId: conn.realmId };
  }

  private async fetchCompanyName(realmId: string, accessToken: string): Promise<string | null> {
    const { data } = await axios.get(
      `${this.apiBase()}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=${MINOR_VERSION}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );
    return data?.CompanyInfo?.CompanyName ?? null;
  }

  // ── status / settings / disconnect ────────────────────────
  async getStatus() {
    const conn = await this.prisma.quickbooksConnection.findUnique({ where: { id: ROW_ID } });
    return {
      configured: this.isConfigured(),
      connected: !!conn,
      companyName: conn?.companyName ?? null,
      realmId: conn?.realmId ?? null,
      environment: conn?.environment ?? this.environment(),
      autoCreate: conn?.autoCreate ?? true,
      connectedAt: conn?.connectedAt ?? null,
      redirectUri: this.redirectUri() || null,
    };
  }

  async setAutoCreate(autoCreate: boolean) {
    await this.prisma.quickbooksConnection.update({ where: { id: ROW_ID }, data: { autoCreate } }).catch(() => {});
    return { autoCreate };
  }

  async disconnect() {
    const conn = await this.prisma.quickbooksConnection.findUnique({ where: { id: ROW_ID } });
    if (conn) {
      try {
        const basic = Buffer.from(`${this.clientId()}:${this.clientSecret()}`).toString('base64');
        await axios.post(
          REVOKE_URL,
          { token: this.decrypt(conn.refreshToken) },
          { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' } },
        );
      } catch (err: any) {
        this.logger.warn(`QuickBooks token revoke failed: ${err.message}`);
      }
      await this.prisma.quickbooksConnection.delete({ where: { id: ROW_ID } });
    }
    return { connected: false };
  }

  // ── sales receipt on each sale ────────────────────────────
  /** Fire-and-forget: record a paid invoice as a QuickBooks Sales Receipt. */
  async recordSale(invoiceId: string): Promise<void> {
    try {
      const conn = await this.prisma.quickbooksConnection.findUnique({ where: { id: ROW_ID } });
      if (!conn || !conn.autoCreate) return;
      await this.createSalesReceiptForInvoice(invoiceId);
    } catch (err: any) {
      // Log full error detail + Intuit's transaction id (intuit_tid) for support.
      const tid = err?.response?.headers?.['intuit_tid'];
      const status = err?.response?.status;
      const body = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
      this.logger.error(
        `QuickBooks sales receipt failed for invoice ${invoiceId}` +
          (status ? ` (HTTP ${status})` : '') +
          (tid ? ` [intuit_tid=${tid}]` : '') +
          `: ${body}`,
      );
    }
  }

  async createSalesReceiptForInvoice(invoiceId: string): Promise<{ id: string } | null> {
    const tok = await this.getValidToken();
    if (!tok) return null;

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { team: true, lineItems: true },
    });
    if (!invoice || invoice.amountPaid <= 0) return null;

    const account = await this.prisma.billingAccount.findUnique({ where: { teamId: invoice.teamId } });
    const sub = await this.prisma.subscription.findUnique({ where: { teamId: invoice.teamId }, include: { plan: true } });

    const email = account?.billingEmail || undefined;
    const displayName = account?.companyName || invoice.team?.name || `Team ${invoice.teamId.slice(0, 8)}`;
    const customerId = await this.ensureCustomer(tok, displayName, email);
    const itemId = await this.ensureServiceItem(tok);

    const amount = invoice.amountPaid / 100;
    const desc = invoice.lineItems?.length
      ? invoice.lineItems.map((li) => li.description).join('; ')
      : `basefyio ${sub?.plan?.displayName || 'subscription'}` +
        (invoice.periodStart && invoice.periodEnd
          ? ` (${invoice.periodStart.toISOString().slice(0, 10)} – ${invoice.periodEnd.toISOString().slice(0, 10)})`
          : '');

    const payload: Record<string, unknown> = {
      CustomerRef: { value: customerId },
      Line: [
        {
          Amount: amount,
          DetailType: 'SalesItemLineDetail',
          Description: desc,
          SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: amount },
        },
      ],
      ...(email ? { BillEmail: { Address: email } } : {}),
      PrivateNote: `basefyio invoice ${invoice.stripeInvoiceId || invoice.id}`,
      TxnDate: invoice.createdAt.toISOString().slice(0, 10),
      CurrencyRef: { value: (invoice.currency || 'usd').toUpperCase() },
    };

    const resp = await axios.post(
      `${this.apiBase()}/v3/company/${tok.realmId}/salesreceipt?minorversion=${MINOR_VERSION}`,
      payload,
      { headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
    const id = resp.data?.SalesReceipt?.Id;
    // Capture Intuit's transaction id (intuit_tid) — required for support triage.
    const tid = resp.headers?.['intuit_tid'];
    this.logger.log(
      `QuickBooks SalesReceipt ${id} created for invoice ${invoice.id} ($${amount})` +
        (tid ? ` [intuit_tid=${tid}]` : ''),
    );
    return id ? { id } : null;
  }

  private async qbQuery(tok: { accessToken: string; realmId: string }, query: string): Promise<any> {
    const { data } = await axios.get(
      `${this.apiBase()}/v3/company/${tok.realmId}/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`,
      { headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: 'application/json' } },
    );
    return data?.QueryResponse ?? {};
  }

  private async ensureCustomer(tok: { accessToken: string; realmId: string }, displayName: string, email?: string): Promise<string> {
    // Prefer match by email, then by display name.
    if (email) {
      const r = await this.qbQuery(tok, `SELECT Id FROM Customer WHERE PrimaryEmailAddr = '${email.replace(/'/g, "\\'")}'`);
      if (r.Customer?.[0]?.Id) return r.Customer[0].Id;
    }
    const safeName = displayName.replace(/'/g, "\\'");
    const byName = await this.qbQuery(tok, `SELECT Id FROM Customer WHERE DisplayName = '${safeName}'`);
    if (byName.Customer?.[0]?.Id) return byName.Customer[0].Id;

    const { data } = await axios.post(
      `${this.apiBase()}/v3/company/${tok.realmId}/customer?minorversion=${MINOR_VERSION}`,
      { DisplayName: displayName, ...(email ? { PrimaryEmailAddr: { Address: email } } : {}) },
      { headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
    return data.Customer.Id;
  }

  private async ensureServiceItem(tok: { accessToken: string; realmId: string }): Promise<string> {
    const existing = await this.qbQuery(tok, `SELECT Id FROM Item WHERE Name = 'basefyio subscription'`);
    if (existing.Item?.[0]?.Id) return existing.Item[0].Id;

    // Need an income account to create a Service item.
    const acct = await this.qbQuery(tok, `SELECT Id FROM Account WHERE AccountType = 'Income' MAXRESULTS 1`);
    const incomeAccountId = acct.Account?.[0]?.Id;
    const { data } = await axios.post(
      `${this.apiBase()}/v3/company/${tok.realmId}/item?minorversion=${MINOR_VERSION}`,
      {
        Name: 'basefyio subscription',
        Type: 'Service',
        ...(incomeAccountId ? { IncomeAccountRef: { value: incomeAccountId } } : {}),
      },
      { headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
    return data.Item.Id;
  }
}
