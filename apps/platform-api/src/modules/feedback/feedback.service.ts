import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { FeedbackStatus, FeedbackType } from '@prisma/client';

interface CreateFeedbackDto {
  userId: string;
  username: string;
  email: string;
  url: string;
  title: string;
  description?: string;
  type?: FeedbackType;
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
  ) {}

  async create(dto: CreateFeedbackDto) {
    const feedback = await this.prisma.feedback.create({
      data: {
        userId: dto.userId,
        username: dto.username,
        email: dto.email,
        url: dto.url,
        title: dto.title,
        description: dto.description || null,
        type: dto.type || FeedbackType.GENERAL,
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
