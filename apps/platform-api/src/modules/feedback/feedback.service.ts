import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { StorageService } from '../storage/storage.service';
import { FeedbackStatus, FeedbackType, UserRole } from '@prisma/client';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

export interface FeedbackAttachmentRef {
  url: string;
  mimeType: string;
  kind: 'image' | 'video';
}

interface CreateFeedbackDto {
  userId: string;
  email: string;
  url: string;
  title: string;
  description?: string;
  type?: FeedbackType;
  attachments?: FeedbackAttachmentRef[];
}

interface UpdateFeedbackDto {
  title?: string;
  description?: string;
}

const NOTIFY_EMAILS = [
  'fatih@talyasmart.com',
  'batuhan@talyasmart.com',
];

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly storageService: StorageService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  private async recipientUserIdsForFeedback(feedbackOwnerId: string) {
    const roots = await this.prisma.user.findMany({
      where: { role: UserRole.ROOT, id: { not: feedbackOwnerId } },
      select: { id: true },
    });
    return [feedbackOwnerId, ...roots.map((r) => r.id)];
  }

  /**
   * Look up "First Last" (or email fallback) for a user id. Embedded in
   * Realtime payloads so the subscriber can attribute the event without a
   * follow-up HTTP round-trip — that round-trip is what the legacy polling
   * loop in notifications-context.tsx used to do via /feedback/:id/history.
   * Returns null if the user can't be resolved; the subscriber falls back to
   * "Someone" in that case.
   */
  private async resolveActorName(userId: string | undefined): Promise<string | null> {
    if (!userId) return null;
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    if (!u) return null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return name || u.email || null;
  }

  async uploadAttachment(userId: string, buffer: Buffer, mimetype: string) {
    return this.storageService.uploadFeedbackAttachment(
      userId,
      buffer,
      mimetype,
    );
  }

  private async appendEvent(params: {
    feedbackId: string;
    userId: string;
    action: string;
    detail?: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    await this.prisma.feedbackEvent.create({
      data: {
        feedbackId: params.feedbackId,
        userId: params.userId,
        action: params.action,
        detail: params.detail,
        metadata: params.metadata,
      },
    });
  }

  async create(dto: CreateFeedbackDto) {
    const attachmentsJson: Prisma.InputJsonValue | undefined =
      dto.attachments && dto.attachments.length > 0
        ? (dto.attachments as unknown as Prisma.InputJsonValue)
        : undefined;

    const feedback = await this.prisma.feedback.create({
      data: {
        userId: dto.userId,
        email: dto.email,
        url: dto.url,
        title: dto.title,
        description: dto.description || null,
        type: dto.type || FeedbackType.GENERAL,
        attachments: attachmentsJson,
      },
    });
    await this.appendEvent({
      feedbackId: feedback.id,
      userId: dto.userId,
      action: 'FEEDBACK_CREATED',
      detail: dto.title,
    });

    // Resolve sender identity from the DB record rather than trusting the
    // JWT to carry `email`. Some Keycloak realm configs omit the email claim
    // from the access token, which previously produced "FROM ()" in the
    // notification email and empty actor info in the Realtime payload.
    const senderRecord = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: { firstName: true, lastName: true, email: true },
    });
    const senderEmail = senderRecord?.email || dto.email || '';
    const senderName =
      [senderRecord?.firstName, senderRecord?.lastName].filter(Boolean).join(' ').trim() ||
      (senderEmail ? senderEmail.split('@')[0] : 'Anonymous');

    this.logger.log(
      `Feedback created: "${dto.title}" by ${senderEmail || dto.userId} (${feedback.id})`,
    );

    // Notify all ROOT admins via Realtime — they're the ones who triage new
    // feedback, and waiting for an email round-trip means the bell stays
    // silent until the next inbox refresh. Recipients exclude the creator
    // (own-action skip happens at the subscriber too, but we may as well
    // not waste their bandwidth).
    const roots = await this.prisma.user.findMany({
      where: { role: UserRole.ROOT, id: { not: dto.userId } },
      select: { id: true },
    });
    await this.realtime.publish({
      entityType: 'feedback',
      action: 'created',
      entityId: feedback.id,
      actorUserId: dto.userId,
      userIds: roots.map((r) => r.id),
      payload: {
        title: feedback.title,
        type: feedback.type,
        actorName: senderName,
        actorEmail: senderEmail || null,
      },
    });

    for (const to of NOTIFY_EMAILS) {
      this.emailService.sendFeedbackNotification(to, {
        displayName: senderName,
        email: senderEmail,
        url: dto.url,
        title: dto.title,
        description: dto.description,
        type: feedback.type,
        attachments: dto.attachments,
        createdAt: feedback.createdAt.toLocaleString('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }),
      }).catch((err) => {
        this.logger.error(`Failed to send feedback email to ${to}: ${err.message}`);
      });
    }

    return feedback;
  }

  async findAll(includeDeleted = false) {
    return this.prisma.feedback.findMany({
      where: includeDeleted ? {} : { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { email: true } } },
        },
      },
    });
  }

  private async getUserRole(userId: string): Promise<UserRole | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    return user?.role ?? null;
  }

  private async assertCanAccessFeedback(userId: string, feedbackId: string) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
    });
    if (!feedback) throw new NotFoundException('Feedback not found');
    const role = await this.getUserRole(userId);
    const isRoot = role === UserRole.ROOT;
    const isOwner = feedback.userId === userId;
    if (feedback.deletedAt && !isRoot) {
      throw new NotFoundException('Feedback not found');
    }
    if (!isRoot && !isOwner) {
      throw new ForbiddenException('You can only access your own feedback');
    }
    return { feedback, isRoot, isOwner };
  }

  async findAllForUser(userId: string) {
    const role = await this.getUserRole(userId);
    if (role === UserRole.ROOT) {
      return this.findAll(true);
    }
    return this.prisma.feedback.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { email: true } } },
        },
      },
    });
  }

  async updateStatus(userId: string, id: string, status: FeedbackStatus) {
    const { isRoot, feedback } = await this.assertCanAccessFeedback(userId, id);
    if (!isRoot) {
      const canMarkDone = status === FeedbackStatus.DONE;
      const canCloseAfterDone =
        status === FeedbackStatus.CLOSED && feedback.status === FeedbackStatus.DONE;
      if (!canMarkDone && !canCloseAfterDone) {
        throw new ForbiddenException(
          'You can only mark your own feedback as done, then close it',
        );
      }
    }

    const updated = await this.prisma.feedback.update({
      where: { id },
      data: { status },
    });
    await this.appendEvent({
      feedbackId: id,
      userId,
      action: 'STATUS_CHANGED',
      detail: `${feedback.status} -> ${status}`,
      metadata: { from: feedback.status, to: status } as unknown as Prisma.InputJsonValue,
    });
    const recipients = await this.recipientUserIdsForFeedback(feedback.userId);
    const actorName = await this.resolveActorName(userId);
    await this.realtime.publish({
      entityType: 'feedback',
      action: 'status_changed',
      entityId: id,
      actorUserId: userId,
      userIds: recipients,
      payload: {
        title: updated.title,
        from: feedback.status,
        to: status,
        actorName,
      },
    });
    return updated;
  }

  async updateFeedback(userId: string, id: string, dto: UpdateFeedbackDto) {
    const { feedback } = await this.assertCanAccessFeedback(userId, id);
    const updated = await this.prisma.feedback.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description || null } : {}),
      },
    });
    await this.appendEvent({
      feedbackId: id,
      userId,
      action: 'FEEDBACK_EDITED',
      detail: 'Feedback content updated',
      metadata: {
        titleChanged: dto.title !== undefined && dto.title !== feedback.title,
        descriptionChanged: dto.description !== undefined && dto.description !== (feedback.description || ''),
      } as unknown as Prisma.InputJsonValue,
    });
    const recipients = await this.recipientUserIdsForFeedback(feedback.userId);
    const actorName = await this.resolveActorName(userId);
    await this.realtime.publish({
      entityType: 'feedback',
      action: 'updated',
      entityId: id,
      actorUserId: userId,
      userIds: recipients,
      payload: {
        title: updated.title,
        actorName,
        titleChanged: dto.title !== undefined && dto.title !== feedback.title,
        descriptionChanged:
          dto.description !== undefined && dto.description !== (feedback.description || ''),
      },
    });
    return updated;
  }

  async removeFeedback(userId: string, id: string) {
    const { feedback } = await this.assertCanAccessFeedback(userId, id);
    await this.prisma.feedback.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: FeedbackStatus.CLOSED,
      },
    });
    await this.appendEvent({
      feedbackId: id,
      userId,
      action: 'FEEDBACK_DELETED',
      detail: 'Feedback deleted',
    });
    const recipients = await this.recipientUserIdsForFeedback(feedback.userId);
    const actorName = await this.resolveActorName(userId);
    await this.realtime.publish({
      entityType: 'feedback',
      action: 'deleted',
      entityId: id,
      actorUserId: userId,
      userIds: recipients,
      payload: {
        title: feedback.title,
        actorName,
      },
    });
    return { success: true };
  }

  async listComments(userId: string, feedbackId: string) {
    await this.assertCanAccessFeedback(userId, feedbackId);
    return this.prisma.feedbackComment.findMany({
      where: { feedbackId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { email: true } } },
    });
  }

  async addComment(
    userId: string,
    feedbackId: string,
    dto: { comment: string; attachments?: FeedbackAttachmentRef[]; parentCommentId?: string },
  ) {
    const { isRoot, isOwner, feedback } = await this.assertCanAccessFeedback(userId, feedbackId);
    if (!isRoot && !isOwner) {
      throw new ForbiddenException('You are not allowed to comment on this feedback');
    }

    if (dto.parentCommentId) {
      const parent = await this.prisma.feedbackComment.findUnique({
        where: { id: dto.parentCommentId },
        select: { id: true, feedbackId: true },
      });
      if (!parent || parent.feedbackId !== feedbackId) {
        throw new NotFoundException('Reply target comment not found');
      }
    }

    const attachmentsJson: Prisma.InputJsonValue | undefined =
      dto.attachments && dto.attachments.length > 0
        ? (dto.attachments as unknown as Prisma.InputJsonValue)
        : undefined;

    const created = await this.prisma.feedbackComment.create({
      data: {
        feedbackId,
        userId,
        comment: dto.comment,
        attachments: attachmentsJson,
        parentCommentId: dto.parentCommentId || null,
      },
      include: { user: { select: { email: true } } },
    });
    await this.appendEvent({
      feedbackId,
      userId,
      action: dto.parentCommentId ? 'COMMENT_REPLIED' : 'COMMENT_ADDED',
      detail: dto.comment.slice(0, 120),
      metadata: dto.parentCommentId
        ? ({ parentCommentId: dto.parentCommentId } as unknown as Prisma.InputJsonValue)
        : undefined,
    });
    const recipients = await this.recipientUserIdsForFeedback(feedback.userId);
    const actorName = await this.resolveActorName(userId);
    await this.realtime.publish({
      entityType: 'feedback_comment',
      action: 'comment_added',
      entityId: created.id,
      actorUserId: userId,
      userIds: recipients,
      payload: {
        feedbackId,
        feedbackTitle: feedback.title,
        parentCommentId: dto.parentCommentId ?? null,
        actorName,
        commentPreview: dto.comment.slice(0, 200),
      },
    });
    return created;
  }

  async listHistory(userId: string, feedbackId: string) {
    await this.assertCanAccessFeedback(userId, feedbackId);
    return this.prisma.feedbackEvent.findMany({
      where: { feedbackId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
  }
}
