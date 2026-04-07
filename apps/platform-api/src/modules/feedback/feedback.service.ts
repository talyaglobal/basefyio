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

export interface FeedbackAttachmentRef {
  url: string;
  mimeType: string;
  kind: 'image' | 'video';
}

interface CreateFeedbackDto {
  userId: string;
  username: string;
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
  ) {}

  async uploadAttachment(userId: string, buffer: Buffer, mimetype: string) {
    return this.storageService.uploadFeedbackAttachment(
      userId,
      buffer,
      mimetype,
    );
  }

  async create(dto: CreateFeedbackDto) {
    const attachmentsJson: Prisma.InputJsonValue | undefined =
      dto.attachments && dto.attachments.length > 0
        ? (dto.attachments as unknown as Prisma.InputJsonValue)
        : undefined;

    const feedback = await this.prisma.feedback.create({
      data: {
        userId: dto.userId,
        username: dto.username,
        email: dto.email,
        url: dto.url,
        title: dto.title,
        description: dto.description || null,
        type: dto.type || FeedbackType.GENERAL,
        attachments: attachmentsJson,
      },
    });

    this.logger.log(`Feedback created: "${dto.title}" by ${dto.username} (${feedback.id})`);

    for (const to of NOTIFY_EMAILS) {
      this.emailService.sendFeedbackNotification(to, {
        username: dto.username,
        email: dto.email,
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
      include: { comments: { orderBy: { createdAt: 'asc' } } },
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
      include: { comments: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async updateStatus(userId: string, id: string, status: FeedbackStatus) {
    const { isRoot } = await this.assertCanAccessFeedback(userId, id);
    if (!isRoot && status !== FeedbackStatus.DONE) {
      throw new ForbiddenException('You can only mark your own feedback as done');
    }

    return this.prisma.feedback.update({
      where: { id },
      data: { status },
    });
  }

  async updateFeedback(userId: string, id: string, dto: UpdateFeedbackDto) {
    await this.assertCanAccessFeedback(userId, id);
    return this.prisma.feedback.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description || null } : {}),
      },
    });
  }

  async removeFeedback(userId: string, id: string) {
    await this.assertCanAccessFeedback(userId, id);
    await this.prisma.feedback.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  async listComments(userId: string, feedbackId: string) {
    await this.assertCanAccessFeedback(userId, feedbackId);
    return this.prisma.feedbackComment.findMany({
      where: { feedbackId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addComment(
    userId: string,
    username: string,
    feedbackId: string,
    dto: { comment: string; attachments?: FeedbackAttachmentRef[]; parentCommentId?: string },
  ) {
    const { isRoot, isOwner } = await this.assertCanAccessFeedback(userId, feedbackId);
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

    return this.prisma.feedbackComment.create({
      data: {
        feedbackId,
        userId,
        username,
        comment: dto.comment,
        attachments: attachmentsJson,
        parentCommentId: dto.parentCommentId || null,
      },
    });
  }
}
