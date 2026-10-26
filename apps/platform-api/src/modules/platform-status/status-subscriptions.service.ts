import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { baseLayout } from '../email/templates/base.template';
import type { IncidentView } from './platform-status.types';

/**
 * "Subscribe to updates" on the status page. A subscription is pending until
 * the address clicks the confirmation link, so nobody can sign up somebody
 * else; every mail carries an unsubscribe link. Mail goes out when an
 * incident opens, gets an update or resolves — automatic or written by hand.
 */
export type IncidentMailEvent = 'opened' | 'updated' | 'resolved';

const PER_ADDRESS_PER_HOUR = 3;
const GLOBAL_PER_HOUR = 200;
const SEND_CONCURRENCY = 20;

const STATUS_WORD: Record<IncidentView['status'], string> = {
  INVESTIGATING: 'Investigating',
  IDENTIFIED: 'Identified',
  MONITORING: 'Monitoring',
  RESOLVED: 'Resolved',
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function normalizeEmail(raw: unknown): string | null {
  const email = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (email.length < 6 || email.length > 320) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

function domain(): string {
  const direct = (process.env.PLATFORM_DOMAIN || process.env.DOMAIN || '').trim();
  if (direct) return direct;
  try {
    return new URL((process.env.APP_URL || '').trim()).host.replace(/^app\./, '');
  } catch {
    return 'basefyio.com';
  }
}

@Injectable()
export class StatusSubscriptionsService {
  private readonly logger = new Logger(StatusSubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
  ) {}

  statusPageUrl(): string {
    return `https://status.${domain()}/`;
  }

  private apiUrl(path: string): string {
    return `https://api.${domain()}/api/platform-status/subscriptions/${path}`;
  }

  /** Ask for mail. Sends (or re-sends) the confirmation; a confirmed address just hears that it already is. */
  async subscribe(rawEmail: unknown): Promise<{ state: 'pending' | 'already' }> {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new BadRequestException('Enter a valid e-mail address');
    await this.throttle(email);

    const existing = await this.prisma.platformStatusSubscriber.findUnique({ where: { email } });
    if (existing?.confirmedAt && !existing.unsubscribedAt) return { state: 'already' };

    const token = randomBytes(24).toString('hex');
    await this.prisma.platformStatusSubscriber.upsert({
      where: { email },
      create: { email, token },
      update: { token, unsubscribedAt: null },
    });
    const confirmUrl = this.apiUrl(`confirm?token=${token}`);
    const html = baseLayout(
      `<div class="body"><h1 class="greeting">Confirm your status updates</h1>` +
        `<p class="text">You asked to hear about incidents on the basefyio status page. Confirm this address to start receiving them.</p>` +
        `<p class="text"><a href="${confirmUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Confirm subscription</a></p>` +
        `<p class="text" style="color:#64748b;font-size:13px">If you did not ask for this, ignore this mail: nothing is sent without the confirmation.</p></div>`,
    );
    await this.email.sendRawHtml(email, 'Confirm your basefyio status updates', html);
    this.logger.log(`Status subscription requested: ${email}`);
    return { state: 'pending' };
  }

  async confirm(token: string | undefined): Promise<boolean> {
    const row = token ? await this.prisma.platformStatusSubscriber.findUnique({ where: { token } }) : null;
    if (!row) return false;
    await this.prisma.platformStatusSubscriber.update({
      where: { id: row.id },
      data: { confirmedAt: row.confirmedAt ?? new Date(), unsubscribedAt: null },
    });
    this.logger.log(`Status subscription confirmed: ${row.email}`);
    return true;
  }

  async unsubscribe(token: string | undefined): Promise<boolean> {
    const row = token ? await this.prisma.platformStatusSubscriber.findUnique({ where: { token } }) : null;
    if (!row) return false;
    await this.prisma.platformStatusSubscriber.update({ where: { id: row.id }, data: { unsubscribedAt: new Date() } });
    this.logger.log(`Status subscription ended: ${row.email}`);
    return true;
  }

  async counts(): Promise<{ confirmed: number; pending: number }> {
    const [confirmed, pending] = await Promise.all([
      this.prisma.platformStatusSubscriber.count({ where: { confirmedAt: { not: null }, unsubscribedAt: null } }),
      this.prisma.platformStatusSubscriber.count({ where: { confirmedAt: null, unsubscribedAt: null } }),
    ]);
    return { confirmed, pending };
  }

  /**
   * Mail every confirmed subscriber about an incident event. Never throws:
   * a mail problem must not stop the incident itself from being recorded.
   */
  async notifyIncident(incident: IncidentView, event: IncidentMailEvent, componentLabels: Record<string, string>): Promise<number> {
    try {
      const subscribers = await this.prisma.platformStatusSubscriber.findMany({
        where: { confirmedAt: { not: null }, unsubscribedAt: null },
        select: { id: true, email: true, token: true },
      });
      if (subscribers.length === 0) return 0;

      const latest = incident.updates[incident.updates.length - 1];
      const word = incident.excludedFromSlo ? 'Maintenance' : STATUS_WORD[incident.status];
      const headline = event === 'opened' ? 'New incident' : event === 'resolved' ? 'Resolved' : 'Update';
      const components = incident.components.map((c) => componentLabels[c] ?? c).join(', ');
      const subject = `[basefyio status] ${headline}: ${incident.title}`;
      const started = new Date(incident.startedAt).toUTCString();
      const resolved = incident.resolvedAt ? new Date(incident.resolvedAt).toUTCString() : null;
      const impact = incident.impact !== 'NONE' && !incident.excludedFromSlo ? ` · impact ${incident.impact.toLowerCase()}` : '';
      const bodyFor = (token: string) => {
        const unsubscribe = this.apiUrl(`unsubscribe?token=${token}`);
        return baseLayout(
          `<div class="body"><h1 class="greeting">${escapeHtml(headline)}: ${escapeHtml(incident.title)}</h1>` +
            `<p class="text"><strong>${escapeHtml(word)}</strong>${escapeHtml(impact)}${components ? ` · ${escapeHtml(components)}` : ''}</p>` +
            (latest?.text ? `<p class="text">${escapeHtml(latest.text)}</p>` : '') +
            `<p class="text" style="color:#64748b;font-size:13px">Started ${escapeHtml(started)}${resolved ? ` · resolved ${escapeHtml(resolved)}` : ''}</p>` +
            `<p class="text"><a href="${this.statusPageUrl()}">Open the status page</a></p>` +
            `<p class="text" style="color:#94a3b8;font-size:12px">You receive this because you subscribed on the status page. ` +
            `<a href="${unsubscribe}">Unsubscribe</a></p></div>`,
        );
      };

      let sent = 0;
      for (let i = 0; i < subscribers.length; i += SEND_CONCURRENCY) {
        const batch = subscribers.slice(i, i + SEND_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((s) => this.email.sendRawHtml(s.email, subject, bodyFor(s.token))));
        sent += results.filter((r) => r.status === 'fulfilled').length;
      }
      await this.prisma.platformStatusSubscriber
        .updateMany({ where: { id: { in: subscribers.map((s) => s.id) } }, data: { lastNotifiedAt: new Date() } })
        .catch(() => {});
      this.logger.log(`Incident ${incident.id} ${event}: mailed ${sent}/${subscribers.length} subscribers`);
      return sent;
    } catch (err: any) {
      this.logger.warn(`Could not mail status subscribers: ${err?.message ?? err}`);
      return 0;
    }
  }

  /** A few requests per address and a global ceiling per hour: the form is public. */
  private async throttle(email: string): Promise<void> {
    const client = this.redis.getClient();
    try {
      const [own, all] = await Promise.all([client.incr(`pstatus:sub:${email}`), client.incr('pstatus:sub:all')]);
      if (own === 1) await client.expire(`pstatus:sub:${email}`, 3600);
      if (all === 1) await client.expire('pstatus:sub:all', 3600);
      if (own > PER_ADDRESS_PER_HOUR || all > GLOBAL_PER_HOUR) {
        throw new HttpException(
          { statusCode: 429, code: 'rate_limited', message: 'Too many requests; try again later' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      /* Redis unavailable: let the request through rather than refuse everyone */
    }
  }
}
