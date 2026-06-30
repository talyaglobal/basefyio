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
  /** Fire-and-forget: record a paid invoice as a QuickBooks Sales Receipt + log it. */
  async recordSale(invoiceId: string): Promise<void> {
    const conn = await this.prisma.quickbooksConnection.findUnique({ where: { id: ROW_ID } });
    if (!conn || !conn.autoCreate) return;

    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { teamId: true, amountPaid: true, currency: true },
    });
    if (!inv || inv.amountPaid <= 0) return;

    try {
      const res = await this.createSalesReceiptForInvoice(invoiceId);
      await this.prisma.quickbooksSyncLog.create({
        data: {
          invoiceId,
          teamId: inv.teamId,
          salesReceiptId: res?.id ?? null,
          amountCents: inv.amountPaid,
          currency: inv.currency,
          customerName: res?.customerName ?? null,
          status: 'success',
          intuitTid: res?.tid ?? null,
        },
      });
    } catch (err: any) {
      const tid = err?.response?.headers?.['intuit_tid'];
      const status = err?.response?.status;
      const body = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
      this.logger.error(
        `QuickBooks sales receipt failed for invoice ${invoiceId}` +
          (status ? ` (HTTP ${status})` : '') +
          (tid ? ` [intuit_tid=${tid}]` : '') +
          `: ${body}`,
      );
      await this.prisma.quickbooksSyncLog
        .create({
          data: {
            invoiceId,
            teamId: inv.teamId,
            amountCents: inv.amountPaid,
            currency: inv.currency,
            status: 'failed',
            error: String(body).slice(0, 1000),
            intuitTid: tid ?? null,
          },
        })
        .catch(() => {});
    }
  }

  async createSalesReceiptForInvoice(
    invoiceId: string,
  ): Promise<{ id: string; tid?: string; customerName?: string } | null> {
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
    return id ? { id, tid, customerName: displayName } : null;
  }

  private salesReceiptUrl(id: string): string {
    const base = this.environment() === 'sandbox' ? 'https://app.sandbox.qbo.intuit.com' : 'https://app.qbo.intuit.com';
    return `${base}/app/salesreceipt?txnId=${id}`;
  }

  /**
   * Reconcile local sync log against QuickBooks: any receipt we recorded as
   * 'success' that no longer exists in QuickBooks (e.g. the user deleted it) is
   * marked 'deleted' so the dashboard stays in sync automatically.
   */
  private async reconcileDeletions(tok: { accessToken: string; realmId: string }): Promise<void> {
    const candidates = await this.prisma.quickbooksSyncLog.findMany({
      where: { status: 'success', salesReceiptId: { not: null } },
      select: { id: true, salesReceiptId: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    if (!candidates.length) return;

    const ids = candidates.map((c) => c.salesReceiptId!).filter(Boolean);
    const existing = new Set<string>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const q = await this.qbQuery(
        tok,
        `SELECT Id FROM SalesReceipt WHERE Id IN (${chunk.map((x) => `'${x}'`).join(',')})`,
      );
      for (const r of q.SalesReceipt ?? []) existing.add(String(r.Id));
    }

    const goneIds = candidates.filter((c) => !existing.has(String(c.salesReceiptId))).map((c) => c.id);
    if (goneIds.length) {
      await this.prisma.quickbooksSyncLog.updateMany({ where: { id: { in: goneIds } }, data: { status: 'deleted' } });
      this.logger.log(`QuickBooks reconcile: ${goneIds.length} receipt(s) deleted in QB -> marked deleted locally`);
    }
  }

  /** Full dashboard: local sync summary/log + live QuickBooks company & recent Sales Receipts. */
  async getDashboard(limit = 25) {
    const conn = await this.prisma.quickbooksConnection.findUnique({ where: { id: ROW_ID } });
    if (!conn) return { connected: false, configured: this.isConfigured() };

    let tok: { accessToken: string; realmId: string } | null = null;
    try {
      tok = await this.getValidToken();
    } catch {
      tok = null;
    }

    // Auto-sync deletions before computing counts (best-effort).
    if (tok) {
      try {
        await this.reconcileDeletions(tok);
      } catch {
        /* token/API hiccup — skip, never mark deleted on uncertainty */
      }
    }

    const [success, failed, deleted, recentLog, agg] = await Promise.all([
      this.prisma.quickbooksSyncLog.count({ where: { status: 'success' } }),
      this.prisma.quickbooksSyncLog.count({ where: { status: 'failed' } }),
      this.prisma.quickbooksSyncLog.count({ where: { status: 'deleted' } }),
      this.prisma.quickbooksSyncLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.quickbooksSyncLog.aggregate({ where: { status: 'success' }, _sum: { amountCents: true } }),
    ]);

    let live: any = { available: false };
    if (tok) {
      try {
        const companyQ = await this.qbQuery(tok, 'SELECT * FROM CompanyInfo');
        const ci = companyQ.CompanyInfo?.[0];
        const receiptsQ = await this.qbQuery(
          tok,
          `SELECT * FROM SalesReceipt ORDERBY TxnDate DESC MAXRESULTS ${Math.min(limit, 50)}`,
        );
        const list = (receiptsQ.SalesReceipt ?? []).map((r: any) => ({
          id: r.Id,
          docNumber: r.DocNumber ?? null,
          total: Number(r.TotalAmt) || 0,
          currency: r.CurrencyRef?.value ?? null,
          customer: r.CustomerRef?.name ?? null,
          txnDate: r.TxnDate ?? null,
          privateNote: r.PrivateNote ?? null,
          url: this.salesReceiptUrl(r.Id),
        }));
        live = {
          available: true,
          company: ci
            ? { name: ci.CompanyName, legalName: ci.LegalName, country: ci.Country, email: ci.Email?.Address ?? null }
            : null,
          salesReceiptCount: list.length,
          salesReceiptTotal: list.reduce((s: number, r: any) => s + r.total, 0),
          salesReceipts: list,
        };
      } catch (err: any) {
        live = { available: false, error: err?.response?.data ? JSON.stringify(err.response.data) : err.message };
      }
    }

    return {
      connected: true,
      configured: true,
      companyName: conn.companyName,
      realmId: conn.realmId,
      environment: conn.environment,
      autoCreate: conn.autoCreate,
      connectedAt: conn.connectedAt,
      summary: {
        totalSynced: success,
        success,
        failed,
        deleted,
        totalAmountCents: agg._sum.amountCents ?? 0,
        lastSyncAt: recentLog[0]?.createdAt ?? null,
      },
      recentSyncs: recentLog.map((l) => ({
        id: l.id,
        invoiceId: l.invoiceId,
        salesReceiptId: l.salesReceiptId,
        amountCents: l.amountCents,
        currency: l.currency,
        customerName: l.customerName,
        status: l.status,
        error: l.error,
        createdAt: l.createdAt,
        url: l.salesReceiptId ? this.salesReceiptUrl(l.salesReceiptId) : null,
      })),
      live,
    };
  }

  /** Create a clearly-marked $1 TEST Sales Receipt to verify the connection on screen. */
  async createTestSalesReceipt() {
    const tok = await this.getValidToken();
    if (!tok) throw new BadRequestException('QuickBooks is not connected');
    const customerId = await this.ensureCustomer(tok, 'basefyio Test Customer', 'test@basefyio.com');
    const itemId = await this.ensureServiceItem(tok);
    const resp = await axios.post(
      `${this.apiBase()}/v3/company/${tok.realmId}/salesreceipt?minorversion=${MINOR_VERSION}`,
      {
        CustomerRef: { value: customerId },
        Line: [
          {
            Amount: 1.0,
            DetailType: 'SalesItemLineDetail',
            Description: 'basefyio connection test — safe to delete',
            SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: 1, UnitPrice: 1.0 },
          },
        ],
        PrivateNote: 'TEST — basefyio QuickBooks connection verification. Safe to delete.',
        CurrencyRef: { value: 'USD' },
      },
      { headers: { Authorization: `Bearer ${tok.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' } },
    );
    const id = resp.data?.SalesReceipt?.Id;
    await this.prisma.quickbooksSyncLog.create({
      data: {
        invoiceId: 'TEST',
        salesReceiptId: id ?? null,
        amountCents: 100,
        currency: 'usd',
        customerName: 'basefyio Test Customer',
        status: 'success',
        intuitTid: resp.headers?.['intuit_tid'] ?? null,
      },
    });
    this.logger.log(`QuickBooks TEST SalesReceipt ${id} created`);
    return { id, docNumber: resp.data?.SalesReceipt?.DocNumber ?? null, url: id ? this.salesReceiptUrl(id) : null, amount: 1.0 };
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
