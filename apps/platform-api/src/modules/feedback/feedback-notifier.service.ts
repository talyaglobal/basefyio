import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeedbackStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import {
  FeedbackChange,
  describeChange,
  mergeChange,
  pickAutoClose,
  shouldNotifyReporter,
} from './feedback-notify';

// A comment and a status change arrive as two calls seconds apart; wait this long to send one notice.
const COALESCE_MS = 20_000;

type Item = { id: string; userId: string; title: string };

@Injectable()
export class FeedbackNotifierService {
  private readonly logger = new Logger(FeedbackNotifierService.name);
  // shortcut: in-memory per replica, lost on restart; upgrade to a Redis claim if the API runs >1 replica
  private readonly pending = new Map<string, { item: Item; actorUserId: string; change: FeedbackChange; timer: NodeJS.Timeout }>();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly realtime: RealtimeEventsService,
    private readonly leader: CronLeaderService,
  ) {}

  /** Queue a notice for the reporter; never throws. */
  notify(item: Item, actorUserId: string, change: FeedbackChange): void {
    if (!shouldNotifyReporter(item.userId, actorUserId)) return;
    const prev = this.pending.get(item.id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => void this.flush(item.id), COALESCE_MS);
    timer.unref?.();
    this.pending.set(item.id, { item, actorUserId, change: mergeChange(prev?.change, change), timer });
  }

  private async flush(id: string): Promise<void> {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (p) await this.deliver(p.item, p.actorUserId, p.change);
  }

  private async deliver(item: Item, actorUserId: string | undefined, change: FeedbackChange): Promise<void> {
    const lines = describeChange(change);
    if (!lines.length) return;
    try {
      const reporter = await this.prisma.user.findUnique({ where: { id: item.userId }, select: { email: true } });
      if (reporter?.email) {
        await this.email.sendFeedbackUpdate(reporter.email, {
          feedbackId: item.id,
          title: item.title,
          lines,
          comment: change.comments?.join('\n\n'),
        });
      }
    } catch (err: any) {
      this.logger.error(`Feedback update mail failed for ${item.id}: ${err?.message ?? err}`);
    }
    try {
      await this.realtime.publish({
        entityType: 'feedback',
        action: 'reporter_notified',
        entityId: item.id,
        actorUserId,
        userIds: [item.userId],
        payload: { title: item.title, summary: lines.join(' '), actorName: change.actorName },
      });
      this.logger.log(`Reporter notified for feedback ${item.id}: ${lines.join(' ')}`);
    } catch (err: any) {
      this.logger.error(`Feedback update push failed for ${item.id}: ${err?.message ?? err}`);
    }
  }

  /** Hourly, leader only: close DONE items 3 days after done_at (legacy NULL done_at: silently). */
  @Cron(CronExpression.EVERY_HOUR)
  async autoClose(): Promise<void> {
    if (!this.leader.isLeader() || this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const done = await this.prisma.feedback.findMany({
        where: { status: FeedbackStatus.DONE },
        select: { id: true, userId: true, title: true, status: true, doneAt: true },
      });
      const { notify, silent } = pickAutoClose(done, now);
      const ids = [...notify, ...silent];
      if (!ids.length) return;
      await this.prisma.feedback.updateMany({
        where: { id: { in: ids }, status: FeedbackStatus.DONE },
        data: { status: FeedbackStatus.CLOSED, doneAt: null },
      });
      this.logger.log(`Auto-closed ${ids.length} DONE feedback items (${silent.length} legacy, silent)`);
      for (const f of done.filter((d) => notify.includes(d.id))) {
        await this.deliver(f, undefined, {
          actorName: 'basefyio',
          note: 'This item was closed automatically 3 days after it was marked done. Reply to reopen it.',
        });
      }
    } catch (err: any) {
      this.logger.error(`Feedback auto-close failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
