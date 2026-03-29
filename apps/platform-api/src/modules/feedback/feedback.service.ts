import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { StorageService } from '../storage/storage.service';
import { FeedbackStatus, FeedbackType } from '@prisma/client';

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

  async findAll() {
    return this.prisma.feedback.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: FeedbackStatus) {
    const existing = await this.prisma.feedback.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Feedback not found');

    return this.prisma.feedback.update({
      where: { id },
      data: { status },
    });
  }
}
